/**
 * SBOM phase — emit CycloneDX 1.5 + SPDX 2.3 from Dependency nodes.
 *
 * Responsibilities
 *   1. Collect every DependencyNode the `dependencies` phase produced.
 *   2. Emit a CycloneDX 1.5 JSON document to
 *      `.codehub/sbom.cyclonedx.json` via `@cyclonedx/cyclonedx-library`.
 *   3. Emit a SPDX 2.3 JSON document (DIY emitter) to
 *      `.codehub/sbom.spdx.json`.
 *
 * Opt-in: the phase is a no-op unless `options.sbom === true` (default
 * false). This keeps `codehub analyze` quiet for repos where supply-chain
 * documentation is not part of the flow.
 *
 * Determinism
 *   - Components and packages are emitted in canonical order
 *     (ecosystem, name, version).
 *   - When `options.reproducibleSbom` is `true` (default), the CycloneDX
 *     `metadata.timestamp` is fixed to the Unix epoch, the CycloneDX
 *     serialNumber is derived from a sha256 hash of the dependency
 *     fingerprint, and the SPDX `creationInfo.created` is fixed to the
 *     epoch. The SPDX `documentNamespace` is `urn:uuid:<sha256[0..32]>` of
 *     the same fingerprint — a stable URN, still globally unique for a
 *     given dependency set.
 *   - When `reproducibleSbom === false`, timestamps become `Date.now()`
 *     (floored to the second) and the namespace becomes a random v4 UUID.
 *     We still sort components.
 *
 * Licensing
 *   - `@cyclonedx/cyclonedx-library@10.0.0` is Apache-2.0 (bundle-safe for
 *     our Apache-2.0 host).
 *   - The SPDX emitter is a ~150 LOC DIY transform of Dependency nodes
 *     into JSON — no third-party SPDX library is linked.
 *
 * No network: PURLs and IDs are synthesised from Dependency fields only.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Enums, Models, Serialize, Spec } from "@cyclonedx/cyclonedx-library";
import type { DependencyNode } from "@opencodehub/core-types";
import wfa from "write-file-atomic";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { DEPENDENCIES_PHASE_NAME } from "./dependencies.js";

export const SBOM_PHASE_NAME = "sbom" as const;

const CYCLONEDX_FILE = "sbom.cyclonedx.json" as const;
const SPDX_FILE = "sbom.spdx.json" as const;
const CODEHUB_DIR = ".codehub" as const;
const TOOL_NAME = "opencodehub";
const TOOL_VERSION = "1.1.0";
// Stable epoch = 0 (1970-01-01T00:00:00Z) for reproducible builds.
const REPRODUCIBLE_EPOCH = new Date(0);

export interface SbomOutput {
  readonly cyclonedxPath: string | null;
  readonly spdxPath: string | null;
  readonly componentCount: number;
}

export const sbomPhase: PipelinePhase<SbomOutput> = {
  name: SBOM_PHASE_NAME,
  deps: [DEPENDENCIES_PHASE_NAME],
  async run(ctx): Promise<SbomOutput> {
    if (ctx.options.sbom !== true) {
      return { cyclonedxPath: null, spdxPath: null, componentCount: 0 };
    }
    return runSbom(ctx);
  },
};

async function runSbom(ctx: PipelineContext): Promise<SbomOutput> {
  const reproducible = ctx.options.reproducibleSbom !== false;

  // Collect and sort Dependency nodes. Sorting by (ecosystem, name,
  // version) is the contract that makes SBOM output byte-identical
  // across runs; node insertion order is already canonical per the
  // dependencies phase but we sort again defensively.
  const deps: DependencyNode[] = [];
  for (const n of ctx.graph.nodes()) {
    if (n.kind === "Dependency") deps.push(n);
  }
  deps.sort(compareDeps);

  const repoMeta = path.join(ctx.repoPath, CODEHUB_DIR);
  await mkdir(repoMeta, { recursive: true });

  const cyclonedxPath = path.join(repoMeta, CYCLONEDX_FILE);
  const spdxPath = path.join(repoMeta, SPDX_FILE);

  const fingerprint = fingerprintDeps(deps);
  const timestamp = reproducible ? REPRODUCIBLE_EPOCH : new Date(floorMs(Date.now()));

  const cycloneDxJson = emitCycloneDx(deps, {
    reproducible,
    timestamp,
    fingerprint,
  });
  await wfa(cyclonedxPath, cycloneDxJson, { encoding: "utf8", fsync: false });

  const spdxJson = emitSpdx(deps, {
    reproducible,
    timestamp,
    fingerprint,
  });
  await wfa(spdxPath, spdxJson, { encoding: "utf8", fsync: false });

  return {
    cyclonedxPath,
    spdxPath,
    componentCount: deps.length,
  };
}

function compareDeps(a: DependencyNode, b: DependencyNode): number {
  if (a.ecosystem !== b.ecosystem) return a.ecosystem < b.ecosystem ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  return 0;
}

function floorMs(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/**
 * Content-addressed hash of the Dependency set. Used as the CycloneDX
 * serialNumber and SPDX documentNamespace so byte-identical Dependency
 * graphs produce byte-identical SBOM documents.
 */
function fingerprintDeps(deps: readonly DependencyNode[]): string {
  const h = createHash("sha256");
  for (const d of deps) {
    h.update(`${d.ecosystem}\x1f${d.name}\x1f${d.version}\x1f${d.license ?? ""}\x1e`);
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// CycloneDX 1.5 emission via @cyclonedx/cyclonedx-library
// ---------------------------------------------------------------------------

interface EmitContext {
  readonly reproducible: boolean;
  readonly timestamp: Date;
  readonly fingerprint: string;
}

function emitCycloneDx(deps: readonly DependencyNode[], emit: EmitContext): string {
  const bom = new Models.Bom();
  bom.metadata.timestamp = emit.timestamp;

  // Tool that generated the SBOM. Using `.components.add` rather than the
  // legacy `.tools.tools` set — `Tools.components` is the modern 1.5+ path.
  // `bomRef` is set to a stable string so serialized output is byte-stable
  // across runs; unset, the library generates a random address-backed ref.
  const toolComponent = new Models.Component(Enums.ComponentType.Application, TOOL_NAME, {
    version: TOOL_VERSION,
    bomRef: `tool-${TOOL_NAME}-${TOOL_VERSION}`,
  });
  bom.metadata.tools.components.add(toolComponent);

  // Deterministic serialNumber from the fingerprint. CycloneDX requires
  // `urn:uuid:XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`; we map the first 32
  // hex chars of the fingerprint into a v4-shaped UUID string.
  bom.serialNumber = emit.reproducible
    ? `urn:uuid:${fingerprintToUuid(emit.fingerprint)}`
    : `urn:uuid:${randomUUID()}`;

  for (const d of deps) {
    const purl = buildPurl(d.ecosystem, d.name, d.version);
    // Use PURL as the bomRef so two Dependency sets with the same
    // (ecosystem, name, version) trio yield byte-identical serialised
    // SBOMs. PURLs are unique by construction of the dependencies phase.
    const comp = new Models.Component(Enums.ComponentType.Library, d.name, {
      version: d.version,
      purl,
      bomRef: purl,
    });
    if (d.license && d.license !== "UNKNOWN") {
      // Use a NamedLicense so we do not inadvertently emit invalid SPDX
      // IDs; CycloneDX validators reject unknown IDs on SpdxLicense.
      comp.licenses.add(new Models.NamedLicense(d.license));
    }
    bom.components.add(comp);
  }

  const spec = Spec.Spec1dot5;
  // `@cyclonedx/cyclonedx-library@10` relocated the JSON normalizer factory
  // from `Serialize.JSON.Factory` to `Serialize.JSON.Normalize.Factory`.
  const factory = new Serialize.JSON.Normalize.Factory(spec);
  const serializer = new Serialize.JsonSerializer(factory);
  // sortLists=true so repository iteration order never affects output.
  // space=2 so the emitted file is human-reviewable.
  return serializer.serialize(bom, { sortLists: true, space: 2 });
}

/**
 * Map a 64-hex-char sha256 fingerprint into a UUID-shaped string.
 * The output is a well-formed UUID (hex + dashes) but is NOT a true RFC
 * 4122 UUID — callers MUST treat it as an opaque content fingerprint, not
 * a unique identifier.
 */
function fingerprintToUuid(fingerprint: string): string {
  const hex = fingerprint.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Build a PURL (https://github.com/package-url/purl-spec).
 * Centralises ecosystem-specific quirks so both CycloneDX and SPDX
 * emitters agree.
 */
function buildPurl(ecosystem: DependencyNode["ecosystem"], name: string, version: string): string {
  switch (ecosystem) {
    case "npm":
      return `pkg:npm/${encodePurlName(name)}@${encodePurlVersion(version)}`;
    case "pypi":
      // PURL spec §Known types — PyPI normalises names to lowercase, dashes.
      return `pkg:pypi/${encodePurlName(name.toLowerCase().replace(/_/g, "-"))}@${encodePurlVersion(version)}`;
    case "go":
      // Go module paths may contain `/`. The PURL spec treats the path
      // as-is inside the name segment but spec requires `/` to mark the
      // namespace, so embedded slashes stay literal. We do percent-encode
      // only the few illegal chars (space, `#`, `?`).
      return `pkg:golang/${encodePurlGoName(name)}@${encodePurlVersion(version)}`;
    case "cargo":
      return `pkg:cargo/${encodePurlName(name)}@${encodePurlVersion(version)}`;
    case "maven": {
      // Maven names are `groupId:artifactId`.
      const colon = name.indexOf(":");
      if (colon === -1) {
        return `pkg:maven/${encodePurlName(name)}@${encodePurlVersion(version)}`;
      }
      const group = name.slice(0, colon);
      const artifact = name.slice(colon + 1);
      return `pkg:maven/${encodePurlName(group)}/${encodePurlName(artifact)}@${encodePurlVersion(version)}`;
    }
    case "nuget":
      return `pkg:nuget/${encodePurlName(name)}@${encodePurlVersion(version)}`;
    default: {
      // Exhaustiveness check: if a new ecosystem shows up, TypeScript will
      // flag it at build time and we fall back to a best-effort PURL.
      const _exhaustive: never = ecosystem;
      return `pkg:generic/${encodePurlName(String(_exhaustive ?? name))}@${encodePurlVersion(version)}`;
    }
  }
}

function encodePurlName(raw: string): string {
  // PURL spec: name must be percent-encoded except for unreserved chars.
  // encodeURIComponent handles this correctly for single-segment names.
  return encodeURIComponent(raw);
}

function encodePurlGoName(raw: string): string {
  // Preserve path separators in Go module paths; encode each segment.
  return raw
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function encodePurlVersion(raw: string): string {
  return encodeURIComponent(raw);
}

// ---------------------------------------------------------------------------
// SPDX 2.3 DIY emitter
// ---------------------------------------------------------------------------

interface SpdxPackage {
  readonly SPDXID: string;
  readonly name: string;
  readonly versionInfo: string;
  readonly downloadLocation: "NOASSERTION";
  readonly filesAnalyzed: false;
  readonly licenseConcluded: "NOASSERTION";
  readonly licenseDeclared: string;
  readonly copyrightText: "NOASSERTION";
  readonly externalRefs: ReadonlyArray<{
    readonly referenceCategory: "PACKAGE-MANAGER";
    readonly referenceType: "purl";
    readonly referenceLocator: string;
  }>;
}

interface SpdxDocument {
  readonly spdxVersion: "SPDX-2.3";
  readonly dataLicense: "CC0-1.0";
  readonly SPDXID: "SPDXRef-DOCUMENT";
  readonly name: string;
  readonly documentNamespace: string;
  readonly creationInfo: {
    readonly created: string;
    readonly creators: readonly string[];
  };
  readonly packages: readonly SpdxPackage[];
}

function emitSpdx(deps: readonly DependencyNode[], emit: EmitContext): string {
  const packages: SpdxPackage[] = deps.map((d) => ({
    SPDXID: makeSpdxId(d),
    name: d.name,
    versionInfo: d.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: d.license && d.license !== "UNKNOWN" ? d.license : "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: buildPurl(d.ecosystem, d.name, d.version),
      },
    ],
  }));
  // Stable sort by SPDXID — the SPDX spec mandates uniqueness but not a
  // specific order; we pick ID-ascending so diff-based review stays quiet.
  packages.sort((a, b) => (a.SPDXID < b.SPDXID ? -1 : a.SPDXID > b.SPDXID ? 1 : 0));

  const doc: SpdxDocument = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "opencodehub-sbom",
    documentNamespace: emit.reproducible
      ? `urn:uuid:${fingerprintToUuid(emit.fingerprint)}`
      : `urn:uuid:${randomUUID()}`,
    creationInfo: {
      created: toSpdxTimestamp(emit.timestamp),
      creators: [`Tool: ${TOOL_NAME}-${TOOL_VERSION}`],
    },
    packages,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * SPDX timestamps are ISO-8601 with second precision: `YYYY-MM-DDThh:mm:ssZ`.
 */
function toSpdxTimestamp(d: Date): string {
  // `Date.prototype.toISOString` returns millisecond precision. Strip the
  // `.xxxZ` tail and replace with `Z`.
  const iso = d.toISOString();
  return iso.replace(/\.\d{3}Z$/, "Z");
}

/**
 * SPDXID grammar (§3.2 spec): `SPDXRef-` + [A-Za-z0-9.-]+.
 * We derive deterministic IDs from (ecosystem, name, version) and replace
 * every illegal char with `-`. Ambiguity is acceptable because SPDX only
 * requires IDs be unique within the document, which holds as long as
 * (ecosystem, name, version) is unique — which is the Dependency phase's
 * invariant.
 */
function makeSpdxId(d: DependencyNode): string {
  const raw = `Pkg-${d.ecosystem}-${d.name}-${d.version}`;
  const safe = raw.replace(/[^A-Za-z0-9.-]/g, "-");
  return `SPDXRef-${safe}`;
}
