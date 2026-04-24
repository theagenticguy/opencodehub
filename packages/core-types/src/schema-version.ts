export const SCHEMA_VERSION = "1.2.0" as const;

export type SchemaCompareResult = "ok" | "major-drift" | "minor-drift";

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
  return "ok";
}
