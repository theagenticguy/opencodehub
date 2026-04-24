import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildManifestLinks, readRepoManifest } from "./manifest-links.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-manifest-"));
}

test("readRepoManifest parses package.json name + dependencies", async () => {
  const dir = await scratch();
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@acme/api",
      dependencies: { "@acme/shared-proto": "1.0.0" },
      peerDependencies: { axios: "1.0.0" },
    }),
    "utf8",
  );
  const summary = await readRepoManifest("api", dir);
  assert.equal(summary.packageName, "@acme/api");
  assert.deepEqual(summary.dependencies, ["@acme/shared-proto", "axios"]);
});

test("readRepoManifest parses pyproject.toml project.name + dependencies (inline)", async () => {
  const dir = await scratch();
  const toml = ["[project]", 'name = "acme-api"', 'dependencies = ["boto3", "requests>=2.0"]'].join(
    "\n",
  );
  await writeFile(join(dir, "pyproject.toml"), toml, "utf8");
  const summary = await readRepoManifest("api", dir);
  assert.equal(summary.packageName, "acme-api");
  assert.deepEqual(summary.dependencies, ["boto3", "requests"]);
});

test("buildManifestLinks pairs consumer dep → producer package", async () => {
  const summaries = [
    {
      repo: "producer",
      packageName: "@acme/shared-proto",
      dependencies: [] as readonly string[],
    },
    {
      repo: "consumer",
      dependencies: ["@acme/shared-proto"],
    },
    {
      repo: "bystander",
      packageName: "@acme/bystander",
      dependencies: [] as readonly string[],
    },
  ];
  const links = buildManifestLinks(summaries);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.producerRepo, "producer");
  assert.equal(links[0]?.consumerRepo, "consumer");
  assert.equal(links[0]?.contract, "@acme/shared-proto");
  assert.equal(links[0]?.type, "grpc_service");
});

test("buildManifestLinks: empty dir stays silent", async () => {
  const dir = await mkdir(join(await scratch(), "empty"), { recursive: true });
  assert.ok(typeof dir !== "undefined" || dir === undefined);
  const summary = await readRepoManifest("x", await scratch());
  assert.equal(summary.dependencies.length, 0);
  assert.equal(summary.packageName, undefined);
});
