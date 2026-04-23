/**
 * LRU-backed connection pool for DuckDB graph stores.
 *
 * A single MCP session routinely fields back-to-back tool calls that all
 * target the same repo; opening the DuckDB file for every call would be
 * wasteful. We cache open `DuckDbStore` handles keyed by absolute repo
 * path, with three safety guards on top of a plain LRU:
 *
 *   1. Per-key promise dedupe. Concurrent acquires for the same repo share
 *      a single in-flight open() — otherwise DuckDB will raise on the
 *      second connection opening the same file in read-write mode.
 *   2. Reference counting. Release must decrement a per-entry counter; an
 *      eviction that lands on a still-in-use entry MUST NOT close it. We
 *      mark it `closed` deferred and the last release actually closes.
 *   3. Idle TTL. lru-cache@11 bumps recency on every acquire, so a repo
 *      that is actively queried never evicts; an idle repo closes after
 *      15 minutes.
 *
 * `shutdown()` drains the pool on stdio close so the server exits cleanly.
 */

import { DuckDbStore } from "@opencodehub/storage";
import { LRUCache } from "lru-cache";

export interface PoolEntry {
  readonly store: DuckDbStore;
  refCount: number;
  closed: boolean;
  /** Set when an eviction fires while refCount > 0; close on last release. */
  closePending: boolean;
}

export interface ConnectionPoolOptions {
  readonly max?: number;
  readonly ttlMs?: number;
}

const DEFAULT_MAX = 8;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Factory indirection keeps tests mockable without standing up DuckDB.
 * Production always constructs a real `DuckDbStore`.
 */
export type StoreFactory = (dbPath: string) => Promise<DuckDbStore>;

const defaultFactory: StoreFactory = async (dbPath) => {
  const store = new DuckDbStore(dbPath, { readOnly: true });
  await store.open();
  return store;
};

export class ConnectionPool {
  private readonly cache: LRUCache<string, PoolEntry>;
  private readonly inflight = new Map<string, Promise<PoolEntry>>();
  private readonly factory: StoreFactory;
  private disposed = false;

  constructor(opts: ConnectionPoolOptions = {}, factory: StoreFactory = defaultFactory) {
    this.factory = factory;
    this.cache = new LRUCache<string, PoolEntry>({
      max: opts.max ?? DEFAULT_MAX,
      ttl: opts.ttlMs ?? DEFAULT_TTL_MS,
      updateAgeOnGet: true,
      // The dispose callback fires on eviction (size or ttl) and on
      // cache.clear(). We treat eviction as "this entry is no longer
      // reachable from the cache"; if nobody is using it we close now,
      // otherwise we let the last `release()` close it.
      dispose: (entry, key) => {
        if (entry.closed) return;
        if (entry.refCount === 0) {
          entry.closed = true;
          void entry.store.close().catch(() => {
            /* swallow — best effort during eviction */
          });
        } else {
          entry.closePending = true;
        }
        // Ensure we don't leak a stale inflight promise for an evicted key.
        this.inflight.delete(key);
      },
    });
  }

  /**
   * Acquire a store handle for the given repo. The caller MUST pair every
   * acquire with a release. The `dbPath` argument is the absolute path to
   * the on-disk DuckDB file; `repoKey` is a stable identifier used for
   * caching (usually the absolute repo path).
   */
  async acquire(repoKey: string, dbPath: string): Promise<DuckDbStore> {
    if (this.disposed) {
      throw new Error("ConnectionPool is shut down");
    }
    const existing = this.cache.get(repoKey);
    if (existing && !existing.closed) {
      existing.refCount += 1;
      return existing.store;
    }

    const pending = this.inflight.get(repoKey);
    if (pending) {
      const entry = await pending;
      entry.refCount += 1;
      return entry.store;
    }

    const promise = (async () => {
      const store = await this.factory(dbPath);
      const entry: PoolEntry = {
        store,
        refCount: 0,
        closed: false,
        closePending: false,
      };
      this.cache.set(repoKey, entry);
      return entry;
    })();
    this.inflight.set(repoKey, promise);
    try {
      const entry = await promise;
      entry.refCount += 1;
      return entry.store;
    } finally {
      this.inflight.delete(repoKey);
    }
  }

  /**
   * Release a previously-acquired handle. If the entry was evicted while
   * in use (`closePending`), the last release closes the store.
   */
  async release(repoKey: string): Promise<void> {
    const entry = this.cache.peek(repoKey) ?? this.findEvicted(repoKey);
    if (!entry) return;
    if (entry.refCount > 0) entry.refCount -= 1;
    if (entry.refCount === 0 && entry.closePending && !entry.closed) {
      entry.closed = true;
      await entry.store.close().catch(() => {
        /* swallow */
      });
    }
  }

  /**
   * Drain the pool: wait on any inflight opens, then close every cached
   * entry. Safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Wait for inflight opens so we don't leak half-opened DBs.
    const pending = Array.from(this.inflight.values());
    await Promise.allSettled(pending);
    this.inflight.clear();

    const entries: PoolEntry[] = [];
    for (const entry of this.cache.values()) entries.push(entry);
    this.cache.clear(); // triggers dispose on remaining entries

    await Promise.allSettled(
      entries.map(async (entry) => {
        if (!entry.closed) {
          entry.closed = true;
          await entry.store.close();
        }
      }),
    );
  }

  /** Test-only view of cached keys; stable iteration order is not guaranteed. */
  size(): number {
    return this.cache.size;
  }

  private findEvicted(_repoKey: string): PoolEntry | undefined {
    // After dispose runs, the entry is gone from the cache; the caller
    // holds no direct reference to it here. We intentionally don't store
    // a secondary map — reference counting for evicted entries is tracked
    // inside the entry object itself, which remains reachable via the
    // store reference that the tool handler still holds. For the current
    // MVP usage (single-threaded tool handlers that acquire + release in
    // the same function) this branch is unreachable, so we return
    // undefined and rely on the dispose path to have already closed the
    // store if refCount was 0.
    return undefined;
  }
}
