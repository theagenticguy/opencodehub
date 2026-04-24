/**
 * Zod schemas for the subset of SARIF v2.1.0 that OpenCodeHub touches.
 *
 * Design notes:
 * - Every object uses .passthrough() so unknown fields survive round-trip
 *   without being stripped. The full SARIF v2.1.0 spec has ~80 interfaces;
 *   we do NOT zod-validate everything — only what the merge/enrich pipeline
 *   reads or writes.
 * - Fields participating in the GHAS dedup contract (ruleId, fingerprints,
 *   partialFingerprints, artifactLocation.uri) are schematized as read-only
 *   shape anchors. Enrichment MUST NOT mutate them.
 * - OpenCodeHub enrichment writes every new key under
 *   `properties.opencodehub.<name>`. Arbitrary passthrough on the properties
 *   bag preserves any pre-existing namespaced keys from other tools.
 *
 * References:
 * - SARIF v2.1.0 spec (OASIS, Errata 01, 2023-08-28).
 * - GHAS SARIF support: partialFingerprints.primaryLocationLineHash is the
 *   dedup key — byte-identity preservation is mandatory across enrichments.
 */

import { z } from "zod";

/**
 * Properties bag shape. Passthrough so foreign namespaces (microsoft.*,
 * github.*, etc.) travel untouched. OpenCodeHub keys go under
 * properties.opencodehub.<name>.
 */
export const SarifPropertyBagSchema = z.object({}).passthrough();

export const SarifArtifactLocationSchema = z
  .object({
    uri: z.string(),
  })
  .passthrough();

export const SarifRegionSchema = z
  .object({
    startLine: z.number().int().optional(),
    startColumn: z.number().int().optional(),
    endLine: z.number().int().optional(),
    endColumn: z.number().int().optional(),
  })
  .passthrough();

export const SarifPhysicalLocationSchema = z
  .object({
    artifactLocation: SarifArtifactLocationSchema,
    region: SarifRegionSchema.optional(),
  })
  .passthrough();

export const SarifLocationSchema = z
  .object({
    physicalLocation: SarifPhysicalLocationSchema.optional(),
  })
  .passthrough();

export const SarifMessageSchema = z
  .object({
    text: z.string().optional(),
  })
  .passthrough();

/**
 * Result — the observation unit inside a Run.
 *
 * READ-ONLY under enrichment:
 *   - ruleId
 *   - fingerprints
 *   - partialFingerprints
 *   - locations[*].physicalLocation.artifactLocation.uri
 */
export const SarifResultSchema = z
  .object({
    ruleId: z.string().optional(),
    ruleIndex: z.number().int().optional(),
    level: z.enum(["none", "note", "warning", "error"]).optional(),
    message: SarifMessageSchema.optional(),
    locations: z.array(SarifLocationSchema).optional(),
    partialFingerprints: z.record(z.string(), z.string()).optional(),
    fingerprints: z.record(z.string(), z.string()).optional(),
    properties: SarifPropertyBagSchema.optional(),
  })
  .passthrough();

export const SarifToolDriverSchema = z
  .object({
    name: z.string(),
    version: z.string().optional(),
    semanticVersion: z.string().optional(),
  })
  .passthrough();

export const SarifToolSchema = z
  .object({
    driver: SarifToolDriverSchema,
  })
  .passthrough();

export const SarifRunSchema = z
  .object({
    tool: SarifToolSchema,
    results: z.array(SarifResultSchema).optional(),
    properties: SarifPropertyBagSchema.optional(),
  })
  .passthrough();

/**
 * Top-level Log. `version` is pinned literal "2.1.0"; anything else is
 * rejected — OpenCodeHub does not migrate forward-incompatible schemas.
 */
export const SarifLogSchema = z
  .object({
    version: z.literal("2.1.0"),
    $schema: z.string().optional(),
    runs: z.array(SarifRunSchema),
  })
  .passthrough();

export type SarifLog = z.infer<typeof SarifLogSchema>;
export type SarifRun = z.infer<typeof SarifRunSchema>;
export type SarifResult = z.infer<typeof SarifResultSchema>;
export type SarifLocation = z.infer<typeof SarifLocationSchema>;
export type SarifPhysicalLocation = z.infer<typeof SarifPhysicalLocationSchema>;
export type SarifArtifactLocation = z.infer<typeof SarifArtifactLocationSchema>;
export type SarifRegion = z.infer<typeof SarifRegionSchema>;
export type SarifMessage = z.infer<typeof SarifMessageSchema>;
export type SarifTool = z.infer<typeof SarifToolSchema>;
export type SarifToolDriver = z.infer<typeof SarifToolDriverSchema>;
export type SarifPropertyBag = z.infer<typeof SarifPropertyBagSchema>;
