/**
 * Connection-pool module for the graph-database backend — placeholder.
 *
 * AC-M3-2 (spec 004 §Acceptance criteria) fills this file with the real
 * pool implementation:
 *   - one process-wide read/write `Database` per store path,
 *   - a bounded pool of `Connection` objects on top of that database,
 *   - checkout/checkin queue semantics (MAX_CONNS_PER_REPO=8, 15s waiter
 *     timeout, 30s query timeout, 60s idle sweep),
 *   - one-query-per-connection invariant (spec 004 §W-M3-1).
 *
 * The placeholder exists so that `graphdb-adapter.ts` and future test
 * modules can reference the pool types without a phantom-import red line
 * during the scaffolding AC. It intentionally exports no runtime symbols —
 * only a typed interface marker — so a v2 rewrite in AC-M3-2 is free to
 * pick whichever concrete implementation suits the benchmark best.
 *
 * TODO(AC-M3-2): implement `GraphDbPool` with `acquire()` / `release()` and
 * wire it through `GraphDbStore.open()` / `close()`. Lift the checkout
 * queue from prior pool adapters (re-audited against the current
 * `@ladybugdb/core` API surface, not copied verbatim).
 */

/** Connection-pool handle placeholder — shape fixed in AC-M3-2. */
export interface GraphDbPool {
  /**
   * Reserved for AC-M3-2. The real implementation returns a connection
   * from the pool, queuing callers up to `waiterTimeoutMs` before
   * rejecting.
   */
  readonly placeholder?: never;
}
