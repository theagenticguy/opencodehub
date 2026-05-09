import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  describeArtifacts,
  META_DIR_NAME,
  META_FILE_NAME,
  REGISTRY_FILE_NAME,
  resolveDbPath,
  resolveMetaFilePath,
  resolveRegistryPath,
  resolveRepoMetaDir,
} from "./paths.js";

test("resolveRepoMetaDir: joins repo path with .codehub", () => {
  const actual = resolveRepoMetaDir("/tmp/demo-repo");
  assert.equal(actual, resolve("/tmp/demo-repo", META_DIR_NAME));
});

test("resolveDbPath: drops the DuckDB file inside the meta dir", () => {
  const actual = resolveDbPath("/tmp/demo-repo");
  assert.equal(
    actual,
    resolve("/tmp/demo-repo", META_DIR_NAME, describeArtifacts("duck").graphFile),
  );
});

test("resolveMetaFilePath: drops meta.json inside the meta dir", () => {
  const actual = resolveMetaFilePath("/tmp/demo-repo");
  assert.equal(actual, resolve("/tmp/demo-repo", META_DIR_NAME, META_FILE_NAME));
});

test("resolveRegistryPath: honours explicit homedir override", () => {
  const fakeHome = "/fake/home";
  const actual = resolveRegistryPath(fakeHome);
  assert.equal(actual, join(fakeHome, META_DIR_NAME, REGISTRY_FILE_NAME));
});

test("resolveRegistryPath: defaults to os.homedir()", () => {
  const actual = resolveRegistryPath();
  assert.equal(actual, resolve(homedir(), META_DIR_NAME, REGISTRY_FILE_NAME));
});

test("resolveRepoMetaDir: resolves relative paths", () => {
  const actual = resolveRepoMetaDir("demo-repo");
  assert.equal(actual, resolve(process.cwd(), "demo-repo", META_DIR_NAME));
});

test("describeArtifacts: duck collapses graph + temporal to a single file", () => {
  const actual = describeArtifacts("duck");
  assert.equal(actual.graphFile, "graph.duckdb");
  assert.equal(actual.temporalFile, "graph.duckdb");
  assert.equal(actual.schemaName, "main");
});

test("describeArtifacts: lbug splits graph + temporal across two files", () => {
  const actual = describeArtifacts("lbug");
  assert.equal(actual.graphFile, "graph.lbug");
  assert.equal(actual.temporalFile, "temporal.duckdb");
  assert.equal(actual.schemaName, "main");
});

test("describeArtifacts: community backends fall back to graph.<backend> + temporal.duckdb", () => {
  const actual = describeArtifacts("neo4j");
  assert.equal(actual.graphFile, "graph.neo4j");
  assert.equal(actual.temporalFile, "temporal.duckdb");
  assert.equal(actual.schemaName, "main");
});
