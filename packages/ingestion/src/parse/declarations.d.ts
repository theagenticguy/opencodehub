/**
 * Ambient type declarations for grammar packages that do not ship their own
 * .d.ts files. We only care about the shape we consume (an opaque Language
 * object); `unknown` is deliberate.
 */

declare module "tree-sitter-c-sharp" {
  const language: unknown;
  export default language;
}

declare module "tree-sitter-javascript" {
  const language: unknown;
  export = language;
}

declare module "tree-sitter-python" {
  const language: unknown;
  export = language;
}

declare module "tree-sitter-go" {
  const language: unknown;
  export = language;
}

declare module "tree-sitter-rust" {
  const language: unknown;
  export = language;
}

declare module "tree-sitter-java" {
  const language: unknown;
  export = language;
}

declare module "tree-sitter-typescript" {
  export const typescript: unknown;
  export const tsx: unknown;
}
