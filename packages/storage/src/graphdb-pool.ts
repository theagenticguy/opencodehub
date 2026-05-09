/**
 * Connection pool for the graph-database backend.
 *
 * Design goals:
 *
 *   1. **Single-writer-multi-reader model.** One native `Database` per store
 *      path, with a bounded fan-out of `Connection` objects on top of it.
 *      Multiple `Connection`s from the same `Database` is the officially
 *      supported concurrency pattern of the underlying native binding.
 *
 *   2. **One query per Connection at a time.** The native binding segfaults
 *      when two `.query()` calls race against a single `Connection`. The
 *      pool enforces this invariant structurally: every `query()` call
 *      checks out a connection, runs exactly one statement, and checks it
 *      back in. Queries compete for connections, never for a single
 *      connection.
 *
 *   3. **Checkout queue with back-pressure.** When every connection is
 *      busy, callers queue; waiters timeout at `WAITER_TIMEOUT_MS` so a
 *      hung backend never leaks unbounded promises.
 *
 *   4. **Query timeout.** Each `query()` races against `QUERY_TIMEOUT_MS`
 *      so a stuck query releases its slot even if the native call never
 *      returns. Per-call `timeoutMs` overrides the default.
 *
 *   5. **Idle sweep + LRU eviction.** A single process-wide sweep runs
 *      every `IDLE_SWEEP_INTERVAL_MS`, closing pools whose last use was
 *      more than `IDLE_TIMEOUT_MS` ago and whose connections are all
 *      idle. The LRU pathway evicts the least-recently-used pool when
 *      the process-wide cap `MAX_POOL_SIZE` is reached.
 *
 * Adapted from prior-art (GitNexus `pool-adapter.ts`, 611 LOC):
 *
 *   - The GitNexus version multiplexes by `repoId`; this version keys the
 *     global registry by the resolved `dbPath` and exposes `GraphDbPool`
 *     as an instance object so `GraphDbStore.open()` / `.close()` can
 *     drive the lifecycle without a second name registry.
 *   - The GitNexus version silences stdout during connection creation to
 *     suppress native-module chatter on the MCP stdio channel. OCH uses a
 *     different process model for its stdio MCP (the MCP server logs go
 *     to stderr), so the watchdog is dropped. See §Anti-goals in the
 *     task packet.
 *   - Timing heuristics (`MAX_CONNS_PER_REPO=8`, waiter 15s, query 30s,
 *     idle 60s sweep + 5m timeout, pool cap 5) are preserved verbatim —
 *     they were battle-tested against the same native binding family.
 *   - `@ladybugdb/core@0.16.1` surface is byte-compatible with v0.15.2
 *     for the calls used here: `Database(path, bufferManagerSize,
 *     enableCompression, readOnly)`, `new Connection(db)`,
 *     `conn.query(stmt) → Promise<QueryResult | QueryResult[]>`,
 *     `result.getAll() → Promise<Record<string, unknown>[]>`. Prepared
 *     statements use `conn.prepare(stmt)` + `conn.execute(stmt, params)`.
 */

import type { SqlParam } from "./interface.js";

/**
 * Structural shape of a native `Database`. Keeping the interface
 * statically typed (rather than reaching for `any`) lets tests inject a
 * fake by duck-typing.
 */
export interface NativeDatabase {
  close(): Promise<void>;
}

/**
 * Structural shape of a native `Connection`. Typed to what the pool
 * actually calls — `query()` + `prepare()` + `execute()` + `close()`.
 */
export interface NativeConnection {
  query(stmt: string): Promise<NativeQueryResult | NativeQueryResult[]>;
  prepare(stmt: string): Promise<NativePreparedStatement>;
  execute(
    stmt: NativePreparedStatement,
    params?: Record<string, unknown>,
  ): Promise<NativeQueryResult | NativeQueryResult[]>;
  close(): Promise<void>;
}

export interface NativeQueryResult {
  getAll(): Promise<Record<string, unknown>[]>;
  close?(): void;
}

export interface NativePreparedStatement {
  isSuccess(): boolean;
  getErrorMessage(): string;
}

/**
 * Structural shape of the `@ladybugdb/core` default export used by the
 * pool. Injected so tests can swap in fakes without loading the native
 * binding.
 */
export interface NativeBinding {
  Database: new (
    path: string,
    bufferManagerSize?: number,
    enableCompression?: boolean,
    readOnly?: boolean,
  ) => NativeDatabase;
  Connection: new (db: NativeDatabase) => NativeConnection;
}

export interface GraphDbPoolConfig {
  /** Max connections held per database file. Default 8. */
  readonly maxConnections?: number;
  /** Global cap on number of distinct pools kept alive. Default 5. */
  readonly maxPoolSize?: number;
  /** Milliseconds a checkout waiter can block before rejecting. Default 15000. */
  readonly waiterTimeoutMs?: number;
  /** Default milliseconds a single query may run before aborting. Default 30000. */
  readonly queryTimeoutMs?: number;
  /** Milliseconds of idleness before a pool is eligible for closure. Default 300000 (5 min). */
  readonly idleTimeoutMs?: number;
  /** How often the idle sweep runs. Default 60000 (60 s). */
  readonly idleSweepIntervalMs?: number;
  /** Open the database read-only. Default false. */
  readonly readOnly?: boolean;
  /**
   * Injected native binding. Defaults to `require("@ladybugdb/core")`
   * via dynamic import on first `open()`. Tests inject a fake.
   */
  readonly binding?: NativeBinding;
}

/** Defaults preserved from prior-art; changing these is a documented deviation. */
export const DEFAULT_MAX_CONNECTIONS = 8;
export const DEFAULT_MAX_POOL_SIZE = 5;
export const DEFAULT_WAITER_TIMEOUT_MS = 15_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;

interface Waiter {
  readonly resolve: (conn: NativeConnection) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Process-wide registry. Keyed by resolved dbPath so parallel `GraphDbStore`
 * instances pointing at the same file share one native `Database` and a
 * single connection pool. Refcounted: the last `close()` against a shared
 * path tears the native resources down.
 */
interface RegistryEntry {
  readonly db: NativeDatabase;
  readonly connections: NativeConnection[];
  readonly available: NativeConnection[];
  readonly waiters: Waiter[];
  readonly path: string;
  readonly config: ResolvedPoolConfig;
  refCount: number;
  checkedOut: number;
  lastUsed: number;
  closed: boolean;
}

type ResolvedPoolConfig = Required<Omit<GraphDbPoolConfig, "binding">> & {
  binding?: NativeBinding;
};

const registry = new Map<string, RegistryEntry>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let activeSweepIntervalMs: number | null = null;

// ---------------------------------------------------------------------------
// Idle sweep + LRU eviction
// ---------------------------------------------------------------------------

function ensureSweepTimer(intervalMs: number): void {
  if (sweepTimer && activeSweepIntervalMs === intervalMs) return;
  if (sweepTimer) {
    clearInterval(sweepTimer);
  }
  activeSweepIntervalMs = intervalMs;
  sweepTimer = setInterval(() => {
    runIdleSweep(Date.now());
  }, intervalMs);
  if (typeof (sweepTimer as { unref?: () => unknown }).unref === "function") {
    (sweepTimer as { unref: () => unknown }).unref();
  }
}

/**
 * Scan every registered pool and close those whose last use was more
 * than `idleTimeoutMs` ago with no outstanding checkouts. Exposed for
 * tests which inject a frozen clock.
 */
export function runIdleSweep(now: number = Date.now()): void {
  for (const [path, entry] of registry) {
    if (entry.closed) continue;
    if (entry.checkedOut !== 0) continue;
    if (now - entry.lastUsed < entry.config.idleTimeoutMs) continue;
    closeEntry(path);
  }
}

function evictLruIfNeeded(maxPoolSize: number, nextPath: string): void {
  const activeCount = [...registry.keys()].filter((p) => p !== nextPath).length;
  if (activeCount < maxPoolSize) return;
  let oldestPath: string | null = null;
  let oldest = Number.POSITIVE_INFINITY;
  for (const [path, entry] of registry) {
    if (path === nextPath) continue;
    if (entry.checkedOut !== 0) continue;
    if (entry.lastUsed < oldest) {
      oldest = entry.lastUsed;
      oldestPath = path;
    }
  }
  if (oldestPath) closeEntry(oldestPath);
}

function closeEntry(path: string): void {
  const entry = registry.get(path);
  if (!entry) return;
  entry.closed = true;
  for (const conn of entry.available) {
    conn.close().catch(() => {});
  }
  entry.available.length = 0;
  entry.connections.length = 0;
  for (const waiter of entry.waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`GraphDbPool for ${path} closed while waiting for a connection`));
  }
  entry.waiters.length = 0;
  entry.db.close().catch(() => {});
  registry.delete(path);
  if (registry.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    activeSweepIntervalMs = null;
  }
}

// ---------------------------------------------------------------------------
// Binding loader
// ---------------------------------------------------------------------------

async function loadDefaultBinding(): Promise<NativeBinding> {
  // Dynamic import keeps the native dep off the startup path when the
  // DuckDB backend is in use. The cast passes through `unknown` because
  // the native binding's typed surface is richer than the structural
  // shape this module uses — we only require `{ Database, Connection }`
  // constructors, nothing more.
  const mod = (await import("@ladybugdb/core")) as unknown as {
    default?: NativeBinding;
  } & NativeBinding;
  return mod.default ?? mod;
}

// ---------------------------------------------------------------------------
// GraphDbPool
// ---------------------------------------------------------------------------

/**
 * Pool handle. One instance per `GraphDbStore`; multiple instances over
 * the same path share the underlying native `Database` via the process
 * registry.
 */
export class GraphDbPool {
  private readonly path: string;
  private readonly config: ResolvedPoolConfig;
  private opened = false;
  private closed = false;

  constructor(path: string, config: GraphDbPoolConfig = {}) {
    this.path = path;
    const resolved: ResolvedPoolConfig = {
      maxConnections: config.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      maxPoolSize: config.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE,
      waiterTimeoutMs: config.waiterTimeoutMs ?? DEFAULT_WAITER_TIMEOUT_MS,
      queryTimeoutMs: config.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      idleSweepIntervalMs: config.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS,
      readOnly: config.readOnly ?? false,
    };
    // `exactOptionalPropertyTypes` refuses explicit `undefined` on an
    // optional property — only omit-or-assign-value is allowed.
    if (config.binding !== undefined) {
      resolved.binding = config.binding;
    }
    this.config = resolved;
  }

  /**
   * Open (or re-use) the underlying `Database` and pre-warm connections.
   * Idempotent on the instance level. The registry refcount tracks
   * multiple stores over the same path.
   */
  async open(): Promise<void> {
    if (this.opened) return;
    if (this.closed) {
      throw new Error(`GraphDbPool for ${this.path} has already been closed`);
    }

    const binding = this.config.binding ?? (await loadDefaultBinding());

    let entry = registry.get(this.path);
    if (!entry) {
      evictLruIfNeeded(this.config.maxPoolSize, this.path);
      const db = new binding.Database(
        this.path,
        0, // bufferManagerSize — 0 means default
        false, // enableCompression — default
        this.config.readOnly,
      );
      const connections: NativeConnection[] = [];
      for (let i = 0; i < this.config.maxConnections; i += 1) {
        connections.push(new binding.Connection(db));
      }
      entry = {
        db,
        connections,
        available: [...connections],
        waiters: [],
        path: this.path,
        config: this.config,
        refCount: 0,
        checkedOut: 0,
        lastUsed: Date.now(),
        closed: false,
      };
      registry.set(this.path, entry);
      ensureSweepTimer(this.config.idleSweepIntervalMs);
    }
    entry.refCount += 1;
    entry.lastUsed = Date.now();
    this.opened = true;
  }

  /**
   * Release the pool's refcount. The underlying `Database` is torn down
   * only when the last holder closes. Idempotent.
   */
  async close(): Promise<void> {
    if (!this.opened || this.closed) {
      this.closed = true;
      return;
    }
    this.closed = true;
    const entry = registry.get(this.path);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      closeEntry(this.path);
    }
  }

  /**
   * Execute a read-only statement. The pool checks out a connection,
   * runs the query under `timeoutMs`, and returns the parsed rows.
   */
  async query(
    stmt: string,
    params?: readonly SqlParam[],
    opts?: { readonly timeoutMs?: number },
  ): Promise<Record<string, unknown>[]> {
    const entry = this.requireEntry();
    entry.lastUsed = Date.now();
    const timeoutMs = opts?.timeoutMs ?? entry.config.queryTimeoutMs;
    const conn = await this.acquire(entry);
    try {
      const exec =
        params && params.length > 0
          ? this.runParameterized(conn, stmt, params, timeoutMs)
          : this.runDirect(conn, stmt, timeoutMs);
      return await exec;
    } finally {
      this.release(entry, conn);
    }
  }

  /**
   * Acquire a connection. Exposed for callers (e.g. bulk-load paths)
   * that need to hold a connection across multiple statements.
   * Remember to `release()` in `finally`.
   */
  async acquire(entry: RegistryEntry = this.requireEntry()): Promise<NativeConnection> {
    entry.lastUsed = Date.now();
    if (entry.available.length > 0) {
      entry.checkedOut += 1;
      return entry.available.pop() as NativeConnection;
    }
    if (entry.checkedOut < entry.config.maxConnections) {
      // Should never happen — pool is pre-warmed to maxConnections.
      // Defensive: surface the leak rather than silently creating one
      // (which would desync the `available`/`checkedOut` accounting).
      throw new Error(
        `GraphDbPool integrity error: expected ${entry.config.maxConnections} ` +
          `connections but found ${entry.connections.length} ` +
          `(${entry.available.length} available, ${entry.checkedOut} checked out)`,
      );
    }
    return await new Promise<NativeConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = entry.waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) entry.waiters.splice(idx, 1);
        reject(
          new Error(
            `GraphDbPool exhausted: timed out after ${entry.config.waiterTimeoutMs}ms ` +
              `waiting for a free connection`,
          ),
        );
      }, entry.config.waiterTimeoutMs);
      if (typeof (timer as { unref?: () => unknown }).unref === "function") {
        (timer as { unref: () => unknown }).unref();
      }
      entry.waiters.push({ resolve, reject, timer });
    });
  }

  /**
   * Return a connection to the pool. If a waiter is queued, hand the
   * connection straight over rather than bouncing through `available`.
   */
  release(entry: RegistryEntry, conn: NativeConnection): void {
    if (entry.closed) {
      // Pool closed while the caller was mid-query — drop the connection.
      conn.close().catch(() => {});
      return;
    }
    if (entry.waiters.length > 0) {
      const next = entry.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(conn);
        return;
      }
    }
    entry.checkedOut -= 1;
    entry.available.push(conn);
  }

  /** Inspect current queue sizes — used by tests and diagnostics. */
  stats(): { available: number; checkedOut: number; waiters: number; refCount: number } {
    const entry = registry.get(this.path);
    if (!entry) {
      return { available: 0, checkedOut: 0, waiters: 0, refCount: 0 };
    }
    return {
      available: entry.available.length,
      checkedOut: entry.checkedOut,
      waiters: entry.waiters.length,
      refCount: entry.refCount,
    };
  }

  isOpen(): boolean {
    return this.opened && !this.closed;
  }

  private requireEntry(): RegistryEntry {
    if (!this.opened || this.closed) {
      throw new Error(`GraphDbPool for ${this.path} is not open`);
    }
    const entry = registry.get(this.path);
    if (!entry || entry.closed) {
      throw new Error(`GraphDbPool for ${this.path} has been evicted`);
    }
    return entry;
  }

  private async runDirect(
    conn: NativeConnection,
    stmt: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>[]> {
    const queryPromise = conn.query(stmt).then(async (res) => {
      const result = Array.isArray(res) ? res[0] : res;
      if (!result) return [] as Record<string, unknown>[];
      return await result.getAll();
    });
    return await raceWithTimeout(queryPromise, timeoutMs, "query");
  }

  private async runParameterized(
    conn: NativeConnection,
    stmt: string,
    params: readonly SqlParam[],
    timeoutMs: number,
  ): Promise<Record<string, unknown>[]> {
    // Parameterized queries use prepared statements with positional
    // binding names `p1..pN`. The caller passes the template with those
    // same names (`WHERE id = $p1`); we wrap the array so callers don't
    // have to hand-build the record.
    const paramRecord: Record<string, unknown> = {};
    for (let i = 0; i < params.length; i += 1) {
      paramRecord[`p${i + 1}`] = params[i] as unknown;
    }
    const work = (async () => {
      const prepared = await conn.prepare(stmt);
      if (!prepared.isSuccess()) {
        throw new Error(`GraphDbPool prepare failed: ${prepared.getErrorMessage()}`);
      }
      const res = await conn.execute(prepared, paramRecord);
      const result = Array.isArray(res) ? res[0] : res;
      if (!result) return [] as Record<string, unknown>[];
      return await result.getAll();
    })();
    return await raceWithTimeout(work, timeoutMs, "query");
  }
}

/**
 * Race `promise` against a timeout. On timeout the returned promise
 * rejects, but the underlying work is NOT cancelled — the native layer
 * owns that contract.
 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer && typeof (timer as { unref?: () => unknown }).unref === "function") {
      (timer as { unref: () => unknown }).unref();
    }
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------
// Test helpers — not part of the public surface. Exposed so the concurrency
// suite can inspect internal state without reaching through `any`.
// ---------------------------------------------------------------------------

/** Number of live pools in the process-wide registry. */
export function _poolRegistrySize(): number {
  return registry.size;
}

/** Force-close every pool and stop the sweep timer. Used in test teardown. */
export function _resetPoolRegistry(): void {
  for (const path of [...registry.keys()]) {
    closeEntry(path);
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    activeSweepIntervalMs = null;
  }
}
