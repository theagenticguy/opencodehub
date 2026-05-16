import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  describeArtifacts,
  META_DIR_NAME,
  META_FILE_NAME,
  REGISTRY_FILE_NAME,
  resolveGraphPath,
  resolveMetaFilePath,
  resolveRegistryPath,
  resolveRepoMetaDir,
} from "./paths.js";

test("resolveRepoMetaDir: joins repo path with .codehub", () => {
  const actual = resolveRepoMetaDir("/tmp/demo-repo");
  assert.equal(actual, resolve("/tmp/demo-repo", META_DIR_NAME));
});

test("resolveGraphPath: drops the lbug graph file inside the meta dir", () => {
  const actual = resolveGraphPath("/tmp/demo-repo");
  assert.equal(actual, resolve("/tmp/demo-repo", META_DIR_NAME, describeArtifacts().graphFile));
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

test("describeArtifacts: returns lbug + duckdb temporal pair", () => {
  const actual = describeArtifacts();
  assert.equal(actual.graphFile, "graph.lbug");
  assert.equal(actual.temporalFile, "temporal.duckdb");
  assert.equal(actual.schemaName, "main");
});
