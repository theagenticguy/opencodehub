/**
 * Deterministic business-logic / plumbing classifier for
 * `@opencodehub/analysis`.
 *
 * This is the SIEVE half of business-logic detection: a high-precision,
 * conservative rule that flags symbols which are almost certainly plumbing
 * (serialization, DTO mapping, transport, DI wiring) and ABSTAINS everywhere
 * else. It does NOT assert "this is business logic" — calling a real domain
 * rule "plumbing" and hiding it is the costly error, so the rule is tuned for
 * plumbing PRECISION and stays silent when unsure.
 *
 * ## Provenance
 *
 * The rule was distilled from a teacher/student loop: a 3-model LLM panel
 * labeled ~300 symbols across 4 repos (Python / Java / Go), a shallow decision
 * tree was fit, and the two cleanest, highest-precision plumbing leaves were
 * lifted out as the shippable rule. Measured plumbing precision on the labeled
 * corpus: 0.936 aggregate, and >= 0.85 on EVERY repo under per-repo evaluation
 * (py-flask 1.00, java-petclinic 0.94, go-clean 0.92, py-cosmic-ddd 0.89). The
 * full classifier (asserting business too) did not generalize cross-repo and is
 * intentionally NOT shipped here — only the plumbing direction is.
 *
 * ## Determinism
 *
 * Pure function of the per-symbol feature vector — no I/O, no model, no
 * randomness. The same inputs always yield the same verdict, so the result is
 * safe to persist into `nodes.payload` and survives the `graphHash` byte-
 * identity contract. Mirrors the `page-rank.ts` "request-time deterministic
 * kernel" idiom.
 *
 * ## Feature binding
 *
 * The kernel consumes a small {@link PlumbingFeatures} struct. OCH's ingestion
 * computes these from the AST at parse time (the same place
 * `cyclomaticComplexity` is produced); see the companion extractor spec. The
 * kernel is deliberately decoupled from HOW the features are computed so the
 * rule can be unit-tested in isolation and re-tuned without touching ingestion.
 */

/**
 * The minimal per-symbol feature vector the plumbing sieve needs. Every field
 * is a non-negative integer count or a boolean, computable deterministically
 * from the symbol's AST + its place in the file.
 */
export interface PlumbingFeatures {
  /**
   * Count of serialization / wire-format calls in the body: `json.dumps`,
   * `model_dump`, `to_dict`, `Marshal`/`Unmarshal`, `writeValue`, `JSON.parse`,
   * etc. A serializer with no domain decision is plumbing.
   */
  readonly nSerializationCalls: number;
  /**
   * Count of POSITIVE domain-logic signals: conditionals comparing domain
   * values (not None/nil/type guards), arithmetic/aggregation on domain
   * quantities, raised domain exceptions, state-machine transitions. When this
   * is > 0 the symbol carries a real decision and the sieve MUST abstain — the
   * recall-first half (business detection) owns those.
   */
  readonly nDomainSignals: number;
  /**
   * Count of NEGATIVE plumbing signals: raw-SQL execution, DI wiring,
   * framework callbacks/registration, logging/metrics/tracing calls,
   * pass-through attribute assignments.
   */
  readonly nPlumbingSignals: number;
  /**
   * True when the symbol is (or is a method on) an ORM-mapped persistence
   * entity. ORM entities frequently carry domain methods, so a symbol on one
   * is NOT swept into plumbing by the sieve — the rule excludes it.
   */
  readonly isOrmModel: boolean;
}

/** Advisory verdict written into `nodes.payload`. */
export interface PlumbingVerdict {
  /**
   * `true` only when the rule is confident the symbol is plumbing. `false`
   * means ABSTAIN — NOT an assertion that the symbol is business logic. A
   * consumer should treat `false` as "no signal", never as "this is business".
   */
  readonly likelyPlumbing: boolean;
  /**
   * Confidence in [0, 1] attached to a `likelyPlumbing: true` verdict, keyed to
   * the tier that fired. `0` when abstaining. Tier confidences are the measured
   * per-tier precisions, rounded: 0.95 (serialization-pure) / 0.90 (standard).
   */
  readonly plumbingConfidence: number;
  /**
   * Which rule tier fired, for auditability. `"none"` when abstaining.
   *   - `"serialization-pure"`: a serializer with zero domain signal (precision ~1.0).
   *   - `"plumbing-no-domain"`: plumbing signals present, zero domain signal,
   *     not an ORM entity (precision ~0.94).
   */
  readonly tier: "serialization-pure" | "plumbing-no-domain" | "none";
}

const ABSTAIN: PlumbingVerdict = {
  likelyPlumbing: false,
  plumbingConfidence: 0,
  tier: "none",
};

/**
 * Classify one symbol. Two tiers, evaluated high-confidence first; both require
 * ZERO domain signal so a symbol that carries any real decision always abstains.
 *
 *   Tier 1 (conf 0.95): serialization calls present AND no domain signal.
 *   Tier 2 (conf 0.90): plumbing signals present AND no domain signal AND not an ORM entity.
 *
 * Anything else abstains. The order matters only for the reported `tier`;
 * the two tiers never disagree on `likelyPlumbing`.
 */
export function classifyPlumbing(f: PlumbingFeatures): PlumbingVerdict {
  // A real domain decision anywhere in the symbol vetoes the sieve outright.
  if (f.nDomainSignals > 0) return ABSTAIN;

  if (f.nSerializationCalls > 0) {
    return { likelyPlumbing: true, plumbingConfidence: 0.95, tier: "serialization-pure" };
  }

  if (f.nPlumbingSignals > 0 && !f.isOrmModel) {
    return { likelyPlumbing: true, plumbingConfidence: 0.9, tier: "plumbing-no-domain" };
  }

  return ABSTAIN;
}

/**
 * Languages the sieve is validated on. The rule's precision floor was measured
 * on Python, Java, and Go corpora; calling it on other languages is allowed but
 * unvalidated, so the analyze pass should gate on this set and skip the rest
 * rather than emit an unbacked verdict.
 */
export const SIEVE_VALIDATED_LANGUAGES: ReadonlySet<string> = new Set(["python", "java", "go"]);
