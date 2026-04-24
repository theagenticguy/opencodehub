/**
 * LSP-provenance reason prefixes shared between the ingestion confidence-demote
 * phase and the MCP confidence-breakdown helper.
 *
 * An edge is treated as "LSP-confirmed" when its `reason` starts with one of
 * these prefixes AND its confidence is at the LSP ceiling (1.0). Keeping the
 * list in one place guarantees that downstream aggregators and the demote
 * phase agree on which edges count as oracle-confirmed.
 *
 * Prefixes are matched with `string.startsWith(...)`; the trailing `@` segment
 * is typically followed by a version identifier (e.g. `pyright@1.1.390`).
 */
export const LSP_PROVENANCE_PREFIXES: readonly string[] = [
  "pyright@",
  "typescript-language-server@",
  "gopls@",
  "rust-analyzer@",
];
