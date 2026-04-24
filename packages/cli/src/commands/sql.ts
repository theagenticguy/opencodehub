/**
 * `codehub sql <query>` — run a read-only SQL statement against the local
 * DuckDB store. The `assertReadOnlySql` guard inside the store rejects any
 * mutation, and a per-statement JS timer interrupts long queries.
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
    const rows = await store.query(sql, [], { timeoutMs: opts.timeoutMs ?? 5_000 });
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
