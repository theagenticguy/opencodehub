export interface ConfusionCounts {
  tp: number;
  fp: number;
  fn: number;
}

export interface PrecisionRecallF1 {
  precision: number;
  recall: number;
  f1: number;
}

export function confusion(expected: Iterable<string>, actual: Iterable<string>): ConfusionCounts {
  const e = expected instanceof Set ? expected : new Set(expected);
  const a = actual instanceof Set ? actual : new Set(actual);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const x of a) {
    if (e.has(x)) tp += 1;
    else fp += 1;
  }
  for (const x of e) {
    if (!a.has(x)) fn += 1;
  }
  return { tp, fp, fn };
}

export function precisionRecallF1(counts: ConfusionCounts): PrecisionRecallF1 {
  const { tp, fp, fn } = counts;
  // NaN poisons aggregations; return 0 instead so rollups stay finite.
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export function evaluateSet(
  expected: Iterable<string>,
  actual: Iterable<string>,
): PrecisionRecallF1 & ConfusionCounts {
  const counts = confusion(expected, actual);
  const rates = precisionRecallF1(counts);
  return { ...counts, ...rates };
}

export function jaccard(expected: Iterable<string>, actual: Iterable<string>): number {
  const e = expected instanceof Set ? expected : new Set(expected);
  const a = actual instanceof Set ? actual : new Set(actual);
  if (e.size === 0 && a.size === 0) {
    // Both-empty is trivially identical: |∅ ∩ ∅| / |∅ ∪ ∅| is 0/0, but the
    // caller-meaningful answer is "the two sets agree", so return 1.
    return 1;
  }
  let intersection = 0;
  for (const x of a) {
    if (e.has(x)) intersection += 1;
  }
  const union = e.size + a.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function kendallTau(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0 && actual.length === 0) return 0;

  const universe: string[] = [];
  const seen = new Set<string>();
  for (const k of expected) {
    if (!seen.has(k)) {
      seen.add(k);
      universe.push(k);
    }
  }
  for (const k of actual) {
    if (!seen.has(k)) {
      seen.add(k);
      universe.push(k);
    }
  }

  const tiedLastX = expected.length + 1;
  const tiedLastY = actual.length + 1;
  const rankX = new Map<string, number>();
  const rankY = new Map<string, number>();
  for (let i = 0; i < expected.length; i++) {
    const k = expected[i];
    if (k !== undefined && !rankX.has(k)) rankX.set(k, i + 1);
  }
  for (let i = 0; i < actual.length; i++) {
    const k = actual[i];
    if (k !== undefined && !rankY.has(k)) rankY.set(k, i + 1);
  }

  const n = universe.length;
  const xs = new Array<number>(n);
  const ys = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const key = universe[i];
    if (key === undefined) continue;
    xs[i] = rankX.get(key) ?? tiedLastX;
    ys[i] = rankY.get(key) ?? tiedLastY;
  }

  let concordant = 0;
  let discordant = 0;
  let tiedX = 0;
  let tiedY = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = (xs[i] ?? 0) - (xs[j] ?? 0);
      const dy = (ys[i] ?? 0) - (ys[j] ?? 0);
      if (dx === 0 && dy === 0) {
        tiedX += 1;
        tiedY += 1;
      } else if (dx === 0) {
        tiedX += 1;
      } else if (dy === 0) {
        tiedY += 1;
      } else if (Math.sign(dx) === Math.sign(dy)) {
        concordant += 1;
      } else {
        discordant += 1;
      }
    }
  }

  const numerator = concordant - discordant;
  const denomX = concordant + discordant + tiedX;
  const denomY = concordant + discordant + tiedY;
  if (denomX === 0 || denomY === 0) return 0;
  return numerator / Math.sqrt(denomX * denomY);
}

export interface CaseScore {
  language: "python" | "typescript" | "go" | "rust";
  tool: string;
  caseKind: "references" | "implementations" | "callers";
  caseId: string;
  scores: PrecisionRecallF1 & ConfusionCounts;
  jaccard: number;
  kendallTau?: number | undefined;
}

export interface Rollup {
  key: string;
  caseCount: number;
  precision: number;
  recall: number;
  f1: number;
  meanJaccard: number;
  meanKendallTau?: number | undefined;
}

interface RollupAccumulator {
  tp: number;
  fp: number;
  fn: number;
  jaccardSum: number;
  kendallSum: number;
  kendallCount: number;
  caseCount: number;
}

export function aggregate(scores: readonly CaseScore[]): Rollup[] {
  const buckets = new Map<string, RollupAccumulator>();
  for (const s of scores) {
    const key = `${s.language}/${s.tool}/${s.caseKind}`;
    let acc = buckets.get(key);
    if (acc === undefined) {
      acc = { tp: 0, fp: 0, fn: 0, jaccardSum: 0, kendallSum: 0, kendallCount: 0, caseCount: 0 };
      buckets.set(key, acc);
    }
    acc.tp += s.scores.tp;
    acc.fp += s.scores.fp;
    acc.fn += s.scores.fn;
    acc.jaccardSum += s.jaccard;
    if (s.kendallTau !== undefined) {
      acc.kendallSum += s.kendallTau;
      acc.kendallCount += 1;
    }
    acc.caseCount += 1;
  }

  const out: Rollup[] = [];
  for (const [key, acc] of buckets) {
    const { precision, recall, f1 } = precisionRecallF1({ tp: acc.tp, fp: acc.fp, fn: acc.fn });
    const meanJaccard = acc.caseCount === 0 ? 0 : acc.jaccardSum / acc.caseCount;
    const rollup: Rollup = {
      key,
      caseCount: acc.caseCount,
      precision,
      recall,
      f1,
      meanJaccard,
    };
    if (acc.kendallCount > 0) {
      rollup.meanKendallTau = acc.kendallSum / acc.kendallCount;
    }
    out.push(rollup);
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}
