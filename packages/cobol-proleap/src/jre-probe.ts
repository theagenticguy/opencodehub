/**
 * JRE probe — spawns `java --version` and parses the major version from
 * stdout/stderr. The ProLeap wrapper compiles against Java 17 source/target,
 * so any JRE < 17 refuses to run with a clear install hint.
 *
 * `java --version` historically printed to stderr on some distributions
 * and stdout on others; we concatenate both for robust matching. The
 * parser accepts both the canonical "openjdk 17.0.2 2022-01-18" form AND
 * the legacy "java version "1.8.0_292"" form (which we reject downstream
 * because `1.8 → major = 8 < 17`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Required JRE major version. */
export const MIN_JRE_MAJOR = 17;

export class JreMissingError extends Error {
  override readonly name = "JreMissingError";
  readonly code = "COBOL_PROLEAP_JRE_MISSING" as const;
  readonly detectedVersion: string | undefined;

  constructor(detected: string | undefined) {
    const where = detected === undefined ? "not on PATH" : `detected "${detected}"`;
    super(
      `cobol-proleap requires JRE ${MIN_JRE_MAJOR}+ on PATH (${where}). ` +
        "Install a JDK 17+ (e.g. `brew install openjdk@17` or `apt install openjdk-17-jdk`), " +
        "then retry `codehub analyze --allow-build-scripts=proleap`.",
    );
    this.detectedVersion = detected;
  }
}

/** Probe function signature for dependency injection (tests). */
export type JreProbe = () => Promise<string | undefined>;

/** Default probe: runs `java --version` with a 5 s timeout. */
export const defaultJreProbe: JreProbe = async () => {
  try {
    const { stdout, stderr } = await execFileP("java", ["--version"], {
      timeout: 5000,
    });
    const combined = `${stdout}\n${stderr}`.trim();
    return combined.length > 0 ? combined : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Parse the major version out of a `java --version` / `java -version` output
 * string. Returns `undefined` when the output doesn't match any known shape.
 *
 *   openjdk 17.0.2 2022-01-18       → 17
 *   openjdk 21 2023-09-19            → 21
 *   openjdk 9.0.4 2018-01-16        → 9    (single-digit modern major)
 *   java 17.0.12 2024-07-16 LTS      → 17
 *   java version "1.8.0_292"         → 8   (Java 8 used 1.x naming)
 *   java version "9"                 → 9   (single-digit, quoted)
 *   java version "11.0.12" 2021-07-20 → 11
 */
export function parseJreMajor(output: string | undefined): number | undefined {
  if (output === undefined) return undefined;
  // Anchor extraction to the leading version token only. Scanning the whole
  // string for any digit run mis-reads the release date (e.g. "2018-01-16"
  // yields a spurious "01") — the version token always follows the vendor
  // word (`openjdk`/`java`), optionally preceded by the literal `version`
  // and an opening quote.
  const token = output.match(/(?:openjdk|java)(?:\s+version)?\s+"?(\d+(?:\.\d+)*)/i);
  if (token?.[1] === undefined) return undefined;
  const segments = token[1].split(".");
  const head = segments[0];
  if (head === undefined) return undefined;
  // Legacy 1.x form (Java 1.8 = Java 8): the real major is the second segment.
  if (head === "1" && segments[1] !== undefined) {
    const parsed = Number.parseInt(segments[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Modern N.x form (including single-digit majors like 9): the major is the
  // first segment of the anchored token.
  const parsed = Number.parseInt(head, 10);
  if (Number.isFinite(parsed)) return parsed;
  return undefined;
}

/**
 * Enforce the JRE 17+ gate. Throws {@link JreMissingError} when the probe
 * reports no `java` on PATH or a version < {@link MIN_JRE_MAJOR}.
 */
export async function requireJre17(probe: JreProbe = defaultJreProbe): Promise<number> {
  const output = await probe();
  const major = parseJreMajor(output);
  if (major === undefined || major < MIN_JRE_MAJOR) {
    throw new JreMissingError(output);
  }
  return major;
}
