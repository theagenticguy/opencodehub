import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DuckDbStore } from "@opencodehub/storage";
import { ConnectionPool } from "./connection-pool.js";

/**
 * Fake store with just enough surface for the pool to exercise acquire
 * / release / shutdown semantics without standing up DuckDB.
 */
function makeFakeStore(path: string): {
  store: DuckDbStore;
  isClosed: () => boolean;
  closeCount: () => number;
} {
  let closed = false;
  let closeCalls = 0;
  const store = {
    path,
    close: async () => {
      closeCalls += 1;
      closed = true;
    },
  } as unknown as DuckDbStore;
  return { store, isClosed: () => closed, closeCount: () => closeCalls };
}

test("acquire opens once, reuses on subsequent acquires", async () => {
  let factoryCalls = 0;
  const pool = new ConnectionPool({ max: 4, ttlMs: 10_000 }, async (p) => {
    factoryCalls += 1;
    return makeFakeStore(p).store;
  });
  try {
    const a = await pool.acquire("repoA", "/a.duckdb");
    const b = await pool.acquire("repoA", "/a.duckdb");
    assert.equal(a, b);
    assert.equal(factoryCalls, 1);
    await pool.release("repoA");
    await pool.release("repoA");
  } finally {
    await pool.shutdown();
  }
});

test("concurrent acquires dedupe in-flight opens", async () => {
  let factoryCalls = 0;
  const pool = new ConnectionPool({ max: 4, ttlMs: 10_000 }, async (p) => {
    factoryCalls += 1;
    // Tiny delay to simulate open latency.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return makeFakeStore(p).store;
  });
  try {
    const [a, b, c] = await Promise.all([
      pool.acquire("repoX", "/x.duckdb"),
      pool.acquire("repoX", "/x.duckdb"),
      pool.acquire("repoX", "/x.duckdb"),
    ]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(factoryCalls, 1);
    await pool.release("repoX");
    await pool.release("repoX");
    await pool.release("repoX");
  } finally {
    await pool.shutdown();
  }
});

test("LRU eviction on size overflow closes evicted entries", async () => {
  const probes: ReturnType<typeof makeFakeStore>[] = [];
  const pool = new ConnectionPool({ max: 2, ttlMs: 10_000 }, async (p) => {
    const probe = makeFakeStore(p);
    probes.push(probe);
    return probe.store;
  });
  try {
    await pool.acquire("a", "/a.duckdb");
    await pool.release("a");
    await pool.acquire("b", "/b.duckdb");
    await pool.release("b");
    await pool.acquire("c", "/c.duckdb");
    await pool.release("c");
    // Give dispose a microtask to finish the async close.
    await new Promise((resolve) => setImmediate(resolve));
    // `a` was least-recently-used and should have been evicted.
    assert.equal(probes[0]?.isClosed(), true, "evicted store should be closed");
  } finally {
    await pool.shutdown();
  }
});

test("shutdown closes every remaining entry exactly once", async () => {
  const probes: ReturnType<typeof makeFakeStore>[] = [];
  const pool = new ConnectionPool({ max: 4, ttlMs: 10_000 }, async (p) => {
    const probe = makeFakeStore(p);
    probes.push(probe);
    return probe.store;
  });
  await pool.acquire("r1", "/r1.duckdb");
  await pool.release("r1");
  await pool.acquire("r2", "/r2.duckdb");
  await pool.release("r2");
  await pool.shutdown();
  for (const p of probes) {
    assert.equal(p.isClosed(), true);
    assert.equal(p.closeCount(), 1);
  }
});

test("acquire after shutdown throws", async () => {
  const pool = new ConnectionPool({ max: 2 }, async (p) => makeFakeStore(p).store);
  await pool.shutdown();
  await assert.rejects(() => pool.acquire("x", "/x.duckdb"), /shut down/);
});
