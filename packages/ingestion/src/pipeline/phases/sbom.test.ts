/**
 * SBOM phase tests.
 *
 * The phase is a no-op unless `options.sbom === true` — all our cases set
 * it explicitly. We assert on:
 *   - output paths exist and parse as JSON,
 *   - CycloneDX validates against the 1.5 JSON schema via the
 *     `@cyclonedx/cyclonedx-library` JsonValidator,
 *   - SPDX round-trips through JSON.parse and every package carries a
 *     well-formed SPDXID,
 *   - emission is deterministic when `reproducibleSbom` is default (true).
 */

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Spec, Validation } from "@cyclonedx/cyclonedx-library";
import type { DependencyNode } from "@opencodehub/core-types";
import { KnowledgeGraph, makeNodeId } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { DEPENDENCIES_PHASE_NAME } from "./dependencies.js";
import { SBOM_PHASE_NAME, sbomPhase } from "./sbom.js";

type EcoLiteral = DependencyNode["ecosystem"];

function makeDep(
  ecosystem: EcoLiteral,
  name: string,
  version: string,
  license?: string,
): DependencyNode {
  const id = makeNodeId("Dependency", ecosystem, `${name}@${version}`);
  return {
    id,
    kind: "Dependency",
    name,
    filePath: `${ecosystem}/manifest`,
    version,
    ecosystem,
    lockfileSource: `${ecosystem}/manifest`,
    ...(license !== undefined ? { license } : {}),
  };
}

function makeCtx(
  repo: string,
  deps: readonly DependencyNode[],
  opts: { sbom?: boolean; reproducibleSbom?: boolean } = {},
): PipelineContext {
  const graph = new KnowledgeGraph();
  for (const d of deps) graph.addNode(d);
  return {
    repoPath: repo,
    options: {
      sbom: opts.sbom ?? true,
      reproducibleSbom: opts.reproducibleSbom ?? true,
    },
    graph,
    phaseOutputs: new Map([[DEPENDENCIES_PHASE_NAME, {}]]),
  };
}

describe("sbomPhase — opt-in", () => {
  it("is a no-op when options.sbom is not set", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-sbom-noop-"));
    try {
      const ctx: PipelineContext = {
        repoPath: repo,
        options: {},
        graph: new KnowledgeGraph(),
        phaseOutputs: new Map([[DEPENDENCIES_PHASE_NAME, {}]]),
      };
      const out = await sbomPhase.run(ctx, ctx.phaseOutputs);
      assert.equal(out.cyclonedxPath, null);
      assert.equal(out.spdxPath, null);
      assert.equal(out.componentCount, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("sbomPhase — CycloneDX 1.5 emission", () => {
  let repo: string;
  const deps = [
    makeDep("npm", "express", "4.18.2", "MIT"),
    makeDep("pypi", "flask", "3.0.0"),
    makeDep("cargo", "serde", "1.0.195", "Apache-2.0"),
  ];

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-sbom-cdx-"));
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits sbom.cyclonedx.json that validates against spec 1.5", async () => {
    const ctx = makeCtx(repo, deps);
    const out = await sbomPhase.run(ctx, ctx.phaseOutputs);
    assert.ok(out.cyclonedxPath);
    assert.equal(out.componentCount, 3);

    const raw = await readFile(out.cyclonedxPath, "utf8");
    const parsed = JSON.parse(raw) as {
      bomFormat?: string;
      specVersion?: string;
      components?: unknown[];
    };
    assert.equal(parsed.bomFormat, "CycloneDX");
    assert.equal(parsed.specVersion, "1.5");
    assert.equal(Array.isArray(parsed.components), true);
    assert.equal((parsed.components as unknown[]).length, 3);

    // Validate via cyclonedx-library's bundled validator (uses ajv).
    const validator = new Validation.JsonValidator(Spec.Spec1dot5.version);
    const validationError = await validator.validate(raw);
    assert.equal(
      validationError,
      null,
      `CycloneDX validation failed: ${JSON.stringify(validationError)}`,
    );

    // Components are sorted by (ecosystem, name, version).
    const names = (parsed.components as ReadonlyArray<{ name: string }>).map((c) => c.name);
    assert.deepEqual(names, ["serde", "express", "flask"]);

    // PURLs are built per-ecosystem. We construct the expected locator
    // programmatically because some editors auto-redact bare `name@ver`
    // text as if it were an email address.
    const purls = (parsed.components as ReadonlyArray<{ purl: string }>).map((c) => c.purl);
    const atSign = String.fromCharCode(64);
    assert.ok(
      purls.includes(`pkg:npm/express${atSign}4.18.2`),
      `missing express purl, got: ${purls.join(", ")}`,
    );
    assert.ok(purls.includes(`pkg:pypi/flask${atSign}3.0.0`));
    assert.ok(purls.includes(`pkg:cargo/serde${atSign}1.0.195`));
  });

  it("produces byte-identical output across two runs when reproducible", async () => {
    const ctxA = makeCtx(repo, deps);
    await sbomPhase.run(ctxA, ctxA.phaseOutputs);
    const rawA = await readFile(path.join(repo, ".codehub", "sbom.cyclonedx.json"), "utf8");

    const ctxB = makeCtx(repo, deps);
    await sbomPhase.run(ctxB, ctxB.phaseOutputs);
    const rawB = await readFile(path.join(repo, ".codehub", "sbom.cyclonedx.json"), "utf8");

    assert.equal(rawA, rawB);
  });
});

describe("sbomPhase — SPDX 2.3 emission", () => {
  let repo: string;
  const deps = [
    makeDep("npm", "express", "4.18.2", "MIT"),
    makeDep("go", "github.com/stretchr/testify", "1.9.0"),
    makeDep("maven", "org.slf4j:slf4j-api", "2.0.11", "MIT"),
  ];

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-sbom-spdx-"));
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits a valid-looking SPDX 2.3 doc with per-package SPDXID + PURL externalRefs", async () => {
    const ctx = makeCtx(repo, deps);
    const out = await sbomPhase.run(ctx, ctx.phaseOutputs);
    assert.ok(out.spdxPath);

    const raw = await readFile(out.spdxPath, "utf8");
    const doc = JSON.parse(raw) as {
      spdxVersion: string;
      dataLicense: string;
      SPDXID: string;
      name: string;
      documentNamespace: string;
      creationInfo: { created: string; creators: string[] };
      packages: Array<{
        SPDXID: string;
        name: string;
        externalRefs: Array<{ referenceLocator: string }>;
      }>;
    };

    assert.equal(doc.spdxVersion, "SPDX-2.3");
    assert.equal(doc.dataLicense, "CC0-1.0");
    assert.equal(doc.SPDXID, "SPDXRef-DOCUMENT");
    assert.equal(doc.creationInfo.creators[0]?.startsWith("Tool: opencodehub-"), true);
    // Reproducible timestamps are the Unix epoch in second-precision ISO.
    assert.equal(doc.creationInfo.created, "1970-01-01T00:00:00Z");
    // Namespace is a content-addressed URN in reproducible mode.
    assert.equal(doc.documentNamespace.startsWith("urn:uuid:"), true);

    // Every SPDXID is unique, starts with SPDXRef-, and has no whitespace.
    const idSet = new Set<string>();
    for (const pkg of doc.packages) {
      assert.equal(pkg.SPDXID.startsWith("SPDXRef-"), true, `bad SPDXID: ${pkg.SPDXID}`);
      assert.equal(/\s/.test(pkg.SPDXID), false, `whitespace in SPDXID: ${pkg.SPDXID}`);
      // SPDX ID grammar: [A-Za-z0-9.-]+
      assert.equal(
        /^SPDXRef-[A-Za-z0-9.-]+$/.test(pkg.SPDXID),
        true,
        `bad SPDXID chars: ${pkg.SPDXID}`,
      );
      assert.equal(idSet.has(pkg.SPDXID), false, `duplicate SPDXID: ${pkg.SPDXID}`);
      idSet.add(pkg.SPDXID);
      assert.equal(pkg.externalRefs.length, 1);
      assert.equal(pkg.externalRefs[0]?.referenceLocator.startsWith("pkg:"), true);
    }

    // SPDXIDs are sorted ascending.
    const ids = doc.packages.map((p) => p.SPDXID);
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted);

    // Maven PURL collapses groupId/artifactId.
    const mavenPkg = doc.packages.find((p) => p.name === "org.slf4j:slf4j-api");
    assert.ok(mavenPkg);
    const atSign = String.fromCharCode(64);
    assert.equal(
      mavenPkg?.externalRefs[0]?.referenceLocator,
      `pkg:maven/org.slf4j/slf4j-api${atSign}2.0.11`,
    );

    // Go PURL preserves the module path slashes (each segment encoded).
    const goPkg = doc.packages.find((p) => p.name === "github.com/stretchr/testify");
    assert.ok(goPkg);
    const goLocator = goPkg?.externalRefs[0]?.referenceLocator;
    assert.equal(goLocator?.startsWith("pkg:golang/github.com/stretchr/testify"), true);
    assert.equal(goLocator?.endsWith("1.9.0"), true);
  });
});

describe("sbomPhase — name/deps", () => {
  it("declares dependencies on the `dependencies` phase", () => {
    assert.equal(sbomPhase.name, SBOM_PHASE_NAME);
    assert.deepEqual(sbomPhase.deps, [DEPENDENCIES_PHASE_NAME]);
  });
});

describe("sbomPhase — license declared propagation", () => {
  let repo: string;
  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-sbom-lic-"));
    // Touch a dummy file so the tmp dir isn't empty; not strictly required.
    await writeFile(path.join(repo, ".keep"), "");
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("writes licenseDeclared=MIT when the Dependency has license='MIT'", async () => {
    const deps = [makeDep("npm", "left-pad", "1.3.0", "MIT")];
    const ctx = makeCtx(repo, deps);
    const out = await sbomPhase.run(ctx, ctx.phaseOutputs);
    assert.ok(out.spdxPath);
    const doc = JSON.parse(await readFile(out.spdxPath, "utf8")) as {
      packages: Array<{ licenseDeclared: string }>;
    };
    assert.equal(doc.packages[0]?.licenseDeclared, "MIT");
  });

  it("writes licenseDeclared=NOASSERTION when the Dependency has license='UNKNOWN'", async () => {
    const deps = [makeDep("npm", "mystery", "0.0.1", "UNKNOWN")];
    const ctx = makeCtx(repo, deps);
    const out = await sbomPhase.run(ctx, ctx.phaseOutputs);
    assert.ok(out.spdxPath);
    const doc = JSON.parse(await readFile(out.spdxPath, "utf8")) as {
      packages: Array<{ licenseDeclared: string }>;
    };
    assert.equal(doc.packages[0]?.licenseDeclared, "NOASSERTION");
  });
});
