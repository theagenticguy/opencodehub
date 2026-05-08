/**
 * Tests for the framework-labelled file tree (AC-M5-4 — item 3/9).
 *
 * Covers:
 *   - A. Determinism: two consecutive calls return deep-equal output.
 *   - B. Path-ASC ordering on a known fixture.
 *   - C. `frameworksDetected` (structured) wins over legacy `frameworks`.
 *   - D. Legacy `frameworks` flat list is honored when `frameworksDetected`
 *        is absent.
 *   - E. No `ProjectProfile` row → empty `frameworks` per row.
 *   - F. Framework lists are alpha-sorted + deduped.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GraphNode } from "@opencodehub/core-types";
import { canonicalJson } from "@opencodehub/core-types";
import type { IGraphStore, ListNodesOptions } from "@opencodehub/storage";
import { buildFileTree } from "./file-tree.js";

function makeStore(nodes: readonly GraphNode[]): IGraphStore {
  return {
    listNodes: async (opts: ListNodesOptions = {}) => {
      const kinds = opts.kinds;
      if (kinds !== undefined && kinds.length === 0) return [];
      const set = kinds === undefined ? undefined : new Set(kinds);
      const filtered = set === undefined ? [...nodes] : nodes.filter((n) => set.has(n.kind));
      filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return filtered;
    },
  } as unknown as IGraphStore;
}

const FILES_AND_FOLDERS: readonly GraphNode[] = [
  {
    id: "folder:src" as GraphNode["id"],
    kind: "Folder",
    name: "src",
    filePath: "src",
  },
  {
    id: "file:src/a.ts" as GraphNode["id"],
    kind: "File",
    name: "a.ts",
    filePath: "src/a.ts",
    language: "typescript",
    contentHash: "a".repeat(64),
  },
  {
    id: "file:src/b.py" as GraphNode["id"],
    kind: "File",
    name: "b.py",
    filePath: "src/b.py",
    language: "python",
  },
  {
    id: "folder:src/util" as GraphNode["id"],
    kind: "Folder",
    name: "util",
    filePath: "src/util",
  },
];

const PROFILE_DETECTED: GraphNode = {
  id: "profile:repo" as GraphNode["id"],
  kind: "ProjectProfile",
  name: "repo",
  filePath: ".",
  languages: ["typescript", "python"],
  frameworks: ["react", "express", "react"], // legacy field — should NOT be used when detected wins.
  frameworksDetected: [
    {
      name: "vite",
      category: "build",
      confidence: "deterministic",
      evidence: [],
    },
    {
      name: "react",
      category: "ui",
      confidence: "deterministic",
      evidence: [],
    },
    // Duplicate to verify dedupe.
    {
      name: "react",
      category: "ui",
      confidence: "heuristic",
      evidence: [],
    },
  ],
  iacTypes: [],
  apiContracts: [],
  manifests: [],
  srcDirs: [],
};

const PROFILE_LEGACY: GraphNode = {
  id: "profile:repo" as GraphNode["id"],
  kind: "ProjectProfile",
  name: "repo",
  filePath: ".",
  languages: ["typescript"],
  frameworks: ["react", "express", "react"], // duplicate to verify dedupe + sort.
  iacTypes: [],
  apiContracts: [],
  manifests: [],
  srcDirs: [],
};

test("A. buildFileTree is deterministic across two consecutive calls", async () => {
  const store = makeStore([PROFILE_DETECTED, ...FILES_AND_FOLDERS]);
  const first = await buildFileTree({ store });
  const second = await buildFileTree({ store });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first, second);
});

test("B. rows are sorted by path ASC", async () => {
  const store = makeStore([PROFILE_DETECTED, ...FILES_AND_FOLDERS]);
  const rows = await buildFileTree({ store });
  const paths = rows.map((r) => r.path);
  const sorted = [...paths].sort();
  assert.deepEqual(paths, sorted);
});

test("C. frameworksDetected (structured) wins over legacy frameworks", async () => {
  const store = makeStore([PROFILE_DETECTED, ...FILES_AND_FOLDERS]);
  const rows = await buildFileTree({ store });
  // detected: ["vite","react","react"] → ["react","vite"] (alpha-sorted + deduped).
  // legacy: ["react","express","react"] would sort to ["express","react"] — must NOT appear.
  const fr = rows[0]?.frameworks ?? [];
  assert.deepEqual([...fr], ["react", "vite"]);
});

test("D. legacy frameworks list is honored when frameworksDetected is absent", async () => {
  const store = makeStore([PROFILE_LEGACY, ...FILES_AND_FOLDERS]);
  const rows = await buildFileTree({ store });
  const fr = rows[0]?.frameworks ?? [];
  assert.deepEqual([...fr], ["express", "react"]);
});

test("E. no ProjectProfile row → empty frameworks per row", async () => {
  const store = makeStore(FILES_AND_FOLDERS);
  const rows = await buildFileTree({ store });
  for (const r of rows) {
    assert.deepEqual([...r.frameworks], []);
  }
});

test("F. File rows carry language + contentHash; Folder rows omit them", async () => {
  const store = makeStore([PROFILE_LEGACY, ...FILES_AND_FOLDERS]);
  const rows = await buildFileTree({ store });
  const fileA = rows.find((r) => r.path === "src/a.ts");
  const folderSrc = rows.find((r) => r.path === "src");
  assert.equal(fileA?.kind, "File");
  assert.equal(fileA?.language, "typescript");
  assert.equal(fileA?.contentHash, "a".repeat(64));
  assert.equal(folderSrc?.kind, "Folder");
  assert.equal(folderSrc?.language, undefined);
  assert.equal(folderSrc?.contentHash, undefined);
});

test("G. empty graph returns []", async () => {
  const store = makeStore([]);
  const rows = await buildFileTree({ store });
  assert.deepEqual(rows, []);
});
