/**
 * LRU-backed connection pool for graph stores.
 *
 * A single MCP session routinely fields back-to-back tool calls that all
 * target the same repo; opening the underlying database for every call
 * would be wasteful. We cache open `Store` (= `OpenStoreResult`) handles
 * keyed by absolute repo path, with three safety guards on top of a plain
 * LRU:
 *
 *   1. Per-key promise dedupe. Concurrent acquires for the same repo share
 *      a single in-flight open() — so the WAL-mode `store.sqlite` file is
 *      opened once per repo rather than racing multiple handles.
 *   2. Reference counting. Release must decrement a per-entry counter; an
 *      eviction that lands on a still-in-use entry MUST NOT close it. We
 *      set `closePending` and park the entry in a side table (it has left
 *      the cache, so `release` can no longer find it via the cache) so the
 *      last release actually closes it.
 *   3. Idle TTL. lru-cache@11 bumps recency on every acquire, so a repo
 *      that is actively queried never evicts; an idle repo closes after
 *      15 minutes.
 *
 * `shutdown()` drains the pool on stdio close so the server exits cleanly.
 *
 * The pool caches the composed `OpenStoreResult` so MCP tools can route
 * graph-tier calls through `store.graph` and temporal-tier calls
 * (cochanges, summaries, `--sql` escape hatch) through `store.temporal`.
 * Post-ADR 0019 both views are the SAME `SqliteStore` over one
 * `<repo>/.codehub/store.sqlite` file. `OpenStoreResult.close()` is the
 * deterministic composite close — it releases that single handle once.
 */

import { openStore, type Store } from "@opencodehub/storage";
import { LRUCache } from "lru-cache";

export interface PoolEntry {
  readonly store: Store;
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
 * Factory indirection keeps tests mockable without standing up the
 * underlying database. Production always calls `openStore`, which returns
 * one `SqliteStore` as both the graph and temporal views over the single
 * `<repo>/.codehub/store.sqlite` file.
 */
export type StoreFactory = (dbPath: string) => Promise<Store>;

const defaultFactory: StoreFactory = async (dbPath) => {
  // openStore serves graph + temporal from one SqliteStore over the
  // shared `<repo>/.codehub/store.sqlite`. We open read-only because every
  // MCP tool is a reader; the ingestion pipeline owns writes and runs
  // out-of-process.
  const store = await openStore({ path: dbPath, readOnly: true });
  await store.graph.open();
  await store.temporal.open();
  return store;
};

export class ConnectionPool {
  private readonly cache: LRUCache<string, PoolEntry>;
  private readonly inflight = new Map<string, Promise<PoolEntry>>();
  /**
   * Entries evicted from the LRU while still in use (`refCount > 0`). Once
   * `dispose` removes a key from the cache, `cache.peek` can no longer find
   * it, so without this side table the deferred-close path in `release`
   * would be unreachable and the still-open store would leak. We park the
   * entry here, look it up from `release`, and drain it once the last
   * reference is returned and the store is closed.
   */
  private readonly evicted = new Map<string, PoolEntry>();
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
          // Still in use: defer the close to the last `release`. Park the
          // entry so `release` can find it after it leaves the cache.
          entry.closePending = true;
          this.evicted.set(key, entry);
        }
        // Ensure we don't leak a stale inflight promise for an evicted key.
        this.inflight.delete(key);
      },
    });
  }

  /**
   * Acquire a store handle for the given repo. The caller MUST pair every
   * acquire with a release. The `dbPath` argument is the absolute path to
   * the on-disk store.sqlite file; `repoKey` is a stable identifier used for
   * caching (usually the absolute repo path).
   */
  async acquire(repoKey: string, dbPath: string): Promise<Store> {
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
      // The entry left the cache on eviction; once closed it must also leave
      // the evicted side table so we don't retain the handle forever.
      this.evicted.delete(repoKey);
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
    // Include entries that were evicted while in use: they live in the
    // side table, not the cache, so the loop above would miss them and
    // leave their stores open. The `closed` guard below dedupes.
    for (const entry of this.evicted.values()) entries.push(entry);
    this.evicted.clear();

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

  private findEvicted(repoKey: string): PoolEntry | undefined {
    // After dispose runs on a still-in-use entry, the key is gone from the
    // cache so `cache.peek` returns undefined. The entry was parked in the
    // `evicted` side table; return it so `release` can run the deferred
    // close once the last reference comes back. Concurrent tool calls can
    // hold > poolMax distinct repos in flight at once, so this path is
    // reachable in practice — not just the single-threaded acquire/release
    // case.
    return this.evicted.get(repoKey);
  }
}
