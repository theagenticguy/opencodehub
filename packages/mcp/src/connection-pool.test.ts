import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Store } from "@opencodehub/storage";
import { ConnectionPool } from "./connection-pool.js";

/**
 * Fake store with just enough surface for the pool to exercise acquire
 * / release / shutdown semantics without standing up the underlying
 * databases. Mirrors the `OpenStoreResult.close()` contract.
 */
function makeFakeStore(path: string): {
  store: Store;
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
  } as unknown as Store;
  return { store, isClosed: () => closed, closeCount: () => closeCalls };
}

test("acquire opens once, reuses on subsequent acquires", async () => {
  let factoryCalls = 0;
  const pool = new ConnectionPool({ max: 4, ttlMs: 10_000 }, async (p) => {
    factoryCalls += 1;
    return makeFakeStore(p).store;
  });
  try {
    const a = await pool.acquire("repoA", "/a.sqlite");
    const b = await pool.acquire("repoA", "/a.sqlite");
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
      pool.acquire("repoX", "/x.sqlite"),
      pool.acquire("repoX", "/x.sqlite"),
      pool.acquire("repoX", "/x.sqlite"),
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
    await pool.acquire("a", "/a.sqlite");
    await pool.release("a");
    await pool.acquire("b", "/b.sqlite");
    await pool.release("b");
    await pool.acquire("c", "/c.sqlite");
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
  await pool.acquire("r1", "/r1.sqlite");
  await pool.release("r1");
  await pool.acquire("r2", "/r2.sqlite");
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
  await assert.rejects(() => pool.acquire("x", "/x.sqlite"), /shut down/);
});

test("eviction of an in-use entry defers close to the last release", async () => {
  const probes = new Map<string, ReturnType<typeof makeFakeStore>>();
  const pool = new ConnectionPool({ max: 2, ttlMs: 10_000 }, async (p) => {
    const probe = makeFakeStore(p);
    probes.set(p, probe);
    return probe.store;
  });
  try {
    // Hold three distinct repos in flight at once with max=2 so the LRU
    // evicts the least-recently-used ("a") WHILE it is still referenced.
    await pool.acquire("a", "/a.sqlite");
    await pool.acquire("b", "/b.sqlite");
    await pool.acquire("c", "/c.sqlite"); // evicts "a" (refCount 1)

    await new Promise((resolve) => setImmediate(resolve));
    // The evicted entry is still in use — it MUST NOT be closed yet, or the
    // tool still holding the handle would see a closed store mid-call.
    assert.equal(
      probes.get("/a.sqlite")?.isClosed(),
      false,
      "evicted-but-in-use store must stay open until its last release",
    );

    // The last release of the evicted key runs the deferred close — this is
    // the path that was previously unreachable (findEvicted returned
    // undefined), leaking the handle.
    await pool.release("a");
    assert.equal(
      probes.get("/a.sqlite")?.isClosed(),
      true,
      "last release of an evicted entry must close the store",
    );
    assert.equal(probes.get("/a.sqlite")?.closeCount(), 1, "store must close exactly once");

    await pool.release("b");
    await pool.release("c");
  } finally {
    await pool.shutdown();
  }
});

test("shutdown closes entries evicted while still in use", async () => {
  const probes = new Map<string, ReturnType<typeof makeFakeStore>>();
  const pool = new ConnectionPool({ max: 2, ttlMs: 10_000 }, async (p) => {
    const probe = makeFakeStore(p);
    probes.set(p, probe);
    return probe.store;
  });
  // Overflow so "a" is evicted while refCount > 0, then shut down before any
  // release. The parked side-table entry must still be drained.
  await pool.acquire("a", "/a.sqlite");
  await pool.acquire("b", "/b.sqlite");
  await pool.acquire("c", "/c.sqlite"); // evicts "a" (refCount 1, parked)

  await pool.shutdown();
  assert.equal(
    probes.get("/a.sqlite")?.isClosed(),
    true,
    "shutdown must close a still-referenced evicted entry",
  );
  assert.equal(probes.get("/a.sqlite")?.closeCount(), 1, "store must close exactly once");
});
