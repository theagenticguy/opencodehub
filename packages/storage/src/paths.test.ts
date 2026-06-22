import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
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

test("resolveGraphPath: drops the store.sqlite file inside the meta dir", () => {
  const actual = resolveGraphPath("/tmp/demo-repo");
  assert.equal(actual, resolve("/tmp/demo-repo", META_DIR_NAME, describeArtifacts().graphFile));
});

test("resolveMetaFilePath: drops meta.json inside the meta dir", () => {
  const actual = resolveMetaFilePath("/tmp/demo-repo");
  assert.equal(actual, resolve("/tmp/demo-repo", META_DIR_NAME, META_FILE_NAME));
});

test("resolveRegistryPath: honours explicit homedir override", () => {
  const fakeHome = resolve("/fake/home");
  const actual = resolveRegistryPath(fakeHome);
  // Mirror the impl's `resolve(...)` rather than `join(...)`: on Windows
  // `resolve` normalizes to backslashes + a drive letter while `join` would
  // preserve the forward slashes in the literal, so a `join`-based expectation
  // diverges from the real output cross-platform.
  assert.equal(actual, resolve(fakeHome, META_DIR_NAME, REGISTRY_FILE_NAME));
});

test("resolveRegistryPath: defaults to os.homedir()", () => {
  const actual = resolveRegistryPath();
  assert.equal(actual, resolve(homedir(), META_DIR_NAME, REGISTRY_FILE_NAME));
});

test("resolveRepoMetaDir: resolves relative paths", () => {
  const actual = resolveRepoMetaDir("demo-repo");
  assert.equal(actual, resolve(process.cwd(), "demo-repo", META_DIR_NAME));
});

test("describeArtifacts: returns the single store.sqlite for both views (ADR 0019)", () => {
  const actual = describeArtifacts();
  assert.equal(actual.graphFile, "store.sqlite");
  assert.equal(actual.temporalFile, "store.sqlite");
  assert.equal(actual.schemaName, "main");
});
