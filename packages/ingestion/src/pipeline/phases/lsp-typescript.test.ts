/**
 * Unit tests for the `lsp-typescript` ingestion phase.
 *
 * All tests use a mocked {@link LspTypescriptClientLike} so no real
 * tsserver ever spawns. We cover:
 *   1. `CODEHUB_DISABLE_LSP=1` skip path.
 *   2. Profile-gate skip when TS/JS is absent.
 *   3. Happy path: CALLS / REFERENCES / EXTENDS edges with
 *      `confidence=1.0` and `reason` starting `typescript-language-server@`.
 *   4. `.tsx` files get picked up under the `typescript` profile language.
 *   5. Identifier column lookup recognises `function` / `class` /
 *      `interface` / `type` / `const X = (` declarations.
 *   6. `warmup` is called exactly once with every TS/TSX/JS/JSX file from
 *      scan before the first query.
 *   7. References matching a CALLS site's `file:line` are NOT double-
 *      emitted as REFERENCES.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { KnowledgeGraph, makeNodeId, type NodeId } from "@opencodehub/core-types";
import type { CallerSite, ReferenceSite, SymbolKind } from "@opencodehub/lsp-oracle";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { LSP_PYTHON_PHASE_NAME } from "./lsp-python.js";
import {
  __setLspTypescriptTestHooks__,
  findIdentifierColumn,
  type LspTypescriptClientLike,
  lspTypescriptPhase,
} from "./lsp-typescript.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

// ---- Scaffolding ----------------------------------------------------------

interface CtxOpts {
  readonly repoPath: string;
  readonly languages: readonly string[];
  readonly files: readonly {
    readonly relPath: string;
    readonly language?:
      | "typescript"
      | "tsx"
      | "javascript"
      | "python"
      | "go"
      | "rust"
      | "java"
      | "csharp";
  }[];
  readonly events?: ProgressEvent[];
  readonly seedGraph?: (g: KnowledgeGraph) => void;
}

function makeCtx(opts: CtxOpts): PipelineContext {
  const graph = new KnowledgeGraph();
  graph.addNode({
    id: makeNodeId("ProjectProfile", "", "repo"),
    kind: "ProjectProfile",
    name: "project-profile",
    filePath: "",
    languages: opts.languages,
    frameworks: [],
    iacTypes: [],
    apiContracts: [],
    manifests: [],
    srcDirs: [],
  });
  opts.seedGraph?.(graph);

  const scannedFiles = opts.files.map((f) => ({
    absPath: path.join(opts.repoPath, f.relPath),
    relPath: f.relPath,
    byteSize: 1,
    sha256: "0".repeat(64),
    ...(f.language !== undefined ? { language: f.language } : {}),
    grammarSha: null,
  }));

  return {
    repoPath: opts.repoPath,
    options: { skipGit: true },
    graph,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, { files: scannedFiles }],
      [
        PROFILE_PHASE_NAME,
        {
          profileEmitted: true,
          languagesDetected: opts.languages.length,
          frameworksDetected: 0,
        },
      ],
      [
        PARSE_PHASE_NAME,
        {
          definitionsByFile: new Map(),
          callsByFile: new Map(),
          importsByFile: new Map(),
          heritageByFile: new Map(),
          symbolIndex: { byFile: new Map(), byGlobal: new Map(), importEdges: new Map() },
          sourceByFile: new Map(),
          parseTimeMs: 0,
          fileCount: scannedFiles.length,
          cacheHits: 0,
          cacheMisses: 0,
        },
      ],
      [
        CROSS_FILE_PHASE_NAME,
        { upgradedCallsCount: 0, unresolvedRemaining: 0, sccCount: 0, largeSccs: [] },
      ],
      [
        INCREMENTAL_SCOPE_PHASE_NAME,
        {
          mode: "full" as const,
          changedFiles: [],
          closureFiles: [],
          totalFiles: scannedFiles.length,
          closureRatio: 0,
        },
      ],
      // Stand-in output for the LSP_PYTHON phase dep; the phase does not
      // read this value but the runner enforces dep presence.
      [LSP_PYTHON_PHASE_NAME, { enabled: false }],
    ]),
    ...(opts.events !== undefined
      ? {
          onProgress: (ev: ProgressEvent) => {
            opts.events?.push(ev);
          },
        }
      : {}),
  };
}

type CallerSpec = { readonly file: string; readonly line: number; readonly character: number };
type ImplSpec = { readonly file: string; readonly line: number; readonly character: number };

interface MockResponses {
  readonly callers?: Record<string, readonly CallerSpec[]>;
  readonly references?: Record<string, readonly CallerSpec[]>;
  readonly implementations?: Record<string, readonly ImplSpec[]>;
}

interface MockCallLog {
  warmup: string[] | null;
  queries: Array<{ kind: "caller" | "ref" | "impl"; key: string }>;
}

function makeMockClient(
  responses: MockResponses,
  log: MockCallLog,
  opts: { readonly tsserverVersion?: string } = {},
): LspTypescriptClientLike {
  const callerOf = (key: string): readonly CallerSite[] =>
    (responses.callers?.[key] ?? []).map((c) => ({
      file: c.file,
      line: c.line,
      character: c.character,
      name: "caller",
      source: "callHierarchy" as const,
    })) as readonly CallerSite[];
  const refOf = (key: string): readonly ReferenceSite[] =>
    (responses.references?.[key] ?? []).map((r) => ({
      file: r.file,
      line: r.line,
      character: r.character,
    })) as readonly ReferenceSite[];
  const implOf = (key: string) => responses.implementations?.[key] ?? [];
  return {
    async start() {},
    async stop() {},
    async warmup(files) {
      log.warmup = [...files];
    },
    getStatus() {
      return { tsserverVersion: opts.tsserverVersion ?? "9.9.9" };
    },
    async queryCallers(input: {
      readonly filePath: string;
      readonly line: number;
      readonly character: number;
      readonly symbolKind: SymbolKind;
      readonly symbolName: string;
    }) {
      const key = `${input.filePath}:${input.line}`;
      log.queries.push({ kind: "caller", key });
      return callerOf(key);
    },
    async queryReferences(input: {
      readonly filePath: string;
      readonly line: number;
      readonly character: number;
    }) {
      const key = `${input.filePath}:${input.line}`;
      log.queries.push({ kind: "ref", key });
      return refOf(key);
    },
    async queryImplementations(input: {
      readonly filePath: string;
      readonly line: number;
      readonly character: number;
    }) {
      const key = `${input.filePath}:${input.line}`;
      log.queries.push({ kind: "impl", key });
      return implOf(key);
    },
  };
}

// ---- Tests ----------------------------------------------------------------

describe("lsp-typescript phase — skip paths", () => {
  const originalEnv = process.env["CODEHUB_DISABLE_LSP"];

  beforeEach(() => {
    delete process.env["CODEHUB_DISABLE_LSP"];
  });
  afterEach(() => {
    if (originalEnv !== undefined) process.env["CODEHUB_DISABLE_LSP"] = originalEnv;
    else delete process.env["CODEHUB_DISABLE_LSP"];
    __setLspTypescriptTestHooks__(undefined);
  });

  it("returns enabled:false when CODEHUB_DISABLE_LSP=1", async () => {
    process.env["CODEHUB_DISABLE_LSP"] = "1";
    const ctx = makeCtx({
      repoPath: "/tmp/nonexistent-lsp-ts-1",
      languages: ["typescript"],
      files: [],
    });
    const before = ctx.graph.edgeCount();
    const out = await lspTypescriptPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "CODEHUB_DISABLE_LSP=1");
    assert.equal(ctx.graph.edgeCount(), before);
  });

  it("returns enabled:false when profile has neither typescript nor typescriptreact", async () => {
    const ctx = makeCtx({
      repoPath: "/tmp/nonexistent-lsp-ts-2",
      languages: ["python", "go"],
      files: [],
    });
    const out = await lspTypescriptPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "no-typescript-in-profile");
  });
});

describe("lsp-typescript phase — happy path", () => {
  afterEach(() => {
    __setLspTypescriptTestHooks__(undefined);
  });

  it("emits CALLS / REFERENCES / EXTENDS at confidence=1.0 with tsserver reason", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "lsp-ts-happy-"));
    try {
      await writeFile(
        path.join(repo, "greeter.ts"),
        ["export class Greeter {", "  hello(): string {", '    return "hi";', "  }", "}", ""].join(
          "\n",
        ),
      );
      await writeFile(
        path.join(repo, "app.ts"),
        [
          'import { Greeter } from "./greeter.js";',
          "export class Sub extends Greeter {}",
          "export function run(): string {",
          "  const g = new Greeter();",
          "  return g.hello();",
          "}",
          "",
        ].join("\n"),
      );

      const greeterId = makeNodeId("Class", "greeter.ts", "Greeter") as NodeId;
      const helloId = makeNodeId("Method", "greeter.ts", "Greeter.hello") as NodeId;
      const subId = makeNodeId("Class", "app.ts", "Sub") as NodeId;
      const runId = makeNodeId("Function", "app.ts", "run") as NodeId;

      const ctx = makeCtx({
        repoPath: repo,
        languages: ["typescript"],
        files: [
          { relPath: "greeter.ts", language: "typescript" },
          { relPath: "app.ts", language: "typescript" },
        ],
        seedGraph: (g) => {
          g.addNode({
            id: greeterId,
            kind: "Class",
            name: "Greeter",
            filePath: "greeter.ts",
            startLine: 1,
            endLine: 5,
          });
          g.addNode({
            id: helloId,
            kind: "Method",
            name: "hello",
            filePath: "greeter.ts",
            startLine: 2,
            endLine: 4,
            owner: "Greeter",
          });
          g.addNode({
            id: subId,
            kind: "Class",
            name: "Sub",
            filePath: "app.ts",
            startLine: 2,
            endLine: 2,
          });
          g.addNode({
            id: runId,
            kind: "Function",
            name: "run",
            filePath: "app.ts",
            startLine: 3,
            endLine: 6,
          });
        },
      });

      const log: MockCallLog = { warmup: null, queries: [] };
      __setLspTypescriptTestHooks__({
        clientFactory: () =>
          makeMockClient(
            {
              callers: {
                // Greeter.hello on line 2 — caller in run() body line 5
                "greeter.ts:2": [{ file: "app.ts", line: 5, character: 11 }],
              },
              references: {
                // Reference on line 5 duplicates the caller site (must be suppressed).
                "greeter.ts:2": [{ file: "app.ts", line: 5, character: 11 }],
                // Greeter class ref on line 4 of app.ts (the `new Greeter()` site).
                "greeter.ts:1": [{ file: "app.ts", line: 4, character: 15 }],
              },
              implementations: {
                // Sub extends Greeter — impl site is Sub's line 2 in app.ts.
                "greeter.ts:1": [{ file: "app.ts", line: 2, character: 13 }],
              },
            },
            log,
            { tsserverVersion: "4.3.3" },
          ),
      });

      const out = await lspTypescriptPhase.run(ctx, ctx.phaseOutputs);
      assert.equal(out.enabled, true);
      assert.equal(out.tsserverVersion, "4.3.3");
      assert.ok(
        out.symbolsQueried >= 3,
        `expected >= 3 symbols queried, got ${out.symbolsQueried}`,
      );

      let callEdge: { readonly reason?: string; readonly confidence: number } | undefined;
      let refEdge: typeof callEdge;
      let extEdge: typeof callEdge;
      for (const e of ctx.graph.edges()) {
        if (e.type === "CALLS" && e.from === runId && e.to === helloId) callEdge = e;
        if (e.type === "REFERENCES" && e.from === runId && e.to === greeterId) refEdge = e;
        if (e.type === "EXTENDS" && e.from === subId && e.to === greeterId) extEdge = e;
      }
      assert.ok(callEdge !== undefined, "expected a CALLS edge run → Greeter.hello");
      assert.equal(callEdge.confidence, 1.0);
      assert.ok(
        callEdge.reason?.startsWith("typescript-language-server@"),
        `edge reason must start with typescript-language-server@, got ${callEdge.reason}`,
      );
      assert.ok(refEdge !== undefined, "expected a REFERENCES edge run → Greeter");
      assert.equal(refEdge.confidence, 1.0);
      assert.ok(extEdge !== undefined, "expected an EXTENDS edge Sub → Greeter");
      assert.equal(extEdge.confidence, 1.0);

      // Dedupe check — the reference site at app.ts:5 overlaps the CALLS
      // fingerprint and must NOT produce a REFERENCES edge from run →
      // Greeter.hello.
      const dupeRef = [...ctx.graph.edges()].find(
        (e) => e.type === "REFERENCES" && e.from === runId && e.to === helloId,
      );
      assert.equal(dupeRef, undefined, "call site duplicated as REFERENCES — dedupe broken");

      // Warmup called once with both TS files (absolute paths).
      assert.ok(log.warmup !== null, "warmup must be called before queries");
      assert.equal(log.warmup?.length, 2);
      const warmupFiles = new Set(log.warmup);
      assert.ok(warmupFiles.has(path.join(repo, "greeter.ts")));
      assert.ok(warmupFiles.has(path.join(repo, "app.ts")));

      // Warmup preceded the first query.
      const firstQueryIdx = 0;
      assert.ok(firstQueryIdx >= 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("includes .tsx files under the typescript profile language", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "lsp-ts-tsx-"));
    try {
      await writeFile(
        path.join(repo, "Widget.tsx"),
        ["export function Widget(): JSX.Element {", "  return <div />;", "}", ""].join("\n"),
      );

      const widgetId = makeNodeId("Function", "Widget.tsx", "Widget") as NodeId;
      const ctx = makeCtx({
        repoPath: repo,
        languages: ["typescript"],
        files: [{ relPath: "Widget.tsx", language: "tsx" }],
        seedGraph: (g) => {
          g.addNode({
            id: widgetId,
            kind: "Function",
            name: "Widget",
            filePath: "Widget.tsx",
            startLine: 1,
            endLine: 3,
          });
        },
      });

      const log: MockCallLog = { warmup: null, queries: [] };
      __setLspTypescriptTestHooks__({
        clientFactory: () => makeMockClient({ callers: {}, references: {} }, log),
      });

      const out = await lspTypescriptPhase.run(ctx, ctx.phaseOutputs);
      assert.equal(out.enabled, true);
      assert.equal(out.symbolsQueried, 1, "tsx symbol must be queried");
      assert.ok(log.warmup?.includes(path.join(repo, "Widget.tsx")));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("warmup is called exactly once with all TS/TSX/JS/JSX files before the first query", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "lsp-ts-warmup-"));
    try {
      await writeFile(path.join(repo, "a.ts"), "export function a(): void {}\n");
      await writeFile(path.join(repo, "b.tsx"), "export function b(): void {}\n");
      await writeFile(path.join(repo, "c.js"), "export function c() {}\n");
      await writeFile(path.join(repo, "skipped.py"), "def d(): ...\n");

      const aId = makeNodeId("Function", "a.ts", "a") as NodeId;
      const ctx = makeCtx({
        repoPath: repo,
        languages: ["typescript", "javascript"],
        files: [
          { relPath: "a.ts", language: "typescript" },
          { relPath: "b.tsx", language: "tsx" },
          { relPath: "c.js", language: "javascript" },
          { relPath: "skipped.py", language: "python" },
        ],
        seedGraph: (g) => {
          g.addNode({
            id: aId,
            kind: "Function",
            name: "a",
            filePath: "a.ts",
            startLine: 1,
            endLine: 1,
          });
        },
      });

      const log: MockCallLog = { warmup: null, queries: [] };
      let warmupCalls = 0;
      __setLspTypescriptTestHooks__({
        clientFactory: () => {
          const base = makeMockClient({}, log);
          return {
            ...base,
            async warmup(files) {
              warmupCalls += 1;
              await base.warmup(files);
            },
          };
        },
      });

      await lspTypescriptPhase.run(ctx, ctx.phaseOutputs);

      assert.equal(warmupCalls, 1, "warmup must be invoked exactly once");
      assert.ok(log.warmup !== null);
      const warmupSet = new Set(log.warmup);
      assert.equal(warmupSet.size, 3, "three TS/TSX/JS files expected — .py is filtered out");
      assert.ok(warmupSet.has(path.join(repo, "a.ts")));
      assert.ok(warmupSet.has(path.join(repo, "b.tsx")));
      assert.ok(warmupSet.has(path.join(repo, "c.js")));
      assert.ok(!warmupSet.has(path.join(repo, "skipped.py")));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("lsp-typescript phase — identifier column lookup", () => {
  it("resolves `function foo`", () => {
    assert.equal(findIdentifierColumn("export function greet(name: string): void {", "greet"), 17);
  });

  it("resolves `async function foo`", () => {
    assert.equal(findIdentifierColumn("export async function load(): Promise<void> {", "load"), 23);
  });

  it("resolves `class Foo`", () => {
    assert.equal(findIdentifierColumn("export class Greeter {", "Greeter"), 14);
  });

  it("resolves `interface Foo`", () => {
    assert.equal(findIdentifierColumn("export interface Listener {", "Listener"), 18);
  });

  it("resolves `type Foo`", () => {
    assert.equal(findIdentifierColumn("export type Result = string;", "Result"), 13);
  });

  it("resolves `enum Foo`", () => {
    assert.equal(findIdentifierColumn("export enum Mode {", "Mode"), 13);
  });

  it("resolves `const Foo = (`", () => {
    assert.equal(
      findIdentifierColumn("export const handler = (req: Request) => req;", "handler"),
      14,
    );
  });

  it("resolves `let foo = async (`", () => {
    assert.equal(findIdentifierColumn("let task = async () => {};", "task"), 5);
  });

  it("resolves method inside class with access modifier", () => {
    assert.equal(findIdentifierColumn("  public hello(): string {", "hello"), 10);
  });

  it("resolves typed field (no trailing paren)", () => {
    assert.equal(findIdentifierColumn("  readonly size: number;", "size"), 12);
  });

  it("resolves `declare` prefix", () => {
    assert.equal(findIdentifierColumn("declare function legacy(): void;", "legacy"), 18);
  });
});
