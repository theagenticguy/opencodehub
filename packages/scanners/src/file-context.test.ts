/**
 * Tests for the shared scanner file-context discoverer.
 *
 * This is the single source both `codehub scan` (CLI) and the MCP `scan` tool
 * use to hand Spectral its contract files and hadolint its Dockerfiles. The
 * MCP path previously omitted this entirely, so Spectral silently linted
 * nothing on OpenAPI repos — these tests pin the wiring.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CHECKOV_SPEC, HADOLINT_SPEC, SPECTRAL_SPEC } from "./catalog.js";
import { buildScannerFileContext, findDockerfiles, findOpenApiFiles } from "./file-context.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "codehub-filectx-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("findOpenApiFiles discovers contracts and skips node_modules/.git/.codehub", async () => {
  await writeFile(join(repo, "openapi.yaml"), "openapi: 3.0.0\n");
  await mkdir(join(repo, "api"), { recursive: true });
  await writeFile(join(repo, "api", "swagger.json"), "{}");
  await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(repo, "node_modules", "pkg", "openapi.yaml"), "ignored");
  await mkdir(join(repo, ".codehub"), { recursive: true });
  await writeFile(join(repo, ".codehub", "openapi.json"), "ignored");

  const found = [...(await findOpenApiFiles(repo))].sort();
  assert.deepEqual(found, ["api/swagger.json", "openapi.yaml"]);
});

test("findDockerfiles matches Dockerfile and Dockerfile.<suffix>", async () => {
  await writeFile(join(repo, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(repo, "Dockerfile.prod"), "FROM scratch\n");
  await writeFile(join(repo, "notadockerfile.txt"), "x");
  const found = [...(await findDockerfiles(repo))].sort();
  assert.deepEqual(found, ["Dockerfile", "Dockerfile.prod"]);
});

test("buildScannerFileContext populates spectral.contractFiles when SPECTRAL is selected", async () => {
  await writeFile(join(repo, "openapi.yaml"), "openapi: 3.0.0\n");
  const ctx = await buildScannerFileContext(repo, [SPECTRAL_SPEC]);
  assert.ok(ctx.spectral !== undefined, "spectral context must be populated");
  assert.deepEqual(ctx.spectral?.contractFiles, ["openapi.yaml"]);
});

test("buildScannerFileContext populates hadolint.dockerfiles when HADOLINT is selected", async () => {
  await writeFile(join(repo, "Dockerfile"), "FROM scratch\n");
  const ctx = await buildScannerFileContext(repo, [HADOLINT_SPEC]);
  assert.deepEqual(ctx.hadolint?.dockerfiles, ["Dockerfile"]);
});

test("buildScannerFileContext skips discovery for unselected specs (no wasted walk)", async () => {
  await writeFile(join(repo, "openapi.yaml"), "openapi: 3.0.0\n");
  await writeFile(join(repo, "Dockerfile"), "FROM scratch\n");
  // Only checkov selected → neither spectral nor hadolint file lists built.
  const ctx = await buildScannerFileContext(repo, [CHECKOV_SPEC]);
  assert.equal(ctx.spectral, undefined);
  assert.equal(ctx.hadolint, undefined);
});
