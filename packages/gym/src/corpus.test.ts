import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "./corpus.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/corpus.test.js -> dist -> packages/gym -> corpus/python/sdk-python.yaml
const sdkPythonCorpusPath = resolve(here, "..", "corpus", "python", "sdk-python.yaml");
const thiserrorCorpusPath = resolve(here, "..", "corpus", "rust", "thiserror.yaml");
const cobraCorpusPath = resolve(here, "..", "corpus", "go", "cobra.yaml");
const tsPatternCorpusPath = resolve(here, "..", "corpus", "typescript", "ts-pattern.yaml");
const electronWsPythonTsCorpusPath = resolve(
  here,
  "..",
  "corpus",
  "monorepo",
  "electron-ws-python-typescript.yaml",
);
const electronWsPythonPyCorpusPath = resolve(
  here,
  "..",
  "corpus",
  "monorepo",
  "electron-ws-python-python.yaml",
);

test("loadCorpus: parses the real sdk-python.yaml cleanly", async () => {
  const corpus = await loadCorpus(sdkPythonCorpusPath);
  assert.equal(corpus.language, "python");
  assert.equal(corpus.corpus.name, "sdk-python");
  assert.equal(corpus.corpus.commit, "5a6df59502dc618781b85e80b01706a19cd45828");
  assert.equal(corpus.corpus.path, "python/sdk-python");
  assert.equal(corpus.tool.name, "scip-python");
  assert.equal(corpus.tool.version, "0.6.6");
});

test("sdk-python.yaml: contains the expected 14 ported cases", async () => {
  const corpus = await loadCorpus(sdkPythonCorpusPath);
  assert.equal(corpus.cases.length, 14);
  const ids = new Set(corpus.cases.map((c) => c.id));
  assert.equal(ids.size, 14, "case ids must be unique");
});

test("sdk-python.yaml: every non-waived case has a non-empty expected list", async () => {
  const corpus = await loadCorpus(sdkPythonCorpusPath);
  for (const c of corpus.cases) {
    if (c.waived === true) continue;
    assert.ok(c.expected.length > 0, `case ${c.id} is not waived but has an empty expected list`);
  }
});

test("sdk-python.yaml: waived cases are explicitly flagged", async () => {
  const corpus = await loadCorpus(sdkPythonCorpusPath);
  const waived = corpus.cases.filter((c) => c.waived === true);
  // 1 pre-existing migration waiver (BedrockModel._stream) + 4 auto-waivers
  // emitted by `refresh-expected.py` when scip-python returns zero hits for
  // a target with no callers inside the fixture.
  const waivedIds = waived.map((c) => c.id);
  assert.ok(waivedIds.includes("sdk-python.callers.BedrockModel._stream"));
  assert.ok(waived.length >= 1);
});

test("loadCorpus: throws with file path on malformed YAML", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gym-corpus-"));
  try {
    const path = join(dir, "bad.yaml");
    await writeFile(path, "language: python\ncorpus:\n  name: x\n    bad_indent: true\n", "utf-8");
    await assert.rejects(
      () => loadCorpus(path),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
        assert.match(err.message, /YAML parse error|corpus schema validation failed/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCorpus: throws with file path on schema violation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gym-corpus-"));
  try {
    const path = join(dir, "bad-schema.yaml");
    // Valid YAML, invalid schema (missing corpus.commit).
    await writeFile(
      path,
      [
        "language: python",
        "corpus:",
        "  name: sdk-python",
        "  path: sdk-python",
        "tool:",
        "  name: pyright",
        "  version: 1.1.390",
        "cases:",
        "  - id: sdk-python.callers.Agent",
        "    kind: callers",
        "    target:",
        "      symbolName: Agent",
        "      file: src/strands/agent/agent.py",
        "      line: 1",
        "      column: 1",
        "    expected: []",
        "",
      ].join("\n"),
      "utf-8",
    );
    await assert.rejects(
      () => loadCorpus(path),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /corpus schema validation failed/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("thiserror corpus has 13 cases", async () => {
  const corpus = await loadCorpus(thiserrorCorpusPath);
  assert.equal(corpus.language, "rust");
  assert.equal(corpus.corpus.name, "thiserror");
  assert.equal(corpus.corpus.commit, "72ae716e6d6a7f7fdabdc394018c745b4d39ca45");
  assert.equal(corpus.corpus.path, "rust/thiserror");
  assert.equal(corpus.tool.name, "rust-analyzer");
  assert.equal(corpus.cases.length, 13);
  const ids = new Set(corpus.cases.map((c) => c.id));
  assert.equal(ids.size, 13, "case ids must be unique");
  const kinds = new Map<string, number>();
  for (const c of corpus.cases) {
    kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    assert.ok(
      c.expected.length > 0,
      `thiserror case ${c.id} has an empty expected list but is not waived`,
    );
  }
  assert.equal(kinds.get("references"), 5);
  assert.equal(kinds.get("implementations"), 4);
  assert.equal(kinds.get("callers"), 4);
});

test("cobra corpus has 13 cases", async () => {
  const corpus = await loadCorpus(cobraCorpusPath);
  assert.equal(corpus.language, "go");
  assert.equal(corpus.corpus.name, "cobra");
  assert.equal(corpus.corpus.commit, "40b5bc1437a564fc795d388b23835e84f54cd1d1");
  assert.equal(corpus.corpus.path, "go/cobra");
  assert.equal(corpus.tool.name, "scip-go");
  assert.equal(corpus.tool.version, "0.2.3");
  assert.equal(corpus.cases.length, 13);
  const ids = new Set(corpus.cases.map((c) => c.id));
  assert.equal(ids.size, 13, "case ids must be unique");
  const kinds = new Map<string, number>();
  for (const c of corpus.cases) {
    kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    if (c.waived !== true) {
      assert.ok(
        c.expected.length > 0,
        `cobra case ${c.id} has an empty expected list but is not waived`,
      );
    }
  }
  assert.equal(kinds.get("implementations"), 2);
  assert.equal(kinds.get("references"), 5);
  assert.equal(kinds.get("callers"), 6);
  const waived = corpus.cases.filter((c) => c.waived === true);
  // Baseline waivers required by the corpus shape: the two `implementations`
  // cases (PositionalArgs + SliceValue) — PositionalArgs is a function type
  // and SliceValue's implementers live outside the fixture. Additional
  // auto-waivers from `refresh-expected.py` are allowed (they reflect
  // accurate SCIP behaviour on targets with zero matches in the fixture).
  const waivedIds = waived.map((c) => c.id);
  assert.ok(waivedIds.includes("cobra.implementations.PositionalArgs"));
  assert.ok(waivedIds.includes("cobra.implementations.SliceValue"));
});

test("ts-pattern corpus has 13 cases", async () => {
  const corpus = await loadCorpus(tsPatternCorpusPath);
  assert.equal(corpus.language, "typescript");
  assert.equal(corpus.corpus.name, "ts-pattern");
  assert.equal(corpus.corpus.commit, "1fed6208ee0c7f662e7e5239cdc7ee791e0fa246");
  assert.equal(corpus.corpus.path, "typescript/ts-pattern");
  assert.equal(corpus.tool.name, "scip-typescript");
  assert.equal(corpus.tool.version, "0.4.0");
  assert.equal(corpus.cases.length, 13);
  const ids = new Set(corpus.cases.map((c) => c.id));
  assert.equal(ids.size, 13, "case ids must be unique");
  const kinds = new Map<string, number>();
  for (const c of corpus.cases) {
    kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    if (c.waived !== true) {
      assert.ok(
        c.expected.length > 0,
        `ts-pattern case ${c.id} has an empty expected list but is not waived`,
      );
    }
  }
  assert.equal(kinds.get("references"), 6);
  assert.equal(kinds.get("callers"), 4);
  assert.equal(kinds.get("implementations"), 3);
  const waived = corpus.cases.filter((c) => c.waived === true);
  // Baseline: 3 implementations cases never resolve for ts-pattern's generic
  // types + auto-waivers emitted by `refresh-expected.py` when SCIP returns
  // zero hits inside the fixture.
  const waivedIds = waived.map((c) => c.id);
  assert.ok(waivedIds.includes("ts-pattern.implementations.Match"));
  assert.ok(waivedIds.includes("ts-pattern.implementations.MatchedValue"));
  assert.ok(waivedIds.includes("ts-pattern.implementations.Matcher"));
});

test("electron-ws-python typescript corpus has 5 cases", async () => {
  const corpus = await loadCorpus(electronWsPythonTsCorpusPath);
  assert.equal(corpus.language, "typescript");
  assert.equal(corpus.corpus.name, "electron-ws-python");
  assert.equal(corpus.corpus.commit, "92d563c20d86e87df9f946f1b2ad550b193905d6");
  assert.equal(corpus.corpus.path, "monorepo/electron-ws-python");
  assert.equal(corpus.tool.name, "scip-typescript");
  assert.equal(corpus.tool.version, "0.4.0");
  assert.equal(corpus.cases.length, 5);
  const ids = new Set(corpus.cases.map((c) => c.id));
  assert.equal(ids.size, 5, "case ids must be unique");
  const kinds = new Map<string, number>();
  for (const c of corpus.cases) {
    kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    if (c.waived !== true) {
      assert.ok(
        c.expected.length > 0,
        `electron-ws-python-typescript case ${c.id} has an empty expected list but is not waived`,
      );
    }
  }
  assert.equal(kinds.get("references"), 3);
  assert.equal(kinds.get("callers"), 2);
  const waived = corpus.cases.filter((c) => c.waived === true);
  // 2: the original cross-ambient-module reference, + the import-as-caller
  // waiver documented in the YAML (tsserver treats imports as non-callers,
  // which matches LSP semantics).
  assert.equal(waived.length, 2);
  assert.deepEqual(waived.map((c) => c.id).sort(), [
    "mono-ts.callers.registerScreenshotHandler",
    "mono-ts.references.window.quickwork.takeScreenshot",
  ]);
});

test("electron-ws-python python corpus has 4 cases", async () => {
  const corpus = await loadCorpus(electronWsPythonPyCorpusPath);
  assert.equal(corpus.language, "python");
  assert.equal(corpus.corpus.name, "electron-ws-python");
  assert.equal(corpus.corpus.commit, "92d563c20d86e87df9f946f1b2ad550b193905d6");
  assert.equal(corpus.corpus.path, "monorepo/electron-ws-python");
  assert.equal(corpus.tool.name, "scip-python");
  assert.equal(corpus.tool.version, "0.6.6");
  assert.equal(corpus.cases.length, 4);
  const ids = new Set(corpus.cases.map((c) => c.id));
  assert.equal(ids.size, 4, "case ids must be unique");
  const kinds = new Map<string, number>();
  for (const c of corpus.cases) {
    kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    if (c.waived !== true) {
      assert.ok(
        c.expected.length > 0,
        `electron-ws-python-python case ${c.id} has an empty expected list but is not waived`,
      );
    }
  }
  assert.equal(kinds.get("references"), 2);
  assert.equal(kinds.get("callers"), 2);
  const waived = corpus.cases.filter((c) => c.waived === true);
  assert.equal(waived.length, 1);
  assert.equal(waived[0]?.id, "mono-py.callers.handle_user_message_cross_language");
});
