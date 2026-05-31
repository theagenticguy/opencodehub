export const SCHEMA_VERSION = "1.2.0" as const;

/**
 * Result of comparing an indexed graph's schema version against the running
 * binary's {@link SCHEMA_VERSION}.
 *
 * - `ok` — same major, same minor. Patch differences are deliberately treated
 *   as `ok`: patch bumps are reserved for backward- and forward-compatible
 *   changes that never alter graph bytes or invariants.
 * - `major-drift` — major versions differ; the graph must be re-indexed.
 * - `minor-drift` — the indexed graph is an OLDER minor than the binary; it may
 *   be missing fields/invariants the newer binary expects (backward gap).
 * - `forward-incompat` — the indexed graph is a NEWER minor than the binary; an
 *   older binary cannot assume it understands fields/invariants the newer
 *   schema introduced (forward gap).
 */
export type SchemaCompareResult = "ok" | "major-drift" | "minor-drift" | "forward-incompat";

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseSemver(v: string): Semver {
  const parts = v.split(".");
  if (parts.length < 2) {
    throw new Error(`Invalid schema version: ${v}`);
  }
  const [maj, min, pat] = parts;
  const major = Number(maj);
  const minor = Number(min);
  const patch = Number(pat ?? "0");
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    throw new Error(`Invalid schema version: ${v}`);
  }
  return { major, minor, patch };
}

export function compareSchemaVersion(indexed: string): SchemaCompareResult {
  const a = parseSemver(indexed);
  const b = parseSemver(SCHEMA_VERSION);
  if (a.major !== b.major) return "major-drift";
  if (a.minor < b.minor) return "minor-drift";
  if (a.minor > b.minor) return "forward-incompat";
  return "ok";
}
