/**
 * BOM body item: README.md with the determinism contract (AC-M5-5 — item 9 partial).
 *
 * Pure-string renderer; deterministic by construction. The README pastes
 * the M5 determinism contract verbatim and interpolates the manifest's
 * commit / tokenizer / class / pack hash so consumers can verify byte
 * identity without parsing `manifest.json`.
 *
 * Determinism contract:
 *   - Pure function of `manifest` + `bomItemPaths`. No clocks, no random
 *     ids, no environment lookups.
 *   - LF-only line endings (W-M5-4).
 *   - `bomItemPaths` is rendered alpha-sorted; the function does NOT
 *     mutate the caller's array.
 */

import type { PackManifest } from "./types.js";

export interface ReadmeOpts {
  readonly manifest: PackManifest;
  readonly bomItemPaths: readonly string[];
}

/**
 * Build the BOM README. Pure function; same inputs → same bytes.
 */
export function buildReadme(opts: ReadmeOpts): string {
  const { manifest, bomItemPaths } = opts;
  const sortedPaths = [...bomItemPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const lines: string[] = [];
  lines.push("# OpenCodeHub Code-Pack");
  lines.push("");
  lines.push("Deterministic 9-item code-pack BOM produced by `@opencodehub/pack`.");
  lines.push("");

  lines.push("## Manifest");
  lines.push("");
  lines.push(`- commit: \`${manifest.commit}\``);
  lines.push(`- repo_origin_url: ${formatRepoUrl(manifest.repoOriginUrl)}`);
  lines.push(`- tokenizer_id: \`${manifest.tokenizerId}\``);
  lines.push(`- determinism_class: \`${manifest.determinismClass}\``);
  lines.push(`- budget_tokens: ${manifest.budgetTokens}`);
  lines.push(`- pack_hash: \`${manifest.packHash}\``);
  lines.push(`- schema_version: ${manifest.schemaVersion}`);
  lines.push("");

  lines.push("## Pins");
  lines.push("");
  lines.push(`- chonkie_version: \`${manifest.pins.chonkieVersion}\``);
  lines.push(`- duckdb_version: \`${manifest.pins.duckdbVersion}\``);
  const grammarKeys = Object.keys(manifest.pins.grammarCommits).sort();
  if (grammarKeys.length === 0) {
    lines.push("- grammar_commits: (none)");
  } else {
    lines.push("- grammar_commits:");
    for (const k of grammarKeys) {
      lines.push(`  - ${k}: \`${manifest.pins.grammarCommits[k]}\``);
    }
  }
  lines.push("");

  lines.push("## BOM items");
  lines.push("");
  for (const p of sortedPaths) {
    lines.push(`- \`${p}\``);
  }
  lines.push("");

  lines.push("## Determinism contract");
  lines.push("");
  lines.push(
    "Same `(commit, tokenizer_id, budget_tokens, chonkie_version, duckdb_version, grammar_commits)` produces a byte-identical pack and the same `pack_hash`.",
  );
  lines.push("");
  lines.push("- `strict` — every BOM file is byte-identity reproducible.");
  lines.push(
    "- `best_effort` — the tokenizer is a Claude / Anthropic model whose tokenization is not guaranteed stable across versions; non-tokenizer fields are still byte-identity.",
  );
  lines.push(
    "- `degraded` — the AST chunker fell back to a line-split (e.g. tree-sitter grammar unavailable). The pack is still reproducible across two runs of the same code path, but cross-environment chunks may differ.",
  );
  lines.push("");
  lines.push(
    "All file bytes use LF line endings; CRLF inputs are normalized before hashing so two repos differing only in line-ending style produce the same `pack_hash`.",
  );
  lines.push("");

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatRepoUrl(url: string | null): string {
  return url === null ? "(none)" : `\`${url}\``;
}
