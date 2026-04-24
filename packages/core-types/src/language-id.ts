/**
 * Canonical language identifier used across the parse, providers, and
 * pipeline subsystems. This file is the single source of truth; the
 * identical unions that previously lived in `ingestion/src/parse/types.ts`
 * and `ingestion/src/providers/types.ts` re-export from here.
 *
 * The member set is driven by the language providers actually registered
 * in `@opencodehub/ingestion/src/providers/registry.ts` — adding a new
 * member here is meaningful only once a paired provider lands in that
 * table (the `satisfies Record<LanguageId, LanguageProvider>` check
 * guarantees 1:1 coverage at compile time).
 */
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
