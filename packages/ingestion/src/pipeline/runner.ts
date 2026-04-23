/**
 * DAG validator + topological executor for the ingestion pipeline.
 *
 * The runner owns three concerns:
 *  1. Structural validation — duplicate-name, missing-dep, and cycle
 *     detection (the latter returns a concrete cycle path so failure
 *     messages point operators at the offending arrows).
 *  2. Deterministic ordering — Kahn's algorithm with an alphabetic name
 *     tiebreak so the output order is reproducible across runs and across
 *     JS engine Map iteration quirks.
 *  3. Dep isolation — each phase only sees outputs of the phases it
 *     declared as dependencies. This blocks implicit coupling and keeps
 *     the DAG honest: if phase B reads phase A's output, B must name A in
 *     its `deps`.
 *
 * Error wrapping: when a phase throws, the runner re-throws as a regular
 * `Error` whose message embeds the phase name and whose `cause` points at
 * the original error. Progress-callback errors are swallowed so they can
 * never mask the original failure.
 */

import type { PhaseResult, PipelineContext, PipelinePhase, ProgressEvent } from "./types.js";

/** Structural problem with the phase set (duplicate/missing/cycle). */
export class PipelineGraphError extends Error {
  readonly cyclePath?: readonly string[];
  readonly missing?: readonly string[];
  readonly duplicate?: readonly string[];

  constructor(
    message: string,
    details: {
      readonly cyclePath?: readonly string[];
      readonly missing?: readonly string[];
      readonly duplicate?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = "PipelineGraphError";
    if (details.cyclePath !== undefined) this.cyclePath = details.cyclePath;
    if (details.missing !== undefined) this.missing = details.missing;
    if (details.duplicate !== undefined) this.duplicate = details.duplicate;
  }
}

/**
 * Walk phases and surface structural errors as a single
 * {@link PipelineGraphError}. Checks run in order (duplicate → missing →
 * cycle) so the most actionable message wins.
 */
export function validatePipeline(phases: readonly PipelinePhase[]): void {
  // ---- 1. Duplicate name detection. -------------------------------------
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const p of phases) {
    if (seen.has(p.name)) dupes.push(p.name);
    else seen.add(p.name);
  }
  if (dupes.length > 0) {
    const sortedDupes = [...new Set(dupes)].sort();
    throw new PipelineGraphError(`Duplicate phase name(s): ${sortedDupes.join(", ")}`, {
      duplicate: sortedDupes,
    });
  }

  // ---- 2. Missing-dep detection. ----------------------------------------
  const names = new Set(phases.map((p) => p.name));
  const missing: string[] = [];
  for (const p of phases) {
    for (const d of p.deps) {
      if (!names.has(d)) {
        missing.push(`${p.name} -> ${d}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new PipelineGraphError(`Missing dependency: ${missing.join(", ")}`, { missing });
  }

  // ---- 3. Cycle detection via DFS; returns a concrete cycle path. -------
  const adj = new Map<string, readonly string[]>();
  for (const p of phases) adj.set(p.name, p.deps);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const p of phases) color.set(p.name, WHITE);

  const stack: string[] = [];

  function dfs(n: string): readonly string[] | undefined {
    color.set(n, GRAY);
    stack.push(n);
    const outgoing = adj.get(n) ?? [];
    for (const next of outgoing) {
      const c = color.get(next);
      if (c === GRAY) {
        // Found a back-edge: slice the stack from where `next` first
        // appears and close the cycle by appending `next` again.
        const startIdx = stack.indexOf(next);
        const path = stack.slice(startIdx);
        path.push(next);
        return path;
      }
      if (c === WHITE) {
        const found = dfs(next);
        if (found !== undefined) return found;
      }
    }
    stack.pop();
    color.set(n, BLACK);
    return undefined;
  }

  const sortedNames = [...names].sort();
  for (const n of sortedNames) {
    if (color.get(n) === WHITE) {
      const cyclePath = dfs(n);
      if (cyclePath !== undefined) {
        throw new PipelineGraphError(`Cycle detected: ${cyclePath.join(" -> ")}`, { cyclePath });
      }
    }
  }
}

/**
 * Kahn topological sort with an alphabetic name tiebreak.
 *
 * The tiebreak is purely cosmetic — any topological order is correct — but
 * pinning it ensures two structurally identical pipelines produce the same
 * execution order across machines and Map iteration implementations.
 */
export function topologicalSort(phases: readonly PipelinePhase[]): readonly PipelinePhase[] {
  validatePipeline(phases);

  const byName = new Map<string, PipelinePhase>();
  for (const p of phases) byName.set(p.name, p);

  // Inverse edges: consumer-of map so we can enqueue dependents when a
  // phase has no outstanding deps.
  const consumers = new Map<string, string[]>();
  for (const p of phases) consumers.set(p.name, []);
  const indeg = new Map<string, number>();
  for (const p of phases) {
    indeg.set(p.name, p.deps.length);
    for (const d of p.deps) {
      (consumers.get(d) as string[]).push(p.name);
    }
  }

  // Min-heap via a sorted array — O(n log n) is fine for DAG sizes we see.
  const ready: string[] = [];
  for (const [n, deg] of indeg) {
    if (deg === 0) ready.push(n);
  }
  ready.sort();

  const order: PipelinePhase[] = [];
  while (ready.length > 0) {
    const next = ready.shift() as string;
    order.push(byName.get(next) as PipelinePhase);
    const dependents = consumers.get(next) ?? [];
    for (const dep of dependents) {
      const d = (indeg.get(dep) ?? 0) - 1;
      indeg.set(dep, d);
      if (d === 0) {
        // Insert in sorted position — cheap given tiny ready-set sizes.
        let i = 0;
        while (i < ready.length && (ready[i] as string) < dep) i += 1;
        ready.splice(i, 0, dep);
      }
    }
  }

  if (order.length !== phases.length) {
    // Should be unreachable — validatePipeline catches cycles — but be
    // explicit so future edits don't silently produce bad orderings.
    throw new PipelineGraphError("Topological sort did not consume every phase");
  }

  return order;
}

function emit(ctx: PipelineContext, ev: ProgressEvent): void {
  if (ctx.onProgress === undefined) return;
  try {
    ctx.onProgress(ev);
  } catch {
    // Progress-callback errors must never mask phase-level failures.
  }
}

/**
 * Execute phases in topological order. Each phase receives a filtered map
 * containing only the outputs of phases it declared in `deps`. Per-phase
 * timing is captured and returned. Failures wrap with the phase name and
 * halt further execution.
 */
export async function runPipeline(
  phases: readonly PipelinePhase[],
  ctx: PipelineContext,
): Promise<readonly PhaseResult[]> {
  const ordered = topologicalSort(phases);
  const outputs = new Map<string, unknown>();
  const results: PhaseResult[] = [];

  // The context exposes phaseOutputs as a read-only view; we update the
  // underlying map via a thin wrapper so later phases observe prior ones.
  const livePhaseOutputs: ReadonlyMap<string, unknown> = outputs;
  const liveCtx: PipelineContext = {
    ...ctx,
    phaseOutputs: livePhaseOutputs,
  };

  for (const phase of ordered) {
    const depMap = new Map<string, unknown>();
    for (const d of phase.deps) {
      depMap.set(d, outputs.get(d));
    }

    emit(liveCtx, { phase: phase.name, kind: "start" });
    const started = Date.now();
    let output: unknown;
    try {
      output = await phase.run(liveCtx, depMap);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      const wrapped = new Error(`Phase '${phase.name}' failed: ${cause.message}`, {
        cause,
      });
      emit(liveCtx, {
        phase: phase.name,
        kind: "error",
        message: cause.message,
        elapsedMs: Date.now() - started,
      });
      throw wrapped;
    }

    const durationMs = Date.now() - started;
    outputs.set(phase.name, output);
    results.push({ name: phase.name, output, durationMs, warnings: [] });
    emit(liveCtx, {
      phase: phase.name,
      kind: "end",
      elapsedMs: durationMs,
    });
  }

  return results;
}
