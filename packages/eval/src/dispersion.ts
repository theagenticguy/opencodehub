/**
 * Dispersion statistics — the per-arm "how much did the answer wander" numbers
 * (spec 010 §2). Pure functions over an arm's N outcomes; no I/O, no clock.
 * These are the most safety-critical part of the probe, so they're isolated
 * here and unit-covered exhaustively.
 *
 * Each oracle type maps to one dispersion statistic:
 *   - `output_hash` → distinct-output ratio  = (# distinct outputs) / N
 *   - `assertion`   → pass-rate + failure-rate stddev (Bernoulli) across N
 *   - `judge`       → stddev of rubric scores across N
 *
 * Lower dispersion = the agent's behavior is more stable run-to-run. The
 * Move-2 claim holds when the with-pack arm's dispersion is materially below
 * the without-pack arm's.
 */

/** Population standard deviation of a sample. Returns 0 for <2 values. */
export function populationStddev(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let acc = 0;
  for (const v of values) {
    const d = v - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / n);
}

/** Arithmetic mean. Returns 0 for an empty input. */
export function mean(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / n;
}

/**
 * Distinct-output ratio for the `output_hash` oracle. `1.0` = every run
 * produced a different output (maximally unstable); `1/N` = every run produced
 * the same output (perfectly stable). Returns 0 for an empty input.
 */
export function distinctOutputRatio(outputs: readonly string[]): number {
  const n = outputs.length;
  if (n === 0) return 0;
  return new Set(outputs).size / n;
}

/**
 * Bernoulli (pass/fail) dispersion for the `assertion` oracle. `passes[i]` is
 * true when run i passed. Returns the pass rate and the population stddev of
 * the pass indicator (treating pass=1, fail=0). For a Bernoulli sample the
 * stddev is `sqrt(p*(1-p))`, maximized at p=0.5 (a coin-flip agent) and zero
 * when the agent is perfectly consistent (all-pass or all-fail).
 */
export function bernoulliDispersion(passes: readonly boolean[]): {
  readonly passRate: number;
  readonly stddev: number;
} {
  const n = passes.length;
  if (n === 0) return { passRate: 0, stddev: 0 };
  const indicators = passes.map((p) => (p ? 1 : 0));
  return { passRate: mean(indicators), stddev: populationStddev(indicators) };
}

/** Discriminated dispersion result, tagged by the oracle that produced it. */
export type ArmDispersion =
  | { readonly kind: "output_hash"; readonly distinctRatio: number; readonly runs: number }
  | {
      readonly kind: "assertion";
      readonly passRate: number;
      readonly stddev: number;
      readonly runs: number;
    }
  | {
      readonly kind: "judge";
      readonly meanScore: number;
      readonly stddev: number;
      readonly runs: number;
    };

/**
 * The single scalar each `ArmDispersion` reduces to for the with/without delta.
 * Lower = more stable. For `output_hash` it's the distinct ratio; for
 * `assertion` and `judge` it's the stddev (pass-rate / score stability).
 */
export function dispersionScalar(d: ArmDispersion): number {
  switch (d.kind) {
    case "output_hash":
      return d.distinctRatio;
    case "assertion":
      return d.stddev;
    case "judge":
      return d.stddev;
  }
}
