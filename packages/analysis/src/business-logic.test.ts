import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyBusinessCandidate,
  classifyPlumbing,
  type PlumbingFeatures,
  SIEVE_VALIDATED_LANGUAGES,
} from "./business-logic.js";

/** Build a feature vector with all-zero defaults, overriding what the case needs. */
function feat(over: Partial<PlumbingFeatures>): PlumbingFeatures {
  return {
    nSerializationCalls: 0,
    nDomainSignals: 0,
    nPlumbingSignals: 0,
    isOrmModel: false,
    ...over,
  };
}

// ── The domain-signal veto: any real decision forces abstain ────────────────

test("a symbol with any domain signal abstains, even amid plumbing", () => {
  // The dangerous error is calling a domain rule "plumbing". A serializer call
  // sitting next to a domain conditional must NOT be swept into plumbing.
  const v = classifyPlumbing(
    feat({ nDomainSignals: 1, nSerializationCalls: 2, nPlumbingSignals: 3 }),
  );
  assert.equal(v.likelyPlumbing, false);
  assert.equal(v.tier, "none");
  assert.equal(v.plumbingConfidence, 0);
});

// ── Tier 1: serialization-pure (precision ~1.0) ─────────────────────────────

test("a pure serializer (no domain signal) is tier-1 plumbing at 0.95", () => {
  // e.g. cosmic-DDD `to_dict` / a Marshal helper.
  const v = classifyPlumbing(feat({ nSerializationCalls: 1 }));
  assert.equal(v.likelyPlumbing, true);
  assert.equal(v.tier, "serialization-pure");
  assert.equal(v.plumbingConfidence, 0.95);
});

// ── Tier 2: plumbing-no-domain (precision ~0.94) ────────────────────────────

test("plumbing signals with no domain signal, not ORM, is tier-2 plumbing at 0.90", () => {
  // e.g. a DI-wiring constructor or a logging wrapper.
  const v = classifyPlumbing(feat({ nPlumbingSignals: 2 }));
  assert.equal(v.likelyPlumbing, true);
  assert.equal(v.tier, "plumbing-no-domain");
  assert.equal(v.plumbingConfidence, 0.9);
});

test("an ORM entity with plumbing signals is excluded from tier-2 (abstains)", () => {
  // ORM entities carry domain methods; the rule must not sweep them up.
  const v = classifyPlumbing(feat({ nPlumbingSignals: 2, isOrmModel: true }));
  assert.equal(v.likelyPlumbing, false);
  assert.equal(v.tier, "none");
});

// ── Abstention: no signal at all ────────────────────────────────────────────

test("a symbol with no serialization, no plumbing, no domain signal abstains", () => {
  const v = classifyPlumbing(feat({}));
  assert.equal(v.likelyPlumbing, false);
  assert.equal(v.tier, "none");
});

// ── Regression fixtures (the iter-0 cases Laith pinned) ─────────────────────

test("regression: AbstractRepository (infra base, no domain rule) reads plumbing", () => {
  // An abstract repository base: plumbing signals (persistence wiring), zero
  // domain decision, and it is NOT itself an ORM-mapped entity row. Must flag
  // plumbing — this inverted in an earlier iteration and is pinned here.
  const v = classifyPlumbing(feat({ nPlumbingSignals: 1, nDomainSignals: 0, isOrmModel: false }));
  assert.equal(v.likelyPlumbing, true);
});

test("regression: Batch.allocate (domain rule) is never called plumbing", () => {
  // The canonical domain method: a conditional on available quantity + a raised
  // domain exception => nDomainSignals > 0 => abstain. The sieve must never hide it.
  const v = classifyPlumbing(feat({ nDomainSignals: 2, nPlumbingSignals: 0 }));
  assert.equal(v.likelyPlumbing, false);
  assert.equal(v.tier, "none");
});

// ── Determinism ─────────────────────────────────────────────────────────────

test("classifyPlumbing is a pure function — identical inputs, identical verdict", () => {
  const f = feat({ nSerializationCalls: 1, nPlumbingSignals: 1 });
  const a = classifyPlumbing(f);
  const b = classifyPlumbing(f);
  assert.deepEqual(a, b);
});

test("validated-language set is exactly python/java/go", () => {
  assert.equal(SIEVE_VALIDATED_LANGUAGES.has("python"), true);
  assert.equal(SIEVE_VALIDATED_LANGUAGES.has("java"), true);
  assert.equal(SIEVE_VALIDATED_LANGUAGES.has("go"), true);
  assert.equal(SIEVE_VALIDATED_LANGUAGES.has("ruby"), false);
});

// ── candidate_business: the recall-first complement of the sieve ────────────

test("candidate_business is the exact complement of likely_plumbing", () => {
  // The core invariant: every symbol is either confident-plumbing or a
  // candidate, never both, never neither. Spot-check across the rule surface.
  for (const f of [
    feat({}),
    feat({ nSerializationCalls: 1 }),
    feat({ nPlumbingSignals: 2 }),
    feat({ nPlumbingSignals: 2, isOrmModel: true }),
    feat({ nDomainSignals: 3, nPlumbingSignals: 1 }),
  ]) {
    const sieve = classifyPlumbing(f);
    const cand = classifyBusinessCandidate(f);
    assert.equal(cand.candidateBusiness, !sieve.likelyPlumbing);
    assert.deepEqual(cand.plumbing, sieve); // carries the verdict through verbatim
  }
});

test("recall-first: a bare domain conditional stays a candidate", () => {
  // A symbol with a domain decision and no plumbing must be a candidate — this
  // is the recall the tag is built to protect (don't drop domain logic).
  const v = classifyBusinessCandidate(feat({ nDomainSignals: 1 }));
  assert.equal(v.candidateBusiness, true);
});

test("recall-first: a symbol with NO signals at all is still a candidate", () => {
  // The sieve only removes CONFIDENT plumbing. An empty/unknown symbol is kept
  // as a candidate rather than silently excluded — high recall by construction.
  const v = classifyBusinessCandidate(feat({}));
  assert.equal(v.candidateBusiness, true);
  assert.equal(v.plumbing.tier, "none");
});

test("confident plumbing is NOT a candidate", () => {
  // A pure serializer is removed from the candidate set.
  const v = classifyBusinessCandidate(feat({ nSerializationCalls: 1 }));
  assert.equal(v.candidateBusiness, false);
});

test("regression: Batch.allocate is a business candidate, AbstractRepository is not", () => {
  // The two pinned cases, viewed through the candidate tag.
  assert.equal(classifyBusinessCandidate(feat({ nDomainSignals: 2 })).candidateBusiness, true);
  assert.equal(classifyBusinessCandidate(feat({ nPlumbingSignals: 1 })).candidateBusiness, false);
});
