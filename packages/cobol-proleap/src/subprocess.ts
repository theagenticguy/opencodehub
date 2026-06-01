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
 * large copybook tree finishes; beyond that the subprocess is sent SIGTERM
 * and the batch is treated as a crash. A wedged JVM that ignores SIGTERM is
 * escalated to SIGKILL after a short grace window, and the batch Promise is
 * resolved from the buffered partial so it never hangs.
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

  const javaBin = opts.javaBin ?? "java";
  const classpath = [opts.jarPath, opts.wrapperClassPath].join(delimiter);
  const args = ["-cp", classpath, "cobol_to_scip"];

  return await superviseProcess(javaBin, args, paths, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    killGraceMs: opts.killGraceMs ?? 3_000,
  });
}

/**
 * Spawn `command`, feed `stdinLines` (one per line) on stdin, buffer stdout
 * as NDJSON, and supervise the lifetime:
 *
 *   - On a clean exit, the buffered stdout is parsed and returned (`ok`, or
 *     `crashed` for a non-zero code / malformed NDJSON).
 *   - On `timeoutMs`, the child is sent SIGTERM. If it ignores SIGTERM and no
 *     `'exit'` follows within `killGraceMs`, it is escalated to SIGKILL and
 *     the returned Promise is settled from the buffered partial — so a wedged
 *     child can never leave this Promise unresolved.
 *
 * Extracted from {@link runBatch} so the timeout/kill supervision can be
 * exercised against a stand-in process without a live JVM.
 */
export async function superviseProcess(
  command: string,
  args: readonly string[],
  stdinLines: readonly string[],
  opts: { readonly timeoutMs: number; readonly killGraceMs: number },
): Promise<RunOutcome> {
  const { timeoutMs, killGraceMs } = opts;
  return await new Promise<RunOutcome>((resolve) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let sigkillSent = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const settle = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Escalate to SIGKILL if the child ignores SIGTERM (e.g. a JVM wedged
      // in native code), and settle from the buffered partial so the Promise
      // never hangs even if no 'exit' event ever fires.
      killTimer = setTimeout(() => {
        sigkillSent = true;
        child.kill("SIGKILL");
        settle({
          kind: "crashed",
          reason: `JVM subprocess timed out after ${timeoutMs}ms and ignored SIGTERM (SIGKILL sent)`,
          partial: parseRecords(stdoutBuf),
        });
      }, killGraceMs);
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
      settle({
        kind: "crashed",
        reason: `spawn ${command}: ${err.message}`,
        partial: parseRecords(stdoutBuf),
      });
    });
    child.on("exit", (code, signal) => {
      const records = parseRecords(stdoutBuf);
      if (timedOut) {
        // Distinguish how the timed-out child actually died: a clean SIGTERM
        // exit vs. an escalation to SIGKILL (either the kill timer already
        // fired, or the OS reports the exit signal as SIGKILL). The test
        // harness installs a SIGTERM-ignoring child to force the escalation
        // path, so the reason must name SIGKILL whenever it was sent.
        const killed = sigkillSent || signal === "SIGKILL";
        settle({
          kind: "crashed",
          reason: killed
            ? `JVM subprocess timed out after ${timeoutMs}ms and ignored SIGTERM (SIGKILL sent)`
            : `JVM subprocess timed out after ${timeoutMs}ms`,
          partial: records,
        });
        return;
      }
      if (code !== 0) {
        const tail = stderrBuf.trim().slice(-400);
        settle({
          kind: "crashed",
          reason: `JVM exited ${code}. Stderr tail: ${tail}`,
          partial: records,
        });
        return;
      }
      if (records.malformed) {
        settle({
          kind: "crashed",
          reason: `Malformed NDJSON on stdout (${records.malformed} bad line(s))`,
          partial: records,
        });
        return;
      }
      settle({ kind: "ok", records });
    });

    // Feed the file list on stdin. The wrapper reads one path per line and
    // terminates when it sees EOF.
    for (const p of stdinLines) {
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
export function parseRecords(raw: string): readonly JvmRecord[] & { malformed: number } {
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

const SYMBOL_KINDS = new Set<JvmRecord["kind"]>([
  "program-id",
  "paragraph",
  "perform",
  "copy",
  "cics",
  "data-item",
  "file-descriptor",
]);

function isValidRecord(v: unknown): v is JvmRecord {
  if (v === null || typeof v !== "object") return false;
  const rec = v as {
    kind?: unknown;
    filePath?: unknown;
    name?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    message?: unknown;
  };
  if (typeof rec.kind !== "string" || typeof rec.filePath !== "string") return false;
  if (rec.kind === "diagnostic") {
    return typeof rec.message === "string";
  }
  // Every non-diagnostic kind is a symbol ref; recordToElement copies
  // name/startLine/endLine straight through, so a record missing any of them
  // would leak undefined fields into a CobolDeepElement. Reject those as
  // malformed rather than trust them.
  if (!SYMBOL_KINDS.has(rec.kind as JvmRecord["kind"])) return false;
  return (
    typeof rec.name === "string" &&
    typeof rec.startLine === "number" &&
    typeof rec.endLine === "number"
  );
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
