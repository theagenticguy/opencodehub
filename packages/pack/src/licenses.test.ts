/**
 * Tests for the licenses BOM body (AC-M5-5 — item 9 partial).
 *
 * Covers:
 *   - A. Determinism across two consecutive calls.
 *   - B. Tier classification: 1 OK + 1 GPL + 1 unknown → BLOCK.
 *   - C. Markdown ordering: ecosystem ASC, name ASC, version ASC.
 *   - D. Missing license coerces to "UNKNOWN" for the classifier.
 *   - E. NOTICE file content is read and concatenated when present.
 *   - F. No NOTICE file → empty `noticesMd`.
 *   - G. CRLF in NOTICE content normalizes to LF.
 *   - H. Empty graph still produces a valid markdown body with tier=OK.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GraphNode } from "@opencodehub/core-types";
import { canonicalJson } from "@opencodehub/core-types";
import type { IGraphStore, ListNodesOptions } from "@opencodehub/storage";
import { buildLicenses } from "./licenses.js";

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

const DEPS_MIXED: readonly GraphNode[] = [
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
    id: "dep:npm:gpl-pkg@1.0.0" as GraphNode["id"],
    kind: "Dependency",
    name: "gpl-pkg",
    filePath: "package.json",
    version: "1.0.0",
    ecosystem: "npm",
    lockfileSource: "pnpm-lock.yaml",
    license: "GPL-3.0",
  },
  {
    id: "dep:pypi:mystery@2.0.0" as GraphNode["id"],
    kind: "Dependency",
    name: "mystery",
    filePath: "requirements.txt",
    version: "2.0.0",
    ecosystem: "pypi",
    lockfileSource: "requirements.txt",
    // No license field → coerces to UNKNOWN.
  },
];

function noopReader(_path: string): Promise<string | undefined> {
  return Promise.resolve(undefined);
}

test("A. buildLicenses is deterministic across two consecutive calls", async () => {
  const store = makeStore(DEPS_MIXED);
  const first = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: noopReader });
  const second = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: noopReader });
  // The classifier returns frozen-shape objects, so canonicalJson is the
  // strongest equality predicate available.
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test("B. mixed deps produce tier=BLOCK (any copyleft is BLOCK)", async () => {
  const store = makeStore(DEPS_MIXED);
  const result = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: noopReader });
  assert.equal(result.classification.tier, "BLOCK");
  // Counts: 3 total, 1 OK, 2 flagged (1 copyleft + 1 unknown).
  assert.equal(result.classification.summary.total, 3);
  assert.equal(result.classification.summary.okCount, 1);
  assert.equal(result.classification.summary.flaggedCount, 2);
});

test("C. markdown lists packages in (ecosystem, name, version) ASC order", async () => {
  const store = makeStore(DEPS_MIXED);
  const result = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: noopReader });
  const md = result.licensesMd;
  // npm < pypi: gpl-pkg, lodash, then mystery.
  const gplIdx = md.indexOf("gpl-pkg@1.0.0");
  const lodashIdx = md.indexOf("lodash@4.17.21");
  const mysteryIdx = md.indexOf("mystery@2.0.0");
  assert.ok(gplIdx > 0 && lodashIdx > gplIdx && mysteryIdx > lodashIdx);
});

test("D. missing license coerces to 'UNKNOWN' for the classifier", async () => {
  const store = makeStore(DEPS_MIXED);
  const result = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: noopReader });
  // The mystery package has no license; it should land in the unknown bucket.
  const unknown = result.classification.flagged.unknown;
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]?.name, "mystery");
});

test("E. NOTICE file content is read and concatenated when present", async () => {
  const store = makeStore(DEPS_MIXED);
  const reader = async (path: string) => {
    if (path === "/tmp/repo/NOTICE") return "Copyright 2026 Example Corp.";
    return undefined;
  };
  const result = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: reader });
  assert.ok(result.noticesMd.includes("Copyright 2026 Example Corp."));
  assert.ok(result.noticesMd.startsWith("# NOTICE\n"));
});

test("F. no NOTICE file → empty noticesMd", async () => {
  const store = makeStore(DEPS_MIXED);
  const result = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: noopReader });
  assert.equal(result.noticesMd, "");
});

test("G. CRLF in NOTICE content normalizes to LF", async () => {
  const store = makeStore(DEPS_MIXED);
  const reader = async (path: string) => {
    if (path === "/tmp/repo/NOTICE") return "line one\r\nline two\r\n";
    return undefined;
  };
  const result = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: reader });
  // No CRLF survives.
  assert.ok(!result.noticesMd.includes("\r\n"));
  assert.ok(result.noticesMd.includes("line one\nline two"));
});

test("H. empty graph still produces a valid markdown body with tier=OK", async () => {
  const store = makeStore([]);
  const result = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: noopReader });
  assert.equal(result.classification.tier, "OK");
  assert.ok(result.licensesMd.includes("# Licenses"));
  assert.ok(result.licensesMd.includes("Total: 0"));
  assert.ok(result.licensesMd.includes("(no dependencies)"));
});

test("I. all NOTICE_FILES variants probed in lex ASC order", async () => {
  const store = makeStore([]);
  const reads: string[] = [];
  const reader = async (path: string) => {
    reads.push(path);
    if (path === "/tmp/repo/NOTICE.md") return "from .md";
    if (path === "/tmp/repo/NOTICES") return "from NOTICES";
    return undefined;
  };
  const result = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: reader });
  // We should see all three probes, in lex order.
  assert.deepEqual(reads, ["/tmp/repo/NOTICE", "/tmp/repo/NOTICE.md", "/tmp/repo/NOTICES"]);
  // Both files concatenate; the result mentions both filenames as section headers.
  assert.ok(result.noticesMd.includes("# NOTICE.md"));
  assert.ok(result.noticesMd.includes("# NOTICES"));
});

test("J. licensesMd ends in a single trailing newline", async () => {
  const store = makeStore(DEPS_MIXED);
  const result = await buildLicenses({ store, repoPath: "/tmp/repo", readFile: noopReader });
  assert.ok(result.licensesMd.endsWith("\n"));
  assert.ok(!result.licensesMd.endsWith("\n\n"));
});
