import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCommand } from "./cli.js";
import type {
  CallerSite,
  ImplementationSite,
  LspClientLike,
  LspFactory,
  QueryCallersInput,
  QueryImplementationsInput,
  QueryReferencesInput,
  ReferenceSite,
} from "./lsp-factory.js";
import type { ManifestLanguage } from "./manifest.js";
import { replayManifest, runGym } from "./runner.js";

/**
 * Scripted response for a single case. Keys are `${kind}:${symbolName}`
 * so a mock client can respond differently to each case in a corpus
 * without resorting to positional matching.
 */
type ScriptKey = `${"references" | "implementations" | "callers"}:${string}`;

interface MockScript {
  readonly responses: Readonly<Record<ScriptKey, ReadonlyArray<MockSite>>>;
}

interface MockSite {
  readonly file: string;
  readonly line: number;
  readonly character: number;
  readonly enclosingSymbolName?: string;
}

interface MockState {
  readonly started: Set<string>;
  readonly warmupCalls: Array<{ language: ManifestLanguage; files: readonly string[] }>;
}

function scriptKey(
  kind: "references" | "implementations" | "callers",
  symbolName: string,
): ScriptKey {
  return `${kind}:${symbolName}` as ScriptKey;
}

class MockClient implements LspClientLike {
  constructor(
    private readonly language: ManifestLanguage,
    private readonly script: MockScript,
    private readonly state: MockState,
  ) {}

  async start(): Promise<void> {
    this.state.started.add(`${this.language}:started`);
  }

  async stop(): Promise<void> {
    this.state.started.delete(`${this.language}:started`);
  }

  async warmup(files: readonly string[]): Promise<void> {
    this.state.warmupCalls.push({ language: this.language, files });
  }

  async queryReferences(_input: QueryReferencesInput): Promise<readonly ReferenceSite[]> {
    const hits = this.pickByFile(_input.filePath);
    return hits.map((h) => ({ file: h.file, line: h.line, character: h.character }));
  }

  async queryImplementations(
    _input: QueryImplementationsInput,
  ): Promise<readonly ImplementationSite[]> {
    const hits = this.pickByFile(_input.filePath);
    return hits.map((h) => ({ file: h.file, line: h.line, character: h.character }));
  }

  async queryCallers(input: QueryCallersInput): Promise<readonly CallerSite[]> {
    const key = scriptKey("callers", input.symbolName);
    const hits = this.script.responses[key] ?? [];
    return hits.map((h) => ({
      file: h.file,
      line: h.line,
      character: h.character,
      source: "callHierarchy",
      ...(h.enclosingSymbolName !== undefined
        ? { enclosingSymbolName: h.enclosingSymbolName }
        : {}),
    }));
  }

  // Tests match on symbolName via scriptKey for callers; references +
  // implementations key off `${kind}:${filePath.basename}`. That keeps
  // the mock small without forcing callers to build a full 2D table.
  private pickByFile(filePath: string): ReadonlyArray<MockSite> {
    const needle = filePath.split("/").pop() ?? filePath;
    for (const [k, v] of Object.entries(this.script.responses) as [
      ScriptKey,
      readonly MockSite[],
    ][]) {
      const [, sym] = k.split(":") as ["references" | "implementations" | "callers", string];
      if (sym === needle || k.endsWith(`:${needle}`)) return v;
    }
    // Fall back to the first "references:*" or "implementations:*" entry
    // so single-case tests don't need to pin the target basename.
    for (const [k, v] of Object.entries(this.script.responses) as [
      ScriptKey,
      readonly MockSite[],
    ][]) {
      if (k.startsWith("references:") || k.startsWith("implementations:")) return v;
    }
    return [];
  }
}

function mockFactory(
  scripts: Partial<Record<ManifestLanguage, MockScript>>,
  state: MockState,
): LspFactory {
  return {
    create(language, _fixtureRoot) {
      const script = scripts[language] ?? { responses: {} };
      return new MockClient(language, script, state);
    },
  };
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "gym-runner-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CORPUS_COMMIT = "1111111111111111111111111111111111111111";

function writeTsCorpus(
  dir: string,
  name = "ts-pattern",
  language: ManifestLanguage = "typescript",
  cases: Array<{
    id: string;
    kind: "references" | "implementations" | "callers";
    symbolName: string;
    file: string;
    line: number;
    column: number;
    expected: Array<{ file: string; line: number; column: number }>;
    waived?: true;
  }> = [],
): Promise<string> {
  const casesYaml = cases
    .map((c) => {
      const lines: string[] = [];
      lines.push(`  - id: ${c.id}`);
      lines.push(`    kind: ${c.kind}`);
      lines.push(`    target:`);
      lines.push(`      symbolName: ${c.symbolName}`);
      lines.push(`      file: ${c.file}`);
      lines.push(`      line: ${c.line}`);
      lines.push(`      column: ${c.column}`);
      if (c.waived === true) lines.push(`    waived: true`);
      lines.push(`    expected:`);
      for (const e of c.expected) {
        lines.push(`      - file: ${e.file}`);
        lines.push(`        line: ${e.line}`);
        lines.push(`        column: ${e.column}`);
      }
      return lines.join("\n");
    })
    .join("\n");

  const toolName = language === "typescript" ? "typescript-language-server" : "pyright";
  const toolVersion = language === "typescript" ? "5.1.3" : "1.1.390";
  const body = [
    `language: ${language}`,
    `corpus:`,
    `  name: ${name}`,
    `  commit: "${CORPUS_COMMIT}"`,
    `  path: ${language}/${name}`,
    `tool:`,
    `  name: ${toolName}`,
    `  version: ${toolVersion}`,
    `cases:`,
    casesYaml,
    "",
  ].join("\n");

  const path = join(dir, `${language}-${name}.yaml`);
  return writeFile(path, body, "utf-8").then(() => path);
}

/**
 * Create the fixture directory that the runner probes via
 * `fixtureExists`. Tests that want to exercise the happy path pass
 * their tmp dir as `repoRoot` and then call this to ensure the
 * `${repoRoot}/${corpus.path}` directory is present.
 */
async function ensureFixture(
  repoRoot: string,
  language: ManifestLanguage,
  name: string,
): Promise<void> {
  await mkdir(join(repoRoot, language, name), { recursive: true });
}

test("runGym: single-language TypeScript run writes manifest + scores both cases", async () => {
  await withTmpDir(async (dir) => {
    await ensureFixture(dir, "typescript", "ts-pattern");
    const corpusPath = await writeTsCorpus(dir, "ts-pattern", "typescript", [
      {
        id: "ts.references.match",
        kind: "references",
        symbolName: "match",
        file: "src/match.ts",
        line: 10,
        column: 5,
        expected: [
          { file: "src/match.ts", line: 20, column: 3 },
          { file: "src/other.ts", line: 7, column: 9 },
        ],
      },
      {
        id: "ts.callers.match",
        kind: "callers",
        symbolName: "match",
        file: "src/match.ts",
        line: 10,
        column: 5,
        expected: [{ file: "src/caller.ts", line: 12, column: 1 }],
      },
    ]);

    const state: MockState = { started: new Set(), warmupCalls: [] };
    const scripts: Partial<Record<ManifestLanguage, MockScript>> = {
      typescript: {
        responses: {
          "references:match.ts": [
            { file: "src/match.ts", line: 20, character: 3 },
            { file: "src/other.ts", line: 7, character: 9 },
          ],
          "callers:match": [{ file: "src/caller.ts", line: 12, character: 1 }],
        },
      },
    };
    const output = join(dir, "manifest.jsonl");
    const result = await runGym({
      corpusPaths: [corpusPath],
      repoRoot: dir,
      lspFactory: mockFactory(scripts, state),
      outputManifestPath: output,
    });

    assert.equal(result.manifest.length, 2);
    assert.equal(result.caseScores.length, 2);
    for (const s of result.caseScores) {
      assert.equal(s.scores.f1, 1);
    }
    assert.equal(result.summary.totalCases, 2);
    assert.equal(result.summary.passed, 2);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.waived, 0);
    // One rollup per (language, tool, kind).
    const rollupKeys = result.rollups.map((r) => r.key).sort();
    assert.deepEqual(rollupKeys, [
      "typescript/typescript-language-server/callers",
      "typescript/typescript-language-server/references",
    ]);
    // Warmup was invoked once with both the target + expected files.
    assert.equal(state.warmupCalls.length, 1);
    const seen = new Set(state.warmupCalls[0]?.files ?? []);
    assert.ok(seen.has("src/match.ts"));
    assert.ok(seen.has("src/other.ts"));
    assert.ok(seen.has("src/caller.ts"));
    // Manifest JSONL has two records.
    const raw = await readFile(output, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
  });
});

test("runGym: multi-language run separates rollups per language", async () => {
  await withTmpDir(async (dir) => {
    await ensureFixture(dir, "typescript", "ts-only");
    await ensureFixture(dir, "python", "py-only");
    const tsCorpus = await writeTsCorpus(dir, "ts-only", "typescript", [
      {
        id: "ts.refs",
        kind: "references",
        symbolName: "alpha",
        file: "src/alpha.ts",
        line: 1,
        column: 1,
        expected: [{ file: "src/alpha.ts", line: 5, column: 2 }],
      },
    ]);
    const pyCorpus = await writeTsCorpus(dir, "py-only", "python", [
      {
        id: "py.refs",
        kind: "references",
        symbolName: "beta",
        file: "src/beta.py",
        line: 1,
        column: 1,
        expected: [{ file: "src/beta.py", line: 9, column: 3 }],
      },
    ]);

    const state: MockState = { started: new Set(), warmupCalls: [] };
    const scripts: Partial<Record<ManifestLanguage, MockScript>> = {
      typescript: {
        responses: {
          "references:alpha.ts": [{ file: "src/alpha.ts", line: 5, character: 2 }],
        },
      },
      python: {
        responses: {
          "references:beta.py": [{ file: "src/beta.py", line: 9, character: 3 }],
        },
      },
    };

    const result = await runGym({
      corpusPaths: [tsCorpus, pyCorpus],
      repoRoot: dir,
      lspFactory: mockFactory(scripts, state),
    });

    assert.equal(result.caseScores.length, 2);
    const rollupKeys = result.rollups.map((r) => r.key).sort();
    assert.deepEqual(rollupKeys, [
      "python/pyright/references",
      "typescript/typescript-language-server/references",
    ]);
    // Each rollup has exactly one case.
    for (const r of result.rollups) {
      assert.equal(r.caseCount, 1);
      assert.equal(r.f1, 1);
    }
  });
});

test("runGym: waived cases appear in the manifest but are excluded from scoring", async () => {
  await withTmpDir(async (dir) => {
    await ensureFixture(dir, "typescript", "waive");
    const corpusPath = await writeTsCorpus(dir, "waive", "typescript", [
      {
        id: "ts.kept",
        kind: "references",
        symbolName: "keep",
        file: "src/keep.ts",
        line: 1,
        column: 1,
        expected: [{ file: "src/keep.ts", line: 2, column: 1 }],
      },
      {
        id: "ts.waived",
        kind: "references",
        symbolName: "waived",
        file: "src/waived.ts",
        line: 1,
        column: 1,
        expected: [{ file: "src/waived.ts", line: 2, column: 1 }],
        waived: true,
      },
    ]);

    const state: MockState = { started: new Set(), warmupCalls: [] };
    const scripts: Partial<Record<ManifestLanguage, MockScript>> = {
      typescript: {
        responses: {
          "references:keep.ts": [{ file: "src/keep.ts", line: 2, character: 1 }],
          "references:waived.ts": [{ file: "src/waived.ts", line: 2, character: 1 }],
        },
      },
    };

    const result = await runGym({
      corpusPaths: [corpusPath],
      repoRoot: dir,
      lspFactory: mockFactory(scripts, state),
    });

    assert.equal(result.manifest.length, 2);
    assert.equal(result.caseScores.length, 1);
    assert.equal(result.caseScores[0]?.caseId, "ts.kept");
    assert.equal(result.summary.waived, 1);
    // Waived record carries the flag through to the manifest output.
    const waivedRec = result.manifest.find((m) => m.request.target.symbolName === "waived");
    assert.equal(waivedRec?.waived, true);
  });
});

test("runGym: dynamic waivedCaseIds override excludes from scoring without manifest change", async () => {
  await withTmpDir(async (dir) => {
    await ensureFixture(dir, "typescript", "waive-dyn");
    const corpusPath = await writeTsCorpus(dir, "waive-dyn", "typescript", [
      {
        id: "ts.dyn",
        kind: "references",
        symbolName: "x",
        file: "src/x.ts",
        line: 1,
        column: 1,
        expected: [{ file: "src/x.ts", line: 2, column: 1 }],
      },
    ]);
    const state: MockState = { started: new Set(), warmupCalls: [] };
    const scripts: Partial<Record<ManifestLanguage, MockScript>> = {
      typescript: {
        responses: { "references:x.ts": [{ file: "src/x.ts", line: 999, character: 999 }] },
      },
    };
    const result = await runGym({
      corpusPaths: [corpusPath],
      repoRoot: dir,
      lspFactory: mockFactory(scripts, state),
      waivedCaseIds: new Set(["ts.dyn"]),
    });
    assert.equal(result.manifest.length, 1);
    assert.equal(result.caseScores.length, 0);
    assert.equal(result.summary.waived, 1);
  });
});

test("replayManifest: re-scores a frozen manifest bit-for-bit without an LSP", async () => {
  await withTmpDir(async (dir) => {
    await ensureFixture(dir, "typescript", "replay");
    const corpusPath = await writeTsCorpus(dir, "replay", "typescript", [
      {
        id: "ts.replay",
        kind: "references",
        symbolName: "r",
        file: "src/r.ts",
        line: 1,
        column: 1,
        expected: [{ file: "src/r.ts", line: 5, column: 1 }],
      },
    ]);
    const state: MockState = { started: new Set(), warmupCalls: [] };
    const scripts: Partial<Record<ManifestLanguage, MockScript>> = {
      typescript: {
        responses: { "references:r.ts": [{ file: "src/r.ts", line: 5, character: 1 }] },
      },
    };
    const manifestPath = join(dir, "manifest.jsonl");
    const run = await runGym({
      corpusPaths: [corpusPath],
      repoRoot: dir,
      lspFactory: mockFactory(scripts, state),
      outputManifestPath: manifestPath,
    });
    const replay = await replayManifest({ manifestPath, corpusPaths: [corpusPath] });
    assert.equal(replay.caseScores.length, run.caseScores.length);
    assert.equal(replay.caseScores[0]?.scores.f1, run.caseScores[0]?.scores.f1);
    assert.equal(replay.caseScores[0]?.caseId, "ts.replay");
  });
});

test("runGym: missing fixture directory records waived stubs and continues", async () => {
  await withTmpDir(async (dir) => {
    // Corpus path points at a subdir that doesn't exist under repoRoot.
    const corpusPath = await writeTsCorpus(dir, "absent", "typescript", [
      {
        id: "ts.absent",
        kind: "references",
        symbolName: "g",
        file: "src/g.ts",
        line: 1,
        column: 1,
        expected: [{ file: "src/g.ts", line: 2, column: 1 }],
      },
    ]);
    const state: MockState = { started: new Set(), warmupCalls: [] };
    // repoRoot is a non-existent directory so fixtureExists returns false.
    const result = await runGym({
      corpusPaths: [corpusPath],
      repoRoot: join(dir, "does-not-exist"),
      lspFactory: mockFactory({}, state),
    });
    assert.equal(result.manifest.length, 1);
    assert.equal(result.manifest[0]?.waived, true);
    assert.equal(result.caseScores.length, 0);
    assert.equal(result.summary.waived, 1);
    // Start was never called because we short-circuited before creating
    // a client — a real LSP subprocess would be expensive.
    assert.equal(state.started.size, 0);
  });
});

test("runCommand: CLI handler exits 0 on success with a tmp corpus + mock factory", async () => {
  await withTmpDir(async (dir) => {
    await ensureFixture(dir, "typescript", "cli-smoke");
    const corpusPath = await writeTsCorpus(dir, "cli-smoke", "typescript", [
      {
        id: "ts.cli",
        kind: "references",
        symbolName: "c",
        file: "src/c.ts",
        line: 1,
        column: 1,
        expected: [{ file: "src/c.ts", line: 2, column: 1 }],
      },
    ]);
    const state: MockState = { started: new Set(), warmupCalls: [] };
    const scripts: Partial<Record<ManifestLanguage, MockScript>> = {
      typescript: {
        responses: { "references:c.ts": [{ file: "src/c.ts", line: 2, character: 1 }] },
      },
    };
    const code = await runCommand({
      corpus: corpusPath,
      repoRoot: dir,
      lspFactory: mockFactory(scripts, state),
      output: join(dir, "run-manifest.jsonl"),
    });
    assert.equal(code, 0);
  });
});

test("runCommand: gate failure returns exit code 1 when F1 falls under the floor", async () => {
  await withTmpDir(async (dir) => {
    await ensureFixture(dir, "typescript", "fail");
    // Goldens expect 5 hits; mock returns 1 → precision=1, recall=0.2, f1≈0.33,
    // well under the typescript floor of 0.9.
    const corpusPath = await writeTsCorpus(dir, "fail", "typescript", [
      {
        id: "ts.fail",
        kind: "references",
        symbolName: "f",
        file: "src/f.ts",
        line: 1,
        column: 1,
        expected: [
          { file: "src/f.ts", line: 2, column: 1 },
          { file: "src/f.ts", line: 3, column: 1 },
          { file: "src/f.ts", line: 4, column: 1 },
          { file: "src/f.ts", line: 5, column: 1 },
          { file: "src/f.ts", line: 6, column: 1 },
        ],
      },
    ]);
    const state: MockState = { started: new Set(), warmupCalls: [] };
    const scripts: Partial<Record<ManifestLanguage, MockScript>> = {
      typescript: {
        responses: { "references:f.ts": [{ file: "src/f.ts", line: 2, character: 1 }] },
      },
    };
    // We need a baseline for the gate suite to run; an empty manifest works
    // because the F1 floor check inspects *current* rollups regardless.
    const baselinePath = join(dir, "empty-baseline.jsonl");
    await writeFile(baselinePath, "", "utf-8");

    const thresholdsPath = join(dir, "thresholds.json");
    await writeFile(
      thresholdsPath,
      JSON.stringify({
        schemaVersion: 1,
        languages: {
          python: { f1Floor: 0.95, f1DeltaTolerance: 0.005 },
          typescript: { f1Floor: 0.9, f1DeltaTolerance: 0.01 },
          go: { f1Floor: 0.9, f1DeltaTolerance: 0.01 },
          rust: { f1Floor: 0.85, f1DeltaTolerance: 0.015 },
        },
      }),
      "utf-8",
    );

    const code = await runCommand({
      corpus: corpusPath,
      repoRoot: dir,
      lspFactory: mockFactory(scripts, state),
      baseline: baselinePath,
      thresholds: thresholdsPath,
    });
    assert.equal(code, 1);
  });
});
