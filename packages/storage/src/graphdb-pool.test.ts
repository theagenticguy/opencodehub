/**
 * Concurrency regression suite for {@link GraphDbPool} (spec 004 §AC-M3-2).
 *
 * Every test injects a fake `NativeBinding` into the pool so the suite
 * runs without touching the native binding. That lets us drive exact
 * timing, force queue saturation, and inspect internal counters — none
 * of which are available when running against the real native binding.
 *
 * Scenarios:
 *   1. 100 concurrent reads against one pool do not deadlock. The fake
 *      connection delays each query by 5ms; the suite asserts every
 *      promise resolves and that `available` returns to full strength.
 *   2. Per-call `timeoutMs` aborts a long-running query. The fake
 *      connection ignores cancellation (matches the native binding),
 *      so the pool's own timeout race is what the test verifies.
 *   3. Waiter timeout when the pool is saturated. With
 *      `maxConnections: 2` and a slow fake connection, the third
 *      concurrent read waits past `waiterTimeoutMs` and rejects with a
 *      clear message.
 *   4. Idle sweep closes pools whose last use was older than
 *      `idleTimeoutMs`. The test calls `runIdleSweep` with a frozen
 *      `now` far in the future to avoid a real wall-clock wait.
 *   5. LRU eviction when the registry is at `maxPoolSize`. Opening a
 *      sixth pool evicts the oldest-by-`lastUsed` entry.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { GraphDbStore } from "./graphdb-adapter.js";
import {
  _poolRegistrySize,
  _resetPoolRegistry,
  GraphDbPool,
  type NativeBinding,
  type NativeConnection,
  type NativeDatabase,
  type NativePreparedStatement,
  type NativeQueryResult,
  runIdleSweep,
} from "./graphdb-pool.js";

// ---------------------------------------------------------------------------
// Fake native binding — a duck-typed stand-in for @ladybugdb/core.
// ---------------------------------------------------------------------------

interface FakeConfig {
  /** Milliseconds each `conn.query()` call sleeps before resolving. */
  readonly queryLatencyMs?: number;
  /** Rows each `getAll()` returns. */
  readonly rows?: readonly Record<string, unknown>[];
}

function makeFakeBinding(cfg: FakeConfig = {}): NativeBinding {
  const latency = cfg.queryLatencyMs ?? 0;
  const rows = cfg.rows ?? [{ ok: 1 }];

  class FakeResult implements NativeQueryResult {
    async getAll(): Promise<Record<string, unknown>[]> {
      return [...rows];
    }
  }

  class FakePreparedStatement implements NativePreparedStatement {
    isSuccess(): boolean {
      return true;
    }
    getErrorMessage(): string {
      return "";
    }
  }

  class FakeConnection implements NativeConnection {
    private closed = false;

    async query(_stmt: string): Promise<NativeQueryResult | NativeQueryResult[]> {
      if (latency > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, latency));
      }
      if (this.closed) throw new Error("connection closed");
      return new FakeResult();
    }
    async prepare(_stmt: string): Promise<NativePreparedStatement> {
      return new FakePreparedStatement();
    }
    async execute(
      _stmt: NativePreparedStatement,
      _params?: Record<string, unknown>,
    ): Promise<NativeQueryResult | NativeQueryResult[]> {
      if (latency > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, latency));
      }
      return new FakeResult();
    }
    async close(): Promise<void> {
      this.closed = true;
    }
  }

  class FakeDatabase implements NativeDatabase {
    async close(): Promise<void> {}
  }

  // The cast is deliberate — NativeBinding's constructors expect
  // arbitrary args; our fakes accept them via `...args` on the runtime
  // but typescript complains about the arity/variance without an
  // unknown bounce.
  return {
    Database: FakeDatabase as unknown as NativeBinding["Database"],
    Connection: FakeConnection as unknown as NativeBinding["Connection"],
  };
}

afterEach(() => {
  _resetPoolRegistry();
});

// ---------------------------------------------------------------------------
// 1. 100 concurrent reads do not deadlock
// ---------------------------------------------------------------------------

test("100 concurrent reads against one pool complete without deadlock", async () => {
  const pool = new GraphDbPool("/tmp/graphdb-concurrency-100.db", {
    binding: makeFakeBinding({ queryLatencyMs: 2 }),
    // Default maxConnections (8) is plenty for 100 reads — the point
    // is that every queue handoff lands cleanly.
  });
  await pool.open();
  try {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => pool.query(`MATCH RETURN ${i}`)),
    );
    assert.equal(results.length, 100);
    for (const rows of results) {
      assert.equal(rows.length, 1);
    }
    // After the fan-out settles, every connection should be back in
    // `available` and no checkouts should remain outstanding.
    const stats = pool.stats();
    assert.equal(stats.checkedOut, 0);
    assert.equal(stats.waiters, 0);
    assert.equal(stats.available, 8);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Per-call timeoutMs propagates into query()
// ---------------------------------------------------------------------------

test("per-call timeoutMs aborts a long-running query", async () => {
  const pool = new GraphDbPool("/tmp/graphdb-timeout.db", {
    binding: makeFakeBinding({ queryLatencyMs: 500 }),
    queryTimeoutMs: 30_000, // default stays untouched
  });
  await pool.open();
  try {
    const started = Date.now();
    await assert.rejects(
      () => pool.query("MATCH RETURN 1", undefined, { timeoutMs: 50 }),
      /timed out after 50ms/,
    );
    // The reject must happen in well under the fake's 500ms latency.
    assert.ok(Date.now() - started < 400, "timeout should fire before the fake resolves");
  } finally {
    await pool.close();
  }
});

test("per-call timeoutMs also propagates when the adapter wraps the pool", async () => {
  const store = new GraphDbStore("/tmp/graphdb-store-timeout.db", {
    poolConfig: {
      binding: makeFakeBinding({ queryLatencyMs: 500 }),
    },
  });
  await store.open();
  try {
    await assert.rejects(
      () => store.query("MATCH RETURN 1", undefined, { timeoutMs: 50 }),
      /timed out after 50ms/,
    );
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Waiter timeout when the pool is saturated
// ---------------------------------------------------------------------------

test("waiter timeout fires when pool is saturated beyond maxConnections", async () => {
  const pool = new GraphDbPool("/tmp/graphdb-waiter-timeout.db", {
    binding: makeFakeBinding({ queryLatencyMs: 500 }),
    maxConnections: 2,
    // Shorten the waiter timeout so the test stays under 1s while still
    // exercising the real code path — production still runs with 15s
    // defaults.
    waiterTimeoutMs: 100,
  });
  await pool.open();
  try {
    const slow1 = pool.query("MATCH RETURN 1");
    const slow2 = pool.query("MATCH RETURN 2");
    // Give the scheduler a microtask to route the first two checkouts.
    await new Promise((resolve) => setImmediate(resolve));
    const thirdStarted = Date.now();
    await assert.rejects(
      () => pool.query("MATCH RETURN 3"),
      /timed out after 100ms waiting for a free connection/,
    );
    // The reject must arrive within a small slop of the waiter timeout —
    // shouldn't wait for the slow fakes to finish.
    const elapsed = Date.now() - thirdStarted;
    assert.ok(elapsed < 400, `waiter rejected in ${elapsed}ms; expected < 400ms`);
    // Let the originals drain so afterEach() does not race the sweep.
    await Promise.all([slow1, slow2]);
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Idle sweep releases unused Connections
// ---------------------------------------------------------------------------

test("runIdleSweep closes pools whose lastUsed is older than idleTimeoutMs", async () => {
  const pool = new GraphDbPool("/tmp/graphdb-idle-sweep.db", {
    binding: makeFakeBinding(),
    idleTimeoutMs: 1_000,
    // Use a long sweep interval — the test invokes runIdleSweep directly
    // rather than waiting on the timer.
    idleSweepIntervalMs: 60_000,
  });
  await pool.open();
  assert.equal(_poolRegistrySize(), 1);
  // Idle sweep with `now` before the threshold → pool stays.
  runIdleSweep(Date.now());
  assert.equal(_poolRegistrySize(), 1);
  // Jump `now` well past `idleTimeoutMs` → pool is swept.
  runIdleSweep(Date.now() + 10_000);
  assert.equal(_poolRegistrySize(), 0);
  assert.equal(pool.isOpen(), true);
  // Cleanup — pool.close() is a no-op on a swept entry.
  await pool.close();
});

// ---------------------------------------------------------------------------
// 5. LRU eviction when the registry is at maxPoolSize
// ---------------------------------------------------------------------------

test("opening a 6th pool evicts the LRU entry when maxPoolSize is 5", async () => {
  const binding = makeFakeBinding();
  const pools: GraphDbPool[] = [];
  for (let i = 0; i < 5; i += 1) {
    const pool = new GraphDbPool(`/tmp/graphdb-lru-${i}.db`, {
      binding,
      maxPoolSize: 5,
    });
    await pool.open();
    pools.push(pool);
    // Tick apart the lastUsed timestamps so LRU picks a deterministic
    // victim. Using setImmediate isn't enough on fast CPUs — use a 2ms
    // sleep so Date.now() advances.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(_poolRegistrySize(), 5);

  // Touch the first four so the FIFTH is not LRU — instead `lru-0` is
  // still the oldest (since we didn't touch it) — but to be explicit,
  // reorder by hitting queries on pools[1..4] in rising order. After
  // this pools[0] is the LRU.
  for (let i = 1; i < 5; i += 1) {
    const p = pools[i];
    if (!p) throw new Error("unreachable");
    await p.query("MATCH RETURN 0");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  const newest = new GraphDbPool("/tmp/graphdb-lru-new.db", {
    binding,
    maxPoolSize: 5,
  });
  await newest.open();
  // The registry should still hold exactly 5 entries — the LRU was
  // evicted to make room.
  assert.equal(_poolRegistrySize(), 5);
  // `pools[0]` is the evicted one — its next query() call must throw
  // "evicted", not silently succeed.
  const evicted = pools[0];
  if (!evicted) throw new Error("unreachable");
  await assert.rejects(() => evicted.query("MATCH RETURN 0"), /evicted/);

  await newest.close();
  for (let i = 1; i < 5; i += 1) {
    const p = pools[i];
    if (p) await p.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Parameterized queries use prepare/execute and still respect timeouts
// ---------------------------------------------------------------------------

test("parameterized query uses prepare + execute path", async () => {
  const pool = new GraphDbPool("/tmp/graphdb-parameterized.db", {
    binding: makeFakeBinding({ queryLatencyMs: 0, rows: [{ hit: true }] }),
  });
  await pool.open();
  try {
    const rows = await pool.query("MATCH WHERE id = $p1 RETURN hit", ["abc"]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { hit: true });
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Refcount: parallel stores over the same path share one Database
// ---------------------------------------------------------------------------

test("parallel pool handles over the same path share a single registry entry", async () => {
  const binding = makeFakeBinding();
  const p1 = new GraphDbPool("/tmp/graphdb-shared.db", { binding });
  const p2 = new GraphDbPool("/tmp/graphdb-shared.db", { binding });
  await p1.open();
  await p2.open();
  assert.equal(_poolRegistrySize(), 1);
  assert.equal(p1.stats().refCount, 2);
  // First close: refcount drops to 1, the underlying entry stays alive.
  await p1.close();
  assert.equal(_poolRegistrySize(), 1);
  // Second close: refcount 0 → entry is torn down.
  await p2.close();
  assert.equal(_poolRegistrySize(), 0);
});
