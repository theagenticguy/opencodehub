// Clean-room language-provider types for OpenCodeHub ingestion.
//
// The `LanguageId` union is duplicated in `../parse/types.ts`; keep both
// copies structurally identical.
// TODO: reconcile the duplicated LanguageId union into a shared neutral location.

import type { ParseCapture } from "../parse/types.js";
import type {
  ExtractedCall,
  ExtractedDefinition,
  ExtractedHeritage,
  ExtractedImport,
  PropertyAccess,
} from "./extraction-types.js";

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "c"
  | "cpp"
  | "ruby"
  | "kotlin"
  | "swift"
  | "php"
  | "dart";

/**
 * Strategy used to linearize a class's method resolution order.
 *  - `c3`: Python / Dylan — full C3 linearization, raises on ambiguity.
 *  - `first-wins`: TypeScript / JavaScript / Rust — left-to-right source order.
 *  - `single-inheritance`: Java / C# / Kotlin — single `extends` chain.
 *  - `none`: Go and similar — no traditional inheritance walk.
 */
export type MroStrategyName = "c3" | "first-wins" | "single-inheritance" | "none";

/**
 * Shape of how the language expresses module-to-module imports.
 *  - `named`:            `import { foo } from "bar";` (TS/JS/Java/C#/Rust).
 *  - `namespace`:        `import mod` / `from mod import x` (Python).
 *  - `package-wildcard`: `import "fmt"` pulls the whole package symbol set (Go).
 */
export type ImportSemantics = "named" | "namespace" | "package-wildcard";

export interface TypeExtractionConfig {
  /** Structural typing (TS interfaces, Python duck typing). */
  readonly structural: boolean;
  /** Nominal typing (Java / C# / Rust / Go). */
  readonly nominal: boolean;
  /** Language has generics / parametric polymorphism. */
  readonly generics: boolean;
}

/** Inputs to {@link LanguageProvider.extractDefinitions}. */
export interface ExtractDefinitionsInput {
  readonly filePath: string;
  readonly captures: readonly ParseCapture[];
  readonly sourceText: string;
}

/** Inputs to {@link LanguageProvider.extractCalls}. */
export interface ExtractCallsInput {
  readonly filePath: string;
  readonly captures: readonly ParseCapture[];
  readonly definitions: readonly ExtractedDefinition[];
}

/** Inputs to {@link LanguageProvider.extractImports}. */
export interface ExtractImportsInput {
  readonly filePath: string;
  readonly sourceText: string;
}

/** Inputs to {@link LanguageProvider.extractHeritage}. */
export interface ExtractHeritageInput {
  readonly filePath: string;
  readonly captures: readonly ParseCapture[];
  readonly definitions: readonly ExtractedDefinition[];
}

/**
 * An outbound HTTP call site detected statically from source.
 *
 * `urlTemplate` preserves the literal URL or template (e.g. `"/users/:id"`,
 * `"https://api.example.com/users/{id}"`). Downstream phases normalize path
 * templates so `{id}` and `:id` hash to the same route target.
 */
export interface HttpCall {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE";
  readonly urlTemplate: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Client library: `fetch`, `axios`, `requests`, `httpx`, `restTemplate`, `okhttp`, etc. */
  readonly clientLibrary: string;
}

/** Inputs to {@link LanguageProvider.detectOutboundHttp}. */
export interface DetectOutboundHttpInput {
  readonly filePath: string;
  readonly captures: readonly ParseCapture[];
  readonly sourceText: string;
}

/**
 * Inputs to {@link LanguageProvider.extractPropertyAccesses}. Per-file bundle
 * feeding the ACCESSES-edge walker. `definitions` are the extract output of
 * this same file so the walker can attach every access to an enclosing
 * symbol by (startLine <= line <= endLine) containment.
 */
export interface ExtractionContext {
  readonly filePath: string;
  readonly captures: readonly ParseCapture[];
  readonly sourceText: string;
  readonly definitions: readonly ExtractedDefinition[];
}

export interface LanguageProvider {
  readonly id: LanguageId;
  readonly extensions: readonly string[];
  readonly importSemantics: ImportSemantics;
  readonly mroStrategy: MroStrategyName;
  readonly typeConfig: TypeExtractionConfig;
  /**
   * Edge label used to express the type-hierarchy relation. Go has neither
   * extends nor implements, so it is `null`.
   */
  readonly heritageEdge: "EXTENDS" | "IMPLEMENTS" | null;
  /** Strip `.js` suffix for TS, resolve `__init__.py`, etc. */
  readonly preprocessImportPath?: (raw: string) => string;
  /** Is this identifier exported from its declaration site? */
  readonly isExportedIdentifier?: (name: string, context: "top-level" | "class-member") => boolean;
  /** Name used for the implicit receiver inside a method body. */
  readonly inferImplicitReceiver?: (callerKind: string) => "self" | "this" | undefined;

  /**
   * Optional opt-in for an alternative reference-resolution backend. Unset
   * providers use the three-tier walker (`"three-tier-default"`). Known
   * values map to the registry in `resolution/resolver-strategy.ts`:
   *   - `"stack-graphs"` — clean-room stack-graphs evaluator (Python only).
   * Unknown values silently fall back to the default.
   */
  readonly resolverStrategyName?: string;

  /**
   * Tree-sitter node-type names that start a new function/method/constructor
   * body for complexity counting. The complexity phase dispatches on these;
   * providers without a table are silently skipped by the phase.
   */
  readonly complexityDefinitionKinds?: readonly string[];

  /**
   * Tree-sitter node-type names that count as Halstead operators. Every other
   * leaf/identifier in the body counts as an operand. Omission disables the
   * Halstead-volume computation for that language (phase emits complexity
   * only).
   */
  readonly halsteadOperatorKinds?: readonly string[];

  // ---- Behavioral hooks ---------------------------------------------------

  /**
   * Given unified parse captures for a file, emit one record per symbol
   * defined in the file. Qualified names encode nesting (e.g. `Foo.bar`).
   */
  extractDefinitions(input: ExtractDefinitionsInput): readonly ExtractedDefinition[];

  /**
   * Emit one record per call site. Downstream phases apply 3-tier + MRO
   * resolution; this hook only identifies the callee name plus any
   * inferrable receiver (`this` / `self` / typed prefix).
   */
  extractCalls(input: ExtractCallsInput): readonly ExtractedCall[];

  /**
   * Parse import statements from source text. Regex-based rather than AST-
   * based because the captures we have today are symbol-oriented; imports
   * add very little parse-cost on top at MVP.
   */
  extractImports(input: ExtractImportsInput): readonly ExtractedImport[];

  /**
   * Predicate companion to {@link ExtractedDefinition.isExported} — useful
   * when downstream phases want to re-check a bare definition record.
   */
  isExported(def: ExtractedDefinition): boolean;

  /**
   * Emit inheritance, trait-impl, and interface-implements edges.
   */
  extractHeritage(input: ExtractHeritageInput): readonly ExtractedHeritage[];

  /**
   * Detect outbound HTTP call sites: `fetch("/api/users")`,
   * `axios.post(url, body)`, `requests.get(url)`, `restTemplate.getForObject(url)`, etc.
   *
   * Optional: providers that do not implement this hook are treated as
   * "no outbound HTTP detection" silently. Return an empty array for
   * languages / client libraries the provider does not recognise.
   */
  detectOutboundHttp?(input: DetectOutboundHttpInput): readonly HttpCall[];

  /**
   * Emit one {@link PropertyAccess} record per `receiver.property` read or
   * write observed inside a function/method body. Providers that do not
   * implement this hook emit no ACCESSES edges. Returned records must be
   * sorted by `(enclosingSymbolId, propertyName, startLine)` for
   * downstream determinism.
   */
  extractPropertyAccesses?(input: ExtractionContext): readonly PropertyAccess[];
}
