/**
 * enrichWithProperties — attach OpenCodeHub-computed signals to a SARIF log
 * via the `properties.opencodehub.<name>` namespace.
 *
 * INVARIANTS (GHAS dedup contract):
 *   - result.fingerprints is NEVER mutated.
 *   - result.partialFingerprints is NEVER mutated.
 *   - result.ruleId is NEVER mutated.
 *   - result.locations[*].physicalLocation.artifactLocation.uri is NEVER mutated.
 *
 * All enrichment is deposited under:
 *   - run.properties.opencodehub.*    (RunEnrichment fields)
 *   - result.properties.opencodehub.* (ResultEnrichment fields)
 *
 * Resolution order for per-result enrichment:
 *   1. byResultFingerprint — key = partialFingerprints.primaryLocationLineHash
 *      (GHAS dedup key). First match wins.
 *   2. byResultIndex — zero-based index into the flattened results-per-run.
 *
 * The function deep-clones the log via structuredClone and returns the clone;
 * the input is never mutated.
 */

import { type SarifLog, SarifLogSchema } from "./schemas.js";

export interface ResultEnrichment {
  readonly blastRadius?: number;
  readonly community?: string;
  readonly cochangeScore?: number;
  readonly centrality?: number;
  readonly temporalFixDensity?: number;
  readonly busFactor?: number;
  readonly cyclomaticComplexity?: number;
  readonly ownershipDrift?: number;
}

export interface RunEnrichment {
  readonly enrichedAt?: string;
  readonly enrichmentVersion?: string;
  readonly sources?: readonly string[];
}

export interface EnrichmentInput {
  readonly byResultFingerprint?: ReadonlyMap<string, ResultEnrichment>;
  readonly byResultIndex?: ReadonlyMap<number, ResultEnrichment>;
  readonly run?: RunEnrichment;
}

/**
 * Namespace key. Keeping this one place makes it searchable and prevents
 * accidental drift (e.g., "openCodeHub" vs "opencodehub").
 */
const NS = "opencodehub";

/** Typed view of a SARIF property bag (free-form keyed by namespace). */
interface PropertyBag {
  [namespace: string]: unknown;
}

/** Typed view of the OpenCodeHub sub-bag written under properties.opencodehub. */
interface OpenCodeHubBag {
  blastRadius?: number;
  community?: string;
  cochangeScore?: number;
  centrality?: number;
  temporalFixDensity?: number;
  busFactor?: number;
  cyclomaticComplexity?: number;
  ownershipDrift?: number;
  enrichedAt?: string;
  enrichmentVersion?: string;
  sources?: string[];
  [k: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Returns the existing `opencodehub` sub-bag from a properties bag, or creates
 * a new one. `bag` must already be an object reference we can mutate.
 */
function ensureOpenCodeHubBag(bag: PropertyBag): OpenCodeHubBag {
  const existing = bag[NS];
  if (isPlainObject(existing)) {
    return existing as OpenCodeHubBag;
  }
  const fresh: OpenCodeHubBag = {};
  bag[NS] = fresh;
  return fresh;
}

function applyResultEnrichment(target: OpenCodeHubBag, enrichment: ResultEnrichment): void {
  if (enrichment.blastRadius !== undefined) {
    target.blastRadius = enrichment.blastRadius;
  }
  if (enrichment.community !== undefined) {
    target.community = enrichment.community;
  }
  if (enrichment.cochangeScore !== undefined) {
    target.cochangeScore = enrichment.cochangeScore;
  }
  if (enrichment.centrality !== undefined) {
    target.centrality = enrichment.centrality;
  }
  if (enrichment.temporalFixDensity !== undefined) {
    target.temporalFixDensity = enrichment.temporalFixDensity;
  }
  if (enrichment.busFactor !== undefined) {
    target.busFactor = enrichment.busFactor;
  }
  if (enrichment.cyclomaticComplexity !== undefined) {
    target.cyclomaticComplexity = enrichment.cyclomaticComplexity;
  }
  if (enrichment.ownershipDrift !== undefined) {
    target.ownershipDrift = enrichment.ownershipDrift;
  }
}

function applyRunEnrichment(target: OpenCodeHubBag, enrichment: RunEnrichment): void {
  if (enrichment.enrichedAt !== undefined) {
    target.enrichedAt = enrichment.enrichedAt;
  }
  if (enrichment.enrichmentVersion !== undefined) {
    target.enrichmentVersion = enrichment.enrichmentVersion;
  }
  if (enrichment.sources !== undefined) {
    target.sources = [...enrichment.sources];
  }
}

/** Carrier of a SARIF properties bag (run or result). */
interface HasProperties {
  properties?: PropertyBag;
}

/**
 * Resolve (or create) a plain-object `.properties` bag on an owner that
 * may already have one. Preserves existing keys.
 */
function ensurePropertyBag(owner: HasProperties): PropertyBag {
  const existing = owner.properties;
  if (isPlainObject(existing)) {
    return existing as PropertyBag;
  }
  const fresh: PropertyBag = {};
  owner.properties = fresh;
  return fresh;
}

/**
 * Extract the GHAS dedup key from a Result, if present. Pure reader —
 * does not mutate the Result.
 */
interface FingerprintCarrier {
  primaryLocationLineHash?: string;
}

function primaryFingerprint(result: unknown): string | undefined {
  if (!isPlainObject(result)) {
    return undefined;
  }
  // biome-ignore lint/complexity/useLiteralKeys: dot-access is disallowed on Record index signatures (tsconfig's noPropertyAccessFromIndexSignature)
  const pf = result["partialFingerprints"];
  if (!isPlainObject(pf)) {
    return undefined;
  }
  const candidate = (pf as unknown as FingerprintCarrier).primaryLocationLineHash;
  return typeof candidate === "string" ? candidate : undefined;
}

export function enrichWithProperties(log: SarifLog, enrichments: EnrichmentInput): SarifLog {
  const parsed = SarifLogSchema.safeParse(log);
  if (!parsed.success) {
    throw new Error(
      `enrichWithProperties: input failed schema validation: ${parsed.error.message}`,
    );
  }

  const cloned = structuredClone(parsed.data) as SarifLog;
  const byFp = enrichments.byResultFingerprint;
  const byIdx = enrichments.byResultIndex;
  const runEnrichment = enrichments.run;

  for (const run of cloned.runs) {
    // Run-level enrichment.
    if (runEnrichment !== undefined) {
      const runOwner = run as HasProperties;
      const propsBag = ensurePropertyBag(runOwner);
      const nsBag = ensureOpenCodeHubBag(propsBag);
      applyRunEnrichment(nsBag, runEnrichment);
    }

    // Result-level enrichment.
    const results = run.results;
    if (!Array.isArray(results)) {
      continue;
    }
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result === undefined) {
        continue;
      }

      let chosen: ResultEnrichment | undefined;
      if (byFp !== undefined) {
        const key = primaryFingerprint(result);
        if (key !== undefined) {
          chosen = byFp.get(key);
        }
      }
      if (chosen === undefined && byIdx !== undefined) {
        chosen = byIdx.get(i);
      }
      if (chosen === undefined) {
        continue;
      }

      const resultOwner = result as HasProperties;
      const propsBag = ensurePropertyBag(resultOwner);
      const nsBag = ensureOpenCodeHubBag(propsBag);
      applyResultEnrichment(nsBag, chosen);
    }
  }

  return cloned;
}
