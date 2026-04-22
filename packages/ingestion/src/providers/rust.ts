import type { NodeKind } from "@opencodehub/core-types";
import {
  getLine,
  innermostEnclosingDef,
  isInside,
  pairDefinitionsWithNames,
  stripComments,
} from "./extract-helpers.js";
import type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
} from "./extraction-types.js";
import type {
  ExtractCallsInput,
  ExtractDefinitionsInput,
  ExtractHeritageInput,
  ExtractImportsInput,
  LanguageProvider,
} from "./types.js";

/**
 * Rust provider.
 *
 * Heritage in Rust is expressed via `impl Trait for Type` blocks. Our
 * unified query emits `reference.implementation` for `impl_item` nodes;
 * we detect the `for Type` half via regex on the impl header line.
 *
 * Exports: `pub`, `pub(crate)`, `pub(super)`, `pub(in path)`. Anything
 * without a `pub*` marker is crate-private (not exported).
 */

const RUST_DEF_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  "definition.class": "Struct",
  "definition.interface": "Trait",
  "definition.function": "Function",
  "definition.constant": "Const",
  "definition.macro": "Macro",
  "definition.module": "Module",
  "definition.type": "TypeAlias",
};

function extractRustDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[] {
  const { filePath, captures, sourceText } = input;
  const paired = pairDefinitionsWithNames(captures);
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const implRefs = captures.filter((c) => c.tag === "reference.implementation");
  const out: ExtractedDefinition[] = [];

  for (const { def, name } of paired) {
    const kind = RUST_DEF_KIND_MAP[def.tag];
    if (kind === undefined) continue;

    // Owner inference: methods live inside `impl` blocks. We detect the
    // enclosing impl via capture range containment against `@reference
    // .implementation` captures, then read the target type name off the
    // impl header.
    let owner: string | undefined;
    let finalKind: NodeKind = kind;

    if (def.tag === "definition.function") {
      const enclosingImpl = findEnclosingImpl(def, implRefs);
      if (enclosingImpl !== undefined) {
        owner = readImplTargetType(enclosingImpl.text);
        finalKind = "Method";
      } else {
        const ownerDef = innermostEnclosingDef(def, defCaptures);
        if (ownerDef !== undefined) {
          const ownerPaired = paired.find((p) => p.def === ownerDef);
          if (ownerPaired !== undefined) owner = ownerPaired.name.text;
        }
      }
    }

    const qualifiedName = owner !== undefined ? `${owner}.${name.text}` : name.text;
    const headerLine = getLine(sourceText, def.startLine);
    const isExported = /\bpub\b/.test(headerLine);

    const rec: ExtractedDefinition = {
      kind: finalKind,
      name: name.text,
      qualifiedName,
      filePath,
      startLine: def.startLine,
      endLine: def.endLine,
      isExported,
      ...(owner !== undefined ? { owner } : {}),
    };
    out.push(rec);
  }
  return out;
}

/**
 * Read the target type of an `impl` block from its source text.
 *   `impl Foo { ... }`              -> `Foo`
 *   `impl Trait for Foo { ... }`    -> `Foo`
 *   `impl<T> Trait<T> for Foo<T>`   -> `Foo`
 */
function readImplTargetType(implSource: string): string | undefined {
  const firstLine = implSource.split("\n", 1)[0] as string;
  // `for X` if present — otherwise the identifier right after `impl [<T>]`.
  const forMatch = /\bfor\s+([A-Za-z_][\w]*)/.exec(firstLine);
  if (forMatch !== null) return forMatch[1];
  const plainMatch = /^\s*impl\s*(?:<[^>]*>\s*)?([A-Za-z_][\w]*)/.exec(firstLine);
  return plainMatch?.[1];
}

function findEnclosingImpl(
  fn: import("../parse/types.js").ParseCapture,
  impls: readonly import("../parse/types.js").ParseCapture[],
): import("../parse/types.js").ParseCapture | undefined {
  let best: import("../parse/types.js").ParseCapture | undefined;
  for (const impl of impls) {
    if (!isInside(fn, impl)) continue;
    if (best === undefined || impl.startLine > best.startLine) best = impl;
  }
  return best;
}

function extractRustCalls(input: ExtractCallsInput): readonly ExtractedCall[] {
  const { filePath, captures, definitions } = input;
  const defCaptures = captures.filter((c) => c.tag.startsWith("definition."));
  const callRefs = captures.filter((c) => c.tag === "reference.call");
  const out: ExtractedCall[] = [];

  for (const ref of callRefs) {
    const innerName = findNameInside(captures, ref);
    const calleeName = innerName?.text ?? ref.text;

    const enclosingDef = innermostEnclosingDef(ref, defCaptures);
    const callerQualifiedName = enclosingDef
      ? qualifiedForCapture(enclosingDef, definitions)
      : "<module>";

    // Receiver inference for Rust: `self.method()`, `Struct::method()`,
    // `path::to::fn()`. We look at the source slice before the callee name.
    let receiver: string | undefined;
    if (innerName !== undefined) {
      const text = ref.text;
      // Prefer `::` scoping, fall back to `.` field access.
      const nameWithSep = [`::${innerName.text}`, `.${innerName.text}`];
      for (const sep of nameWithSep) {
        const idx = text.lastIndexOf(sep);
        if (idx > 0) {
          const prefix = text.slice(0, idx).trim();
          if (prefix !== "") {
            receiver = prefix;
            break;
          }
        }
      }
    }

    out.push({
      callerQualifiedName,
      calleeName,
      filePath,
      startLine: ref.startLine,
      ...(receiver !== undefined ? { calleeOwner: receiver } : {}),
    });
  }
  return out;
}

function findNameInside(
  captures: readonly import("../parse/types.js").ParseCapture[],
  outer: import("../parse/types.js").ParseCapture,
): import("../parse/types.js").ParseCapture | undefined {
  let best: import("../parse/types.js").ParseCapture | undefined;
  for (const c of captures) {
    if (c.tag !== "name") continue;
    if (!isInside(c, outer)) continue;
    if (best === undefined || c.startLine < best.startLine) best = c;
  }
  return best;
}

function qualifiedForCapture(
  def: import("../parse/types.js").ParseCapture,
  definitions: readonly ExtractedDefinition[],
): string {
  for (const d of definitions) {
    if (d.startLine === def.startLine) return d.qualifiedName;
  }
  return "<module>";
}

/**
 * Parse Rust `use` statements. Covers:
 *   `use path::to::thing;`                  (named / namespace)
 *   `use path::to::thing as alias;`         (aliased)
 *   `use path::{a, b as c, d::*};`          (multi)
 *   `pub use path::*;`                      (re-export, still recorded)
 *   `use path::*;`                          (glob)
 */
function extractRustImports(input: ExtractImportsInput): readonly ExtractedImport[] {
  const { filePath, sourceText } = input;
  const stripped = stripComments(sourceText);
  const out: ExtractedImport[] = [];
  const useRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm;

  for (const m of stripped.matchAll(useRe)) {
    const body = (m[1] as string).trim();

    // Multi-import: `path::{...}` — extract the group.
    const group = /^(.*?)::\{([\s\S]*?)\}$/.exec(body);
    if (group !== null) {
      const prefix = (group[1] as string).trim();
      const parts = (group[2] as string)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const names: string[] = [];
      let wildcard = false;
      for (const p of parts) {
        if (p === "*") {
          wildcard = true;
          continue;
        }
        const aliasMatch = /^([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?$/.exec(p);
        if (aliasMatch !== null) {
          names.push((aliasMatch[2] as string | undefined) ?? (aliasMatch[1] as string));
        }
      }
      if (wildcard) {
        out.push({ filePath, source: prefix, kind: "package-wildcard", isWildcard: true });
      }
      if (names.length > 0) {
        out.push({ filePath, source: prefix, kind: "named", importedNames: names });
      }
      continue;
    }

    // Glob: `path::*`
    if (body.endsWith("::*")) {
      const source = body.slice(0, -3);
      out.push({ filePath, source, kind: "package-wildcard", isWildcard: true });
      continue;
    }

    // Named with `as` alias: `path::thing as alias`
    const asMatch = /^(.+?)\s+as\s+([A-Za-z_][\w]*)$/.exec(body);
    if (asMatch !== null) {
      const full = asMatch[1] as string;
      const alias = asMatch[2] as string;
      const parts = full.split("::");
      const last = parts[parts.length - 1] as string;
      const source = parts.slice(0, -1).join("::");
      out.push({
        filePath,
        source,
        kind: "named",
        importedNames: [last],
        localAlias: alias,
      });
      continue;
    }

    // Plain: `path::thing`
    const parts = body.split("::");
    if (parts.length >= 2) {
      const last = parts[parts.length - 1] as string;
      const source = parts.slice(0, -1).join("::");
      out.push({ filePath, source, kind: "named", importedNames: [last] });
    } else {
      // `use foo;` — bare module reference.
      out.push({ filePath, source: body, kind: "namespace" });
    }
  }
  return out;
}

function extractRustHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[] {
  const { filePath, captures, definitions } = input;
  const implCaps = captures.filter((c) => c.tag === "reference.implementation");
  const out: ExtractedHeritage[] = [];

  // Each `impl Trait for Type` block emits a `@reference.implementation`
  // capture on the target type (the `Type` side). The trait name is the
  // identifier that sits between `impl` and `for` on the header line.
  for (const impl of implCaps) {
    // Reconstruct the header from the capture's own text — the impl block's
    // first line starts with `impl ... for ...`.
    const firstLine = impl.text.split("\n", 1)[0] as string;
    const header = /^\s*impl\s*(?:<[^>]*>\s*)?([^\s{]+)\s+for\s+([^\s{<]+)/.exec(firstLine);
    if (header === null) continue;
    const traitName = (header[1] as string).replace(/<.*$/, "");
    const typeName = (header[2] as string).replace(/<.*$/, "");

    const child = definitions.find(
      (d) =>
        (d.kind === "Struct" ||
          d.kind === "Enum" ||
          d.kind === "Trait" ||
          d.kind === "TypeAlias") &&
        d.name === typeName,
    );
    const childQualifiedName = child?.qualifiedName ?? typeName;

    out.push({
      childQualifiedName,
      parentName: traitName,
      filePath,
      relation: "IMPLEMENTS",
      startLine: impl.startLine,
    });
  }
  return out;
}

export const rustProvider: LanguageProvider = {
  id: "rust",
  extensions: [".rs"],
  importSemantics: "named",
  mroStrategy: "first-wins",
  typeConfig: { structural: false, nominal: true, generics: true },
  heritageEdge: "IMPLEMENTS",
  isExportedIdentifier: (_name, _context) => true,

  extractDefinitions: extractRustDefinitions,
  extractCalls: extractRustCalls,
  extractImports: extractRustImports,
  isExported: (def) => def.isExported,
  extractHeritage: extractRustHeritage,
};
