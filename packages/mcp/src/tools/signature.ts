/**
 * `signature` — return a symbol's declaration header with bodies elided.
 *
 * Token-saving alternative to reading a whole file. For a class or interface,
 * emits the type declaration followed by every child method / property as a
 * stub: signature line + language-appropriate body placeholder (`;`, `{ }`,
 * or `pass` / `...` for Python). For a standalone function, emits a single
 * signature stub.
 *
 * Resolution mirrors `context`: `name` is required (or `uid` when the caller
 * already has a node id), with optional `filePath` / `kind` / `repo` for
 * disambiguation. A multi-candidate match returns the candidate list, not
 * one arbitrary pick (EC-04 behaviour from context.ts).
 *
 * SQL shape:
 *   - one `SELECT … FROM nodes WHERE name/id=?` to resolve the target,
 *   - one follow-up `SELECT … FROM relations JOIN nodes …` for
 *     HAS_METHOD + HAS_PROPERTY children when the target is a type.
 *
 * Signature text comes from `CallableShape.signature` when populated by the
 * parse / complexity phases; otherwise we reconstruct `name(p1,...,pN): T`
 * from `parameter_count` + `return_type`. Language detection keys off the
 * file extension alone — the node rows don't carry an explicit language tag.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import {
  fromToolResult,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

const SignatureInput = {
  name: z
    .string()
    .optional()
    .describe(
      "Symbol name to inspect (class, interface, function, method). Mutually exclusive with `uid`.",
    ),
  uid: z
    .string()
    .optional()
    .describe("Pre-resolved node id (skips name lookup). Mutually exclusive with `name`."),
  filePath: z
    .string()
    .optional()
    .describe("Optional file-path suffix to disambiguate same-named symbols."),
  kind: z
    .string()
    .optional()
    .describe("Optional NodeKind to disambiguate (e.g. 'Class' vs 'Function')."),
  repo: z.string().optional().describe("Registered repo name; defaults to the only indexed repo."),
};

interface NodeRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly signature?: string;
  readonly parameterCount?: number;
  readonly returnType?: string;
}

/** Kinds treated as aggregate "type declarations" with method / property children. */
const TYPE_KINDS = new Set<string>([
  "Class",
  "Interface",
  "Struct",
  "Trait",
  "Enum",
  "Record",
  "Union",
  "Impl",
  "Namespace",
  "Module",
  "Protocol",
]);

const CALLABLE_KINDS = new Set<string>(["Function", "Method", "Constructor"]);

const PROPERTY_KINDS = new Set<string>(["Property", "Const", "Static", "Variable", "Field"]);

type Language = "python" | "typescript" | "java" | "go" | "rust" | "csharp" | "ruby" | "other";

interface SignatureArgs {
  readonly name?: string | undefined;
  readonly uid?: string | undefined;
  readonly filePath?: string | undefined;
  readonly kind?: string | undefined;
  readonly repo?: string | undefined;
}

export async function runSignature(ctx: ToolContext, args: SignatureArgs): Promise<ToolResult> {
  const call = await withStore(ctx, args.repo, async (store, resolved) => {
    try {
      if (args.name === undefined && args.uid === undefined) {
        return withNextSteps(
          "signature requires either `name` or `uid`.",
          { target: null, candidates: [] },
          ["re-call `signature` with `name` or `uid`"],
          stalenessFromMeta(resolved.meta),
        );
      }

      const matches = await resolveMatches(store, args);
      if (matches.length === 0) {
        const probe = args.name ?? args.uid ?? "<unspecified>";
        return withNextSteps(
          `No symbol matched "${probe}" in ${resolved.name}.`,
          { target: null, candidates: [] },
          ["call `query` with a broader phrase to locate similar symbols"],
          stalenessFromMeta(resolved.meta),
        );
      }

      if (matches.length > 1) {
        const probe = args.name ?? args.uid ?? "<unspecified>";
        const list = matches
          .map((c, i) => `${i + 1}. [${c.kind}] ${c.filePath}  (${c.id})`)
          .join("\n");
        return withNextSteps(
          `"${probe}" is ambiguous (${matches.length} matches):\n${list}`,
          { target: null, candidates: matches },
          ["re-call `signature` with `kind` or `filePath` to pick a specific match"],
          stalenessFromMeta(resolved.meta),
        );
      }

      const target = matches[0];
      if (!target) {
        return withNextSteps(
          "No symbol matched.",
          { target: null, candidates: [] },
          ["call `query` with a broader phrase to locate similar symbols"],
          stalenessFromMeta(resolved.meta),
        );
      }

      const language = detectLanguage(target.filePath);
      let members: readonly NodeRow[] = [];
      if (TYPE_KINDS.has(target.kind)) {
        members = await fetchMembers(store, target.id);
      }

      const stub = renderStub(target, members, language);

      const next: string[] = [
        `call \`context\` with symbol="${target.name}" for callers / callees`,
      ];
      if (members.length > 0) {
        next.push(
          `class has ${members.length} members — use \`context\` on individual members for full signatures`,
        );
      }

      return withNextSteps(
        stub,
        {
          target,
          language,
          memberCount: members.length,
          members,
          stub,
        },
        next,
        stalenessFromMeta(resolved.meta),
      );
    } catch (err) {
      return toolErrorFromUnknown(err);
    }
  });
  return toToolResult(call);
}

export function registerSignatureTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "signature",
    {
      title: "Symbol declaration + stubbed members",
      description:
        "Return a class/interface declaration plus its method and property signatures with bodies elided (stub syntax per language). For a standalone function, returns a single signature. Saves tokens vs reading the whole file.",
      inputSchema: SignatureInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => fromToolResult(await runSignature(ctx, args)),
  );
}

async function resolveMatches(
  store: import("@opencodehub/storage").IGraphStore,
  args: {
    readonly name?: string | undefined;
    readonly uid?: string | undefined;
    readonly kind?: string | undefined;
    readonly filePath?: string | undefined;
  },
): Promise<NodeRow[]> {
  const params: (string | number)[] = [];
  let sql =
    "SELECT id, name, kind, file_path, start_line, end_line, signature, parameter_count, return_type FROM nodes WHERE ";
  if (args.uid !== undefined) {
    sql += "id = ?";
    params.push(args.uid);
  } else if (args.name !== undefined) {
    sql += "name = ?";
    params.push(args.name);
    if (args.kind !== undefined) {
      sql += " AND kind = ?";
      params.push(args.kind);
    }
    if (args.filePath !== undefined) {
      sql += " AND file_path LIKE ?";
      params.push(`%${args.filePath}%`);
    }
  }
  sql += " ORDER BY file_path LIMIT 25";
  const rows = (await store.query(sql, params)) as ReadonlyArray<Record<string, unknown>>;
  return rows.map(rowToNode);
}

async function fetchMembers(
  store: import("@opencodehub/storage").IGraphStore,
  ownerId: string,
): Promise<readonly NodeRow[]> {
  const rows = (await store.query(
    "SELECT n.id, n.name, n.kind, n.file_path, n.start_line, n.end_line, n.signature, n.parameter_count, n.return_type FROM relations r JOIN nodes n ON n.id = r.to_id WHERE r.from_id = ? AND r.type IN ('HAS_METHOD','HAS_PROPERTY') ORDER BY n.start_line, n.name LIMIT 500",
    [ownerId],
  )) as ReadonlyArray<Record<string, unknown>>;
  return rows.map(rowToNode);
}

function rowToNode(r: Record<string, unknown>): NodeRow {
  const out: {
    id: string;
    name: string;
    kind: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
    signature?: string;
    parameterCount?: number;
    returnType?: string;
  } = {
    id: String(r["id"]),
    name: String(r["name"]),
    kind: String(r["kind"]),
    filePath: String(r["file_path"]),
  };
  const sl = r["start_line"];
  if (typeof sl === "number" && Number.isFinite(sl)) out.startLine = sl;
  const el = r["end_line"];
  if (typeof el === "number" && Number.isFinite(el)) out.endLine = el;
  const sig = r["signature"];
  if (typeof sig === "string" && sig.length > 0) out.signature = sig;
  const pc = r["parameter_count"];
  if (typeof pc === "number" && Number.isFinite(pc)) out.parameterCount = pc;
  const rt = r["return_type"];
  if (typeof rt === "string" && rt.length > 0) out.returnType = rt;
  return out;
}

function detectLanguage(filePath: string): Language {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "typescript";
  }
  if (lower.endsWith(".java") || lower.endsWith(".kt") || lower.endsWith(".kts")) return "java";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".rb")) return "ruby";
  return "other";
}

/**
 * Render the target node and its children into a language-appropriate stub.
 *
 * For TypeScript/Java/C#: `class Foo { ... }` or `interface Foo { ... }` with
 * per-member `name(args): ReturnType;` lines. For Python: `class Foo:` with
 * indented `def name(...) -> ReturnType: ...` / `name: ReturnType` lines.
 * For Rust/Go we fall back to a language-agnostic text form — the phases
 * don't always populate `signature` in those languages.
 */
function renderStub(target: NodeRow, members: readonly NodeRow[], language: Language): string {
  if (!TYPE_KINDS.has(target.kind)) {
    return renderCallableOrDeclaration(target, language, 0);
  }

  if (language === "python") {
    const header = `class ${target.name}:`;
    if (members.length === 0) return `${header}\n    pass`;
    const lines = [header];
    for (const m of members) {
      lines.push(renderCallableOrDeclaration(m, language, 4));
    }
    return lines.join("\n");
  }

  // Default brace-style: TS / Java / C# / Rust / Go / other.
  const typeWord = typeKeyword(target.kind, language);
  const header = `${typeWord} ${target.name} {`;
  if (members.length === 0) return `${header}\n}`;
  const lines: string[] = [header];
  for (const m of members) {
    lines.push(renderCallableOrDeclaration(m, language, 2));
  }
  lines.push("}");
  return lines.join("\n");
}

function typeKeyword(kind: string, language: Language): string {
  if (kind === "Interface") return "interface";
  if (kind === "Struct") return language === "rust" || language === "go" ? "struct" : "class";
  if (kind === "Trait") return language === "rust" ? "trait" : "interface";
  if (kind === "Enum") return "enum";
  if (kind === "Record") return "record";
  if (kind === "Union") return "union";
  if (kind === "Impl") return "impl";
  if (kind === "Namespace") return "namespace";
  if (kind === "Module") return "module";
  return "class";
}

function renderCallableOrDeclaration(node: NodeRow, language: Language, indent: number): string {
  const pad = " ".repeat(indent);
  if (CALLABLE_KINDS.has(node.kind)) {
    const sig = callableSignature(node, language);
    if (language === "python") return `${pad}${sig}: ...`;
    // TS / Java / C# / Rust / Go: emit as a signature declaration.
    return `${pad}${sig};`;
  }
  if (PROPERTY_KINDS.has(node.kind)) {
    return `${pad}${propertyLine(node, language)};`;
  }
  // Unknown child kind — fall back to name only.
  return `${pad}${node.name};`;
}

/**
 * Prefer the parse-phase-populated `signature` column verbatim. Strip any
 * leading visibility keyword so classes don't end up with `public public foo`
 * in the stub; trailing body braces are stripped because we render the stub
 * body ourselves (`;` or `: ...`).
 */
function callableSignature(node: NodeRow, language: Language): string {
  if (node.signature !== undefined) {
    // Trim trailing body / block if present (e.g. `foo(): T { ... }`).
    const trimmed = node.signature.trim();
    const braceIdx = trimmed.indexOf("{");
    const core = braceIdx === -1 ? trimmed : trimmed.slice(0, braceIdx).trim();
    // Drop trailing semicolons so the renderer can add its own.
    return core.replace(/;$/, "").trim();
  }
  // Reconstruct from parameterCount + returnType.
  const argCount = node.parameterCount ?? 0;
  const argList = Array.from({ length: argCount }, (_, i) => `arg${i}`).join(", ");
  const ret = node.returnType ?? (language === "python" ? "None" : "void");
  if (language === "python") {
    return `def ${node.name}(${argList}) -> ${ret}`;
  }
  if (language === "go") {
    return `func ${node.name}(${argList}) ${ret}`;
  }
  if (language === "rust") {
    return `fn ${node.name}(${argList}) -> ${ret}`;
  }
  // TS / Java / C# fallback.
  return `${node.name}(${argList}): ${ret}`;
}

function propertyLine(node: NodeRow, language: Language): string {
  const ret = node.returnType;
  if (language === "python") {
    return ret !== undefined ? `${node.name}: ${ret}` : `${node.name} = ...`;
  }
  if (language === "go") {
    return ret !== undefined ? `${node.name} ${ret}` : node.name;
  }
  if (language === "rust") {
    return ret !== undefined ? `${node.name}: ${ret}` : node.name;
  }
  return ret !== undefined ? `${node.name}: ${ret}` : node.name;
}
