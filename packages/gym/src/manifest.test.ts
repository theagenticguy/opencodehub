import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalize,
  fingerprint,
  type ManifestRecord,
  manifestRecordSchema,
  readManifest,
  writeManifest,
} from "./manifest.js";

function baseRecord(overrides: Partial<ManifestRecord> = {}): ManifestRecord {
  const base: ManifestRecord = {
    manifest_version: "1",
    language: "python",
    corpus: {
      name: "sdk-python",
      commit: "a".repeat(40),
      path: "sdk-python",
    },
    tool: {
      name: "pyright",
      version: "1.1.390",
    },
    request: {
      kind: "references",
      target: {
        symbolName: "Agent.invoke",
        file: "src/agent.py",
        line: 42,
        column: 9,
      },
    },
    result_set: [
      { file: "src/agent.py", line: 42, column: 9 },
      { file: "tests/test_agent.py", line: 11, column: 5, enclosing: "test_invoke" },
    ],
    captured_at: "2026-04-23T18:00:00.000Z",
  };
  return { ...base, ...overrides };
}

test("manifestRecordSchema: valid record round-trips through canonicalize + parse", () => {
  const record = baseRecord();
  const parsed = manifestRecordSchema.parse(record);
  const canonical = canonicalize(parsed);
  const reparsed = manifestRecordSchema.parse(JSON.parse(canonical));
  assert.deepEqual(reparsed, parsed);
});

test("canonicalize: identical output regardless of input key order", () => {
  const a = baseRecord();
  // Build a reordered object with the same content but different key order.
  const reordered: ManifestRecord = {
    captured_at: a.captured_at,
    result_set: [
      { column: 9, file: "src/agent.py", line: 42 },
      {
        enclosing: "test_invoke",
        column: 5,
        file: "tests/test_agent.py",
        line: 11,
      },
    ],
    request: {
      target: {
        column: a.request.target.column,
        line: a.request.target.line,
        file: a.request.target.file,
        symbolName: a.request.target.symbolName,
      },
      kind: a.request.kind,
    },
    tool: { version: a.tool.version, name: a.tool.name },
    corpus: { path: a.corpus.path, commit: a.corpus.commit, name: a.corpus.name },
    language: a.language,
    manifest_version: a.manifest_version,
  };
  assert.equal(canonicalize(a), canonicalize(reordered));
});

test("writeManifest + readManifest: round-trips a 3-record list losslessly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gym-manifest-"));
  try {
    const path = join(dir, "m.jsonl");
    const records: ManifestRecord[] = [
      baseRecord(),
      baseRecord({
        request: {
          kind: "implementations",
          target: {
            symbolName: "BaseAgent",
            file: "src/base.py",
            line: 5,
            column: 7,
          },
        },
      }),
      baseRecord({
        tool: { name: "pyright", version: "1.1.390", sha256: "f".repeat(64) },
        labeler: "opus-4-7",
        labeler_note: "auto-labeled from differential run",
        waived: true,
      }),
    ];
    await writeManifest(path, records);
    const read = await readManifest(path);
    assert.equal(read.length, 3);
    for (let i = 0; i < records.length; i++) {
      assert.deepEqual(read[i], records[i]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readManifest: throws with line number on malformed record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gym-manifest-"));
  try {
    const path = join(dir, "bad.jsonl");
    const good = canonicalize(baseRecord());
    // Missing corpus.commit.
    const badRecord = baseRecord();
    const badObject = {
      ...badRecord,
      corpus: { name: badRecord.corpus.name, path: badRecord.corpus.path },
    };
    const badLine = JSON.stringify(badObject);
    // Wrong language enum on line 3.
    const wrongLang = JSON.stringify({ ...baseRecord(), language: "ruby" });
    await (await import("node:fs/promises")).writeFile(
      path,
      `${good}\n${badLine}\n${wrongLang}\n`,
      "utf-8",
    );
    await assert.rejects(
      () => readManifest(path),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /:2:/);
        assert.match(err.message, /schema validation failed/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fingerprint: stable across key reorderings and ignores volatile fields", () => {
  const a = baseRecord();
  const b = baseRecord({
    result_set: [{ file: "elsewhere.py", line: 1, column: 1 }],
    captured_at: "2027-01-01T00:00:00.000Z",
    labeler: "opus-4-7",
    labeler_note: "different note",
    waived: true,
  });
  assert.equal(fingerprint(a), fingerprint(b));

  // Reordered top-level object: build a fresh record with a different insertion order.
  const reordered: ManifestRecord = {
    result_set: a.result_set,
    captured_at: a.captured_at,
    request: a.request,
    tool: a.tool,
    corpus: a.corpus,
    language: a.language,
    manifest_version: a.manifest_version,
  };
  assert.equal(fingerprint(a), fingerprint(reordered));
});

test("fingerprint: differs when target changes", () => {
  const a = baseRecord();
  const b = baseRecord({
    request: {
      kind: "references",
      target: {
        symbolName: "Agent.invoke",
        file: "src/agent.py",
        line: 43,
        column: 9,
      },
    },
  });
  assert.notEqual(fingerprint(a), fingerprint(b));
});
