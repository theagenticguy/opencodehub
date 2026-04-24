/**
 * Canonical language identifier used across the parse, providers, and
 * pipeline subsystems. This file is the single source of truth; the
 * identical unions that previously lived in `ingestion/src/parse/types.ts`
 * and `ingestion/src/providers/types.ts` re-export from here.
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
