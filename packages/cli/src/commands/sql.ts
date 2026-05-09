/**
 * `codehub sql <query>` — run a read-only SQL statement against the local
 * temporal store. The `assertReadOnlySql` guard inside the temporal adapter
 * rejects any mutation, and a per-statement JS timer interrupts long
 * queries.
 *
 * Routes through `store.temporal.exec()` rather than the graph-tier
 * escape hatch — `--sql` is the one CLI surface that consumes the
 * tabular view directly. Graph-only commands stay on
 * `store.graph.<finder>()`.
 */

import { openStoreForCommand } from "./open-store.js";

export interface SqlOptions {
  readonly repo?: string;
  readonly home?: string;
  readonly timeoutMs?: number;
  readonly json?: boolean;
}

export async function runSql(sql: string, opts: SqlOptions = {}): Promise<void> {
  const { store } = await openStoreForCommand(opts);
  try {
    const rows = await store.temporal.exec(sql, [], { timeoutMs: opts.timeoutMs ?? 5_000 });
    if (opts.json || rows.length === 0) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    printTable(rows);
  } finally {
    await store.close();
  }
}

function printTable(rows: readonly Record<string, unknown>[]): void {
  const first = rows[0];
  if (!first) return;
  const cols = Object.keys(first);
  const widths = cols.map((c) => c.length);
  const str = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return `[${v.map((x) => String(x)).join(",")}]`;
    return String(v);
  };
  for (const row of rows) {
    cols.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, str(row[c]).length);
    });
  }
  const line = (vals: readonly string[]): string =>
    vals.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(cols));
  for (const row of rows) {
    console.log(line(cols.map((c) => str(row[c]))));
  }
}
