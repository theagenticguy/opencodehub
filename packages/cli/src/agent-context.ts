/**
 * AGENTS.md / CLAUDE.md stanza writer.
 *
 * When a repo is analyzed we update (or create) two agent-discovery files at
 * the repo root — `AGENTS.md` and `CLAUDE.md`. Each gets the same stanza
 * describing the 7 OpenCodeHub MCP tools, so any agent opening the repo knows
 * what is available and how to call it.
 *
 * Clean-room authored. The stanza text below was written for OpenCodeHub; no
 * prompt wording was copied from any prior tool. Callers can replace the
 * stanza via the `{ stanza }` option for tests or custom branding.
 *
 * Behavior:
 *   - If the file does not exist → create it with just the stanza.
 *   - If it exists and already contains an `## OpenCodeHub MCP Tools` section
 *     → replace that section in place, preserving everything before/after.
 *   - If it exists and has no such section → append the stanza (preceded by a
 *     blank line when needed).
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";

export const STANZA_HEADING = "## OpenCodeHub MCP Tools";

/** Default stanza body. Clean-room authored — keep short, keep accurate. */
export const DEFAULT_STANZA = `${STANZA_HEADING}

This repository has been indexed by OpenCodeHub. When you are working in this
codebase, prefer the following MCP tools over raw file search — they return
graph-aware results grouped by execution flow and include blast-radius risk
tiers.

- \`list_repos\` — enumerate repos currently indexed on this machine.
- \`query\` — hybrid BM25 + vector search over symbols, grouped by process.
- \`context\` — inbound/outbound refs and participating flows for one symbol.
- \`impact\` — dependents of a target up to a configurable depth, with a risk tier.
- \`detect_changes\` — map an uncommitted or committed diff to affected symbols.
- \`rename\` — graph-assisted multi-file rename; dry-run is the default.
- \`sql\` — read-only SQL against the local graph store with a 5 s timeout.

Run \`codehub analyze\` after pulling new commits so the index stays aligned
with the working tree. \`codehub status\` reports staleness.
`;

/** Files we manage. Order matters only for deterministic test output. */
export const AGENT_CONTEXT_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

export interface WriteStanzaOptions {
  /** Override the stanza body (must start with `## OpenCodeHub MCP Tools`). */
  readonly stanza?: string;
}

export interface WriteStanzaResult {
  readonly file: string;
  readonly action: "created" | "replaced" | "appended";
}

/**
 * Write the stanza into both `AGENTS.md` and `CLAUDE.md` at `repoPath`.
 * Returns per-file results so the caller can log what it did.
 */
export async function writeAgentContextFiles(
  repoPath: string,
  opts: WriteStanzaOptions = {},
): Promise<readonly WriteStanzaResult[]> {
  const results: WriteStanzaResult[] = [];
  for (const name of AGENT_CONTEXT_FILES) {
    const result = await writeStanza(resolve(repoPath, name), opts);
    results.push(result);
  }
  return results;
}

/**
 * Write (or merge) the stanza into a single file. Exposed for tests and for
 * callers that want to target a bespoke file path.
 */
export async function writeStanza(
  file: string,
  opts: WriteStanzaOptions = {},
): Promise<WriteStanzaResult> {
  const stanza = (opts.stanza ?? DEFAULT_STANZA).trimEnd();
  let existing: string | undefined;
  try {
    existing = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = undefined;
  }

  if (existing === undefined) {
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${stanza}\n`, { raw: true });
    return { file, action: "created" };
  }

  const { replaced, output } = replaceOrAppendStanza(existing, stanza);
  await writeFileAtomic(file, output, { raw: true });
  return { file, action: replaced ? "replaced" : "appended" };
}

/**
 * Replace a prior `## OpenCodeHub MCP Tools` section with `stanza`, or append
 * `stanza` at the end. The section extends from the heading up to (but not
 * including) the next `## ` heading, or end-of-file.
 *
 * Exposed for tests; pure string transform, no IO.
 */
export function replaceOrAppendStanza(
  existing: string,
  stanza: string,
): { replaced: boolean; output: string } {
  const lines = existing.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === STANZA_HEADING);

  if (headingIndex === -1) {
    if (existing.length === 0) {
      return { replaced: false, output: `${stanza}\n` };
    }
    const base = existing.endsWith("\n") ? existing : `${existing}\n`;
    // Ensure a blank line between prior content and our stanza.
    const separator = base.endsWith("\n\n") ? "" : "\n";
    return { replaced: false, output: `${base}${separator}${stanza}\n` };
  }

  // Find the end of the OpenCodeHub section: the next line that starts with
  // `## ` (a sibling heading) at the same level. Lines starting with `###` or
  // deeper are still part of our section.
  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      endIndex = i;
      break;
    }
  }

  const before = lines.slice(0, headingIndex).join("\n");
  const after = lines.slice(endIndex).join("\n");

  const beforeBlock = before.length === 0 ? "" : before.endsWith("\n") ? before : `${before}\n`;
  const afterBlock = after.length === 0 ? "" : after.startsWith("\n") ? after : `\n${after}`;

  const output = `${beforeBlock}${stanza}\n${afterBlock}`;
  // Collapse a double-trailing newline if afterBlock was empty.
  const normalized = output.endsWith("\n") ? output : `${output}\n`;
  return { replaced: true, output: normalized };
}
