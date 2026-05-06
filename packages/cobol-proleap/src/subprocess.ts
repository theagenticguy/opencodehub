/**
 * JVM subprocess wrapper.
 *
 * Spawns the wrapper `java -cp <jar>:<wrapperDir> cobol_to_scip`, feeds file
 * paths on stdin (one per line), reads NDJSON on stdout, and returns the
 * parsed records. The wrapper itself handles per-file isolation: when one
 * file crashes inside the ASG walker, the JVM process emits a `diagnostic`
 * record for that path and continues with the next.
 *
 * A non-zero JVM exit OR malformed JSON anywhere in stdout marks the
 * batch as "fallback needed" — the caller (`src/parse.ts`, commit 4) then
 * silently reparses every input path via the regex hot path.
 *
 * Timeouts: the default 60 s cap per batch is generous enough that even a
 * large copybook tree finishes; beyond that the subprocess is killed and
 * the batch is treated as a crash.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";

import { requireJre17 } from "./jre-probe.js";
import type { CobolDeepElement, ParseCobolDeepOptions } from "./types.js";

/** Outcome of a single JVM invocation. */
export type RunOutcome =
  | { kind: "ok"; records: readonly JvmRecord[] }
  | { kind: "crashed"; reason: string; partial: readonly JvmRecord[] };

/** A single NDJSON record emitted by the wrapper. */
export type JvmRecord =
  | {
      kind:
        | "program-id"
        | "paragraph"
        | "perform"
        | "copy"
        | "cics"
        | "data-item"
        | "file-descriptor";
      name: string;
      filePath: string;
      startLine: number;
      endLine: number;
    }
  | { kind: "diagnostic"; filePath: string; message: string };

export class JarMissingError extends Error {
  override readonly name = "JarMissingError";
  readonly code = "COBOL_PROLEAP_JAR_MISSING" as const;

  constructor(jarPath: string) {
    super(
      `cobol-proleap JAR not found at ${jarPath}. ` +
        "Run `codehub setup --cobol-proleap` to build the library from source.",
    );
  }
}

/**
 * Run the JVM wrapper once against a batch of file paths.
 *
 * Returns a discriminated outcome rather than throwing on crash so callers
 * can decide whether to fall back to the regex path or surface the error.
 * Throws only for preconditions — missing JAR or JRE < 17 — which the
 * caller should surface unchanged.
 */
export async function runBatch(
  paths: readonly string[],
  opts: ParseCobolDeepOptions,
): Promise<RunOutcome> {
  if (paths.length === 0) {
    return { kind: "ok", records: [] };
  }
  if (!existsSync(opts.jarPath)) {
    throw new JarMissingError(opts.jarPath);
  }
  await requireJre17();

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const javaBin = opts.javaBin ?? "java";
  const classpath = [opts.jarPath, opts.wrapperClassPath].join(delimiter);
  const args = ["-cp", classpath, "cobol_to_scip"];

  return await new Promise<RunOutcome>((resolve) => {
    const child = spawn(javaBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdoutBuf += d;
    });
    child.stderr.on("data", (d: string) => {
      stderrBuf += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        kind: "crashed",
        reason: `spawn ${javaBin}: ${err.message}`,
        partial: parseRecords(stdoutBuf),
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const records = parseRecords(stdoutBuf);
      if (timedOut) {
        resolve({
          kind: "crashed",
          reason: `JVM subprocess timed out after ${timeoutMs}ms`,
          partial: records,
        });
        return;
      }
      if (code !== 0) {
        const tail = stderrBuf.trim().slice(-400);
        resolve({
          kind: "crashed",
          reason: `JVM exited ${code}. Stderr tail: ${tail}`,
          partial: records,
        });
        return;
      }
      if (records.malformed) {
        resolve({
          kind: "crashed",
          reason: `Malformed NDJSON on stdout (${records.malformed} bad line(s))`,
          partial: records,
        });
        return;
      }
      resolve({ kind: "ok", records });
    });

    // Feed the file list on stdin. The wrapper reads one path per line and
    // terminates when it sees EOF.
    for (const p of paths) {
      child.stdin.write(`${p}\n`);
    }
    child.stdin.end();
  });
}

/**
 * Parse the wrapper's NDJSON stdout stream. Any unparseable line is
 * counted but not thrown — the caller decides whether the count
 * triggers a fallback. The return value is an Array augmented with
 * the count so callers can read it without a second pass.
 */
function parseRecords(raw: string): readonly JvmRecord[] & { malformed: number } {
  const out = [] as unknown as JvmRecord[] & { malformed: number };
  out.malformed = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as JvmRecord;
      if (isValidRecord(parsed)) {
        out.push(parsed);
      } else {
        out.malformed += 1;
      }
    } catch {
      out.malformed += 1;
    }
  }
  return out;
}

function isValidRecord(v: unknown): v is JvmRecord {
  if (v === null || typeof v !== "object") return false;
  const rec = v as { kind?: unknown; filePath?: unknown };
  if (typeof rec.kind !== "string" || typeof rec.filePath !== "string") return false;
  return true;
}

/**
 * Convert a wrapper record into the public {@link CobolDeepElement} shape.
 * `diagnostic` entries are dropped here — the caller reads them out of the
 * raw outcome before conversion and turns them into fallback triggers.
 */
export function recordToElement(rec: JvmRecord): CobolDeepElement | undefined {
  if (rec.kind === "diagnostic") return undefined;
  return {
    kind: rec.kind,
    name: rec.name,
    filePath: rec.filePath,
    startLine: rec.startLine,
    endLine: rec.endLine,
    language: "cobol",
    confidence: "parse",
  };
}
