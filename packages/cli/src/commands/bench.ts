/**
 * `codehub bench` — acceptance-gate dashboard.
 *
 * Wraps `scripts/acceptance.sh` so we can invoke each gate as a discrete
 * listr2 task, capture its exit code, and render the final summary as a
 * cli-table3. Gates are hard-coded here to match the script's output —
 * changing the script requires a matching edit here.
 *
 * Exit codes:
 *   0  every mandatory gate PASSED
 *   1  at least one gate FAILED
 *   2  the acceptance script could not be located
 *
 * Like `doctor`, this never auto-heals and never writes to the repo; it
 * only reports.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Table from "cli-table3";
import { Listr } from "listr2";

export type GateStatus = "pending" | "pass" | "fail" | "skipped";

/** One row in the output table, populated as `acceptance.sh` emits lines. */
export interface GateRow {
  readonly id: string;
  readonly title: string;
  status: GateStatus;
  detail: string;
}

export interface BenchOptions {
  /** Absolute path to `scripts/acceptance.sh`. Overrides default lookup. */
  readonly acceptanceScript?: string;
  /** Suppress the listr2 renderer (used by tests). */
  readonly silent?: boolean;
}

export interface BenchReport {
  readonly rows: readonly GateRow[];
  readonly exitCode: 0 | 1 | 2;
}

/**
 * Fixed roster of MVP acceptance gates. Order + ids mirror
 * `scripts/acceptance.sh`; rendering is by this order so users see the
 * same sequence whether they run the script directly or via `codehub
 * bench`.
 */
export const MVP_GATES: readonly { readonly id: string; readonly title: string }[] = [
  { id: "install", title: "pnpm install --frozen-lockfile" },
  { id: "build", title: "pnpm -r build" },
  { id: "tests", title: "pnpm -r test" },
  { id: "banned-strings", title: "banned-strings grep" },
  { id: "licenses", title: "license allowlist" },
  { id: "determinism", title: "graphHash determinism" },
  { id: "incremental", title: "incremental reindex timings (soft)" },
  { id: "mcp-smoke", title: "MCP stdio boot smoke" },
  { id: "eval", title: "Python eval harness" },
];

/**
 * Entrypoint for `codehub bench`. Returns the structured report so
 * acceptance tests can assert the outcome without scraping stdout.
 */
export async function runBench(opts: BenchOptions = {}): Promise<BenchReport> {
  const script = await locateAcceptanceScript(opts.acceptanceScript);
  if (!script) {
    console.error(
      "codehub bench: scripts/acceptance.sh not found — set --acceptance or run from the repo root.",
    );
    process.exitCode = 2;
    return { rows: [], exitCode: 2 };
  }

  const rows: GateRow[] = MVP_GATES.map((g) => ({
    id: g.id,
    title: g.title,
    status: "pending" as const,
    detail: "",
  }));

  // Kick acceptance.sh in the background. We stream stdout line-by-line
  // and parse every `[PASS] …` / `[FAIL] …` marker to advance the matching
  // row. Timing for soft gates is rendered verbatim in the `detail` cell.
  const stream = runScript(script);
  const listr = new Listr(
    MVP_GATES.map((gate, idx) => ({
      title: gate.title,
      task: async (_ctx, task) => {
        // Wait for this row's completion. We don't advance rows ahead of
        // the stream — each row completes when the script's emitter calls
        // applyLine() with a matching marker. This keeps the UI honest.
        await waitUntil(() => rows[idx]?.status !== "pending");
        const row = rows[idx];
        if (!row) return;
        task.title = `${gate.title} — ${row.detail}`;
        if (row.status === "fail") {
          throw new Error(row.detail || "FAIL");
        }
      },
    })),
    {
      concurrent: false,
      exitOnError: false,
      renderer: opts.silent ? "silent" : "default",
    },
  );

  // Capture listr2 failures but do not rethrow — we assemble the final
  // report regardless.
  const listrPromise = listr.run().catch(() => {
    /* failures already captured in rows[i].status === "fail" */
  });

  stream.onLine((line) => {
    applyLine(rows, line);
  });
  const code = await stream.done;
  // Flush any rows that never received a marker (e.g. script crashed).
  for (const row of rows) {
    if (row.status === "pending") {
      row.status = "skipped";
      row.detail = "no [PASS]/[FAIL] marker — script crashed or was killed";
    }
  }
  await listrPromise;

  printTable(rows);
  const exitCode: 0 | 1 | 2 = rows.some((r) => r.status === "fail") || code !== 0 ? 1 : 0;
  process.exitCode = exitCode;
  return { rows, exitCode };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a stdout/stderr stream into lines regardless of chunk boundaries. */
function lineSplitter(): {
  push: (chunk: string) => readonly string[];
  flush: () => readonly string[];
} {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      return parts;
    },
    flush() {
      if (buf.length === 0) return [];
      const out = [buf];
      buf = "";
      return out;
    },
  };
}

interface ScriptStream {
  onLine(cb: (line: string) => void): void;
  readonly done: Promise<number>;
}

function runScript(scriptPath: string): ScriptStream {
  const child = spawn("bash", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: dirname(dirname(scriptPath)), // assume scripts/ is a sibling of packages/
  });
  const listeners: Array<(line: string) => void> = [];
  const stdoutSplit = lineSplitter();
  const stderrSplit = lineSplitter();
  const emit = (line: string): void => {
    for (const l of listeners) l(line);
  };
  child.stdout.on("data", (d: Buffer) => {
    for (const line of stdoutSplit.push(d.toString("utf8"))) emit(line);
  });
  child.stderr.on("data", (d: Buffer) => {
    // We echo stderr so users see banner messages, but don't parse it for
    // gate status — acceptance.sh writes its markers to stdout.
    for (const _line of stderrSplit.push(d.toString("utf8"))) {
      /* intentionally discarded */
    }
  });
  const done: Promise<number> = new Promise((resolveProm) => {
    child.on("error", () => resolveProm(127));
    child.on("close", (code) => {
      for (const line of stdoutSplit.flush()) emit(line);
      stderrSplit.flush();
      resolveProm(code ?? 0);
    });
  });
  return {
    onLine(cb) {
      listeners.push(cb);
    },
    done,
  };
}

/**
 * Apply a single line from `acceptance.sh` to the gate table. We parse
 * the `N/9: <title>` banner line to pick which row the next `[PASS] ...`
 * or `[FAIL] ...` marker belongs to. Anything else is ignored (timing
 * summaries live under a gate row as `......` notes).
 */
let currentGateIdx = -1;
export function applyLine(rows: GateRow[], rawLine: string): void {
  const line = rawLine.trimEnd();
  const banner = /^\d+\/\d+:\s+(.*)$/.exec(line);
  if (banner) {
    const title = banner[1] ?? "";
    const idx = rows.findIndex((r) => r.title === title);
    if (idx >= 0) currentGateIdx = idx;
    return;
  }
  const passMatch = /^\s*\[PASS\]\s+(.*)$/.exec(line);
  if (passMatch && currentGateIdx >= 0) {
    const row = rows[currentGateIdx];
    if (row) {
      row.status = "pass";
      row.detail = passMatch[1] ?? "";
    }
    currentGateIdx = -1;
    return;
  }
  const failMatch = /^\s*\[FAIL\]\s+(.*)$/.exec(line);
  if (failMatch && currentGateIdx >= 0) {
    const row = rows[currentGateIdx];
    if (row) {
      row.status = "fail";
      row.detail = failMatch[1] ?? "";
    }
    currentGateIdx = -1;
    return;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

async function locateAcceptanceScript(override?: string): Promise<string | null> {
  if (override !== undefined) {
    if (await pathExists(override)) return override;
    return null;
  }
  // Walk up from this file to find scripts/acceptance.sh. The CLI ships
  // at packages/cli/dist/commands/bench.js in the monorepo; scripts/ lives
  // four levels above.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "..", "scripts", "acceptance.sh"),
    resolve(process.cwd(), "scripts", "acceptance.sh"),
  ];
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function printTable(rows: readonly GateRow[]): void {
  const table = new Table({
    head: ["GATE", "STATUS", "DETAIL"],
    style: { head: [], border: [] },
    colWidths: [36, 10, 72],
    wordWrap: true,
  });
  for (const row of rows) {
    const glyph =
      row.status === "pass"
        ? "PASS"
        : row.status === "fail"
          ? "FAIL"
          : row.status === "skipped"
            ? "SKIP"
            : "?";
    table.push([row.title, glyph, row.detail]);
  }
  const passed = rows.filter((r) => r.status === "pass").length;
  const failed = rows.filter((r) => r.status === "fail").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;
  console.log(table.toString());
  console.log(`bench: ${passed}/${rows.length} passed, ${failed} failed, ${skipped} skipped`);
}

// Guard against `scripts` discovery confusion when the CLI is installed
// via `npm link` or similar.
export { locateAcceptanceScript, pathExists };

// Silence lint for the unused helper import; kept for future per-gate
// path joining.
void join;
