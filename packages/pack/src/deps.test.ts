/**
 * Tests for the dependency BOM body (item 4/9).
 *
 * Covers:
 *   - A. Determinism: two consecutive calls return deep-equal output.
 *   - B. Sort order — `(ecosystem ASC, name ASC, version ASC, id ASC)`.
 *        Multi-ecosystem fixture proves npm sorts before pypi.
 *   - C. Missing license stays `undefined` (NOT coerced to "UNKNOWN").
 *   - D. Empty graph returns `[]`.
 *   - E. id-tiebreak — same `(ecosystem, name, version)` resolves via id.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GraphNode } from "@opencodehub/core-types";
import { canonicalJson } from "@opencodehub/core-types";
import type { IGraphStore, ListNodesOptions } from "@opencodehub/storage";
import { buildDeps } from "./deps.js";

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

const DEPS: readonly GraphNode[] = [
  {
    id: "dep:npm:lodash@4.17.21" as GraphNode["id"],
    kind: "Dependency",
    name: "lodash",
    filePath: "package.json",
    version: "4.17.21",
    ecosystem: "npm",
    lockfileSource: "pnpm-lock.yaml",
    license: "MIT",
  },
  {
    id: "dep:pypi:requests@2.31.0" as GraphNode["id"],
    kind: "Dependency",
    name: "requests",
    filePath: "requirements.txt",
    version: "2.31.0",
    ecosystem: "pypi",
    lockfileSource: "requirements.txt",
    // license intentionally absent — must round-trip as undefined.
  },
  {
    id: "dep:npm:express@4.19.2" as GraphNode["id"],
    kind: "Dependency",
    name: "express",
    filePath: "package.json",
    version: "4.19.2",
    ecosystem: "npm",
    lockfileSource: "pnpm-lock.yaml",
    license: "MIT",
  },
];

// Two rows that share (ecosystem, name, version) — id is the only
// stable tiebreak.
const DEPS_TIEBREAK: readonly GraphNode[] = [
  {
    id: "dep:npm:left-pad@1.3.0:b" as GraphNode["id"],
    kind: "Dependency",
    name: "left-pad",
    filePath: "apps/b/package.json",
    version: "1.3.0",
    ecosystem: "npm",
    lockfileSource: "apps/b/package-lock.json",
  },
  {
    id: "dep:npm:left-pad@1.3.0:a" as GraphNode["id"],
    kind: "Dependency",
    name: "left-pad",
    filePath: "apps/a/package.json",
    version: "1.3.0",
    ecosystem: "npm",
    lockfileSource: "apps/a/package-lock.json",
  },
];

test("A. buildDeps is deterministic across two consecutive calls", async () => {
  const store = makeStore(DEPS);
  const first = await buildDeps({ store });
  const second = await buildDeps({ store });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first, second);
});

test("B. rows are sorted (ecosystem, name, version, id) ascending", async () => {
  const store = makeStore(DEPS);
  const rows = await buildDeps({ store });
  // npm < pypi alphabetically, so all npm rows come first.
  assert.equal(rows[0]?.ecosystem, "npm");
  assert.equal(rows[1]?.ecosystem, "npm");
  assert.equal(rows[2]?.ecosystem, "pypi");
  // Within npm: express < lodash by name ASC.
  assert.equal(rows[0]?.name, "express");
  assert.equal(rows[1]?.name, "lodash");
});

test("C. missing license stays undefined (not coerced to UNKNOWN)", async () => {
  const store = makeStore(DEPS);
  const rows = await buildDeps({ store });
  const requests = rows.find((r) => r.name === "requests");
  assert.equal(requests?.license, undefined);
  // Sanity: rows that DO have a license still carry it.
  const lodash = rows.find((r) => r.name === "lodash");
  assert.equal(lodash?.license, "MIT");
});

test("D. empty graph returns []", async () => {
  const store = makeStore([]);
  const rows = await buildDeps({ store });
  assert.deepEqual(rows, []);
});

test("E. id breaks ties when (ecosystem, name, version) are equal", async () => {
  const store = makeStore(DEPS_TIEBREAK);
  const rows = await buildDeps({ store });
  assert.equal(rows.length, 2);
  // id ASC: "dep:npm:left-pad@1.3.0:a" < "dep:npm:left-pad@1.3.0:b"
  assert.equal(rows[0]?.id, "dep:npm:left-pad@1.3.0:a");
  assert.equal(rows[1]?.id, "dep:npm:left-pad@1.3.0:b");
});

test("F. version is preserved verbatim (no UNKNOWN coercion)", async () => {
  const store = makeStore(DEPS);
  const rows = await buildDeps({ store });
  assert.equal(rows.find((r) => r.name === "lodash")?.version, "4.17.21");
  assert.equal(rows.find((r) => r.name === "requests")?.version, "2.31.0");
});
