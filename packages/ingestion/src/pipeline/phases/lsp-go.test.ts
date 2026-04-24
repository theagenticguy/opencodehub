/**
 * lsp-go unit tests.
 *
 * Mocked GoplsClient — we never spawn a real gopls subprocess. Covers:
 *   1. Skip when `CODEHUB_DISABLE_LSP=1`.
 *   2. Skip when profile.languages lacks `go`.
 *   3. Happy path — CALLS / REFERENCES / EXTENDS edges with reason `gopls@<ver>`.
 *   4. Identifier-column lookup for Go syntax (func / type / var / const /
 *      method-with-receiver).
 *   5. Reference matching a CALLS edge is not double-emitted.
 *   6. Enclosing-symbol resolution works.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { KnowledgeGraph, makeNodeId, type NodeId } from "@opencodehub/core-types";
import type { CallerSite, ImplementationSite, ReferenceSite } from "@opencodehub/lsp-oracle";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import {
  __setLspGoTestHooks__,
  findEnclosingSymbolId,
  identifierColumn,
  type LspGoClientLike,
  lspGoPhase,
} from "./lsp-go.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

function makeCtx(opts: {
  readonly repoPath: string;
  readonly languages: readonly string[];
  readonly goSymbols: readonly {
    readonly id: NodeId;
    readonly kind: "Class" | "Method" | "Function" | "Interface" | "Struct" | "Type";
    readonly name: string;
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly owner?: string;
  }[];
  readonly seededEdges?: readonly {
    readonly from: NodeId;
    readonly to: NodeId;
    readonly type: "CALLS" | "REFERENCES" | "EXTENDS";
    readonly confidence: number;
    readonly reason: string;
  }[];
  readonly events?: ProgressEvent[];
}): PipelineContext {
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

  for (const s of opts.goSymbols) {
    const node = {
      id: s.id,
      kind: s.kind,
      name: s.name,
      filePath: s.filePath,
      startLine: s.startLine,
      endLine: s.endLine,
      ...(s.owner !== undefined ? { owner: s.owner } : {}),
    };
    // Type-assert — the graph's addNode accepts the discriminated union and
    // the test fixtures only use the fields present on each variant.
    graph.addNode(node as Parameters<typeof graph.addNode>[0]);
  }
  for (const e of opts.seededEdges ?? []) {
    graph.addEdge(e);
  }

  return {
    repoPath: opts.repoPath,
    options: { skipGit: true },
    graph,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, { files: [] }],
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
          fileCount: opts.goSymbols.length,
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
          totalFiles: opts.goSymbols.length,
          closureRatio: 0,
        },
      ],
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

/**
 * Build a mock client whose `queryCallers` / `queryReferences` /
 * `queryImplementations` consult fixed lookup tables keyed by the queried
 * file path + line. Returns whatever is registered; otherwise returns `[]`.
 */
function makeMockClient(opts: {
  readonly version: string;
  readonly callers?: ReadonlyMap<string, readonly CallerSite[]>;
  readonly references?: ReadonlyMap<string, readonly ReferenceSite[]>;
  readonly implementations?: ReadonlyMap<string, readonly ImplementationSite[]>;
}): LspGoClientLike {
  return {
    async start() {},
    async stop() {},
    getStatus() {
      return { goplsVersion: opts.version };
    },
    async queryCallers(input) {
      return opts.callers?.get(`${input.filePath}:${input.line}`) ?? [];
    },
    async queryReferences(input) {
      return opts.references?.get(`${input.filePath}:${input.line}`) ?? [];
    },
    async queryImplementations(input) {
      return opts.implementations?.get(`${input.filePath}:${input.line}`) ?? [];
    },
  };
}

describe("lsp-go — skip paths", () => {
  const originalEnv = process.env["CODEHUB_DISABLE_LSP"];
  beforeEach(() => {
    delete process.env["CODEHUB_DISABLE_LSP"];
  });
  afterEach(() => {
    if (originalEnv !== undefined) process.env["CODEHUB_DISABLE_LSP"] = originalEnv;
    else delete process.env["CODEHUB_DISABLE_LSP"];
    __setLspGoTestHooks__(undefined);
  });

  it("returns enabled:false when CODEHUB_DISABLE_LSP=1", async () => {
    process.env["CODEHUB_DISABLE_LSP"] = "1";
    const ctx = makeCtx({
      repoPath: "/tmp/lsp-go-skip",
      languages: ["go"],
      goSymbols: [
        {
          id: makeNodeId("Function", "main.go", "main") as NodeId,
          kind: "Function",
          name: "main",
          filePath: "main.go",
          startLine: 5,
          endLine: 7,
        },
      ],
    });
    const before = ctx.graph.edgeCount();
    const out = await lspGoPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "CODEHUB_DISABLE_LSP=1");
    assert.equal(ctx.graph.edgeCount(), before);
  });

  it("returns enabled:false when profile.languages lacks go", async () => {
    const ctx = makeCtx({
      repoPath: "/tmp/lsp-go-skip-profile",
      languages: ["typescript"],
      goSymbols: [],
    });
    const before = ctx.graph.edgeCount();
    const out = await lspGoPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "no-go-in-profile");
    assert.equal(ctx.graph.edgeCount(), before);
  });
});

describe("lsp-go — identifierColumn", () => {
  it("locates func-with-receiver method names", () => {
    assert.equal(identifierColumn("func (s *Server) Handle(w Writer) {", "Handle"), 18);
  });
  it("locates plain func names", () => {
    assert.equal(identifierColumn("func NewServer() *Server {", "NewServer"), 6);
  });
  it("locates type names", () => {
    assert.equal(identifierColumn("type User struct {", "User"), 6);
  });
  it("locates var names", () => {
    assert.equal(identifierColumn("var GlobalConfig = &Config{}", "GlobalConfig"), 5);
  });
  it("locates const names", () => {
    assert.equal(identifierColumn("const DefaultPort = 8080", "DefaultPort"), 7);
  });
  it("locates package names", () => {
    assert.equal(identifierColumn("package main", "main"), 9);
  });
  it("falls back to first word occurrence", () => {
    assert.equal(identifierColumn("result := Foo()", "Foo"), 11);
  });
});

describe("lsp-go — findEnclosingSymbolId", () => {
  it("picks the tightest enclosing node for a given line", () => {
    const aId = makeNodeId("Struct", "srv.go", "Server") as NodeId;
    const bId = makeNodeId("Method", "srv.go", "Server.Handle") as NodeId;
    const nodesByFile = new Map<
      string,
      readonly {
        readonly id: NodeId;
        readonly kind: string;
        readonly qualifiedName: string;
        readonly filePath: string;
        readonly startLine: number;
        readonly endLine: number;
      }[]
    >();
    nodesByFile.set("srv.go", [
      {
        id: aId,
        kind: "Struct",
        qualifiedName: "Server",
        filePath: "srv.go",
        startLine: 1,
        endLine: 50,
      },
      {
        id: bId,
        kind: "Method",
        qualifiedName: "Server.Handle",
        filePath: "srv.go",
        startLine: 10,
        endLine: 20,
      },
    ]);
    assert.equal(findEnclosingSymbolId(nodesByFile, "srv.go", 15), bId);
    assert.equal(findEnclosingSymbolId(nodesByFile, "srv.go", 5), aId);
    assert.equal(findEnclosingSymbolId(nodesByFile, "srv.go", 100), undefined);
  });
});

describe("lsp-go — happy path", () => {
  let repo: string;
  const originalEnv = process.env["CODEHUB_DISABLE_LSP"];

  beforeEach(async () => {
    delete process.env["CODEHUB_DISABLE_LSP"];
    repo = await mkdtemp(path.join(tmpdir(), "lsp-go-"));
    await writeFile(
      path.join(repo, "srv.go"),
      [
        "package srv",
        "",
        "type Handler interface {",
        "    Handle() string",
        "}",
        "",
        "type Server struct{}",
        "",
        "func (s *Server) Handle() string {",
        '    return "ok"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repo, "main.go"),
      [
        "package main",
        "",
        'import "./srv"',
        "",
        "func run() string {",
        "    s := &srv.Server{}",
        "    return s.Handle()",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    __setLspGoTestHooks__(undefined);
    if (originalEnv !== undefined) process.env["CODEHUB_DISABLE_LSP"] = originalEnv;
    else delete process.env["CODEHUB_DISABLE_LSP"];
    await rm(repo, { recursive: true, force: true });
  });

  it("emits CALLS / REFERENCES / EXTENDS edges tagged with gopls@<version>", async () => {
    const handlerIfaceId = makeNodeId("Interface", "srv.go", "Handler") as NodeId;
    const serverStructId = makeNodeId("Struct", "srv.go", "Server") as NodeId;
    const serverHandleId = makeNodeId("Method", "srv.go", "Server.Handle") as NodeId;
    const runFuncId = makeNodeId("Function", "main.go", "run") as NodeId;

    const callers = new Map<string, readonly CallerSite[]>();
    callers.set("srv.go:9", [{ file: "main.go", line: 7, character: 15, source: "callHierarchy" }]);

    const references = new Map<string, readonly ReferenceSite[]>();
    // Declaration site (same-file line 9, the method's header) — should be
    // skipped by the self-loop guard.
    // A reference at main.go:7 — same line as the CALLS site, must be
    // deduped so only one edge is emitted.
    references.set("srv.go:9", [
      { file: "main.go", line: 7, character: 15 },
      { file: "main.go", line: 6, character: 10 },
    ]);

    const implementations = new Map<string, readonly ImplementationSite[]>();
    // Handler interface has Server as implementer — EXTENDS from Server → Handler.
    implementations.set("srv.go:3", [{ file: "srv.go", line: 7, character: 6 }]);

    __setLspGoTestHooks__({
      clientFactory: () =>
        makeMockClient({ version: "0.21.0", callers, references, implementations }),
    });

    const ctx = makeCtx({
      repoPath: repo,
      languages: ["go"],
      goSymbols: [
        {
          id: handlerIfaceId,
          kind: "Interface",
          name: "Handler",
          filePath: "srv.go",
          startLine: 3,
          endLine: 5,
        },
        {
          id: serverStructId,
          kind: "Struct",
          name: "Server",
          filePath: "srv.go",
          startLine: 7,
          endLine: 7,
        },
        {
          id: serverHandleId,
          kind: "Method",
          name: "Handle",
          filePath: "srv.go",
          startLine: 9,
          endLine: 11,
          owner: "Server",
        },
        {
          id: runFuncId,
          kind: "Function",
          name: "run",
          filePath: "main.go",
          startLine: 5,
          endLine: 8,
        },
      ],
    });

    const out = await lspGoPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, true);
    assert.equal(out.goplsVersion, "0.21.0");
    assert.ok(out.symbolsQueried >= 1);

    const edges = [...ctx.graph.edges()];
    const callsEdge = edges.find(
      (e) => e.type === "CALLS" && e.from === runFuncId && e.to === serverHandleId,
    );
    assert.ok(callsEdge !== undefined, "expected CALLS run → Server.Handle");
    assert.equal(callsEdge?.confidence, 1.0);
    assert.match(callsEdge?.reason ?? "", /^gopls@/);

    // Only the reference at main.go:6 should produce a REFERENCES edge —
    // the main.go:7 reference collides with the CALLS site (same file+line)
    // and is deduped.
    const refEdges = edges.filter(
      (e) => e.type === "REFERENCES" && e.from === runFuncId && e.to === serverHandleId,
    );
    assert.equal(refEdges.length, 1, "exactly one REFERENCES edge (the non-call-site reference)");

    const extendsEdge = edges.find(
      (e) => e.type === "EXTENDS" && e.from === serverStructId && e.to === handlerIfaceId,
    );
    assert.ok(extendsEdge !== undefined, "expected EXTENDS Server → Handler");
    assert.equal(extendsEdge?.confidence, 1.0);
    assert.match(extendsEdge?.reason ?? "", /^gopls@/);
  });

  it("confirms a reference on the same line as a CALLS site is not double-emitted", async () => {
    const targetId = makeNodeId("Function", "srv.go", "F") as NodeId;
    const callerId = makeNodeId("Function", "main.go", "run") as NodeId;

    const callers = new Map<string, readonly CallerSite[]>();
    callers.set("srv.go:1", [{ file: "main.go", line: 2, character: 5, source: "callHierarchy" }]);

    const references = new Map<string, readonly ReferenceSite[]>();
    references.set("srv.go:1", [{ file: "main.go", line: 2, character: 5 }]);

    __setLspGoTestHooks__({
      clientFactory: () => makeMockClient({ version: "0.21.0", callers, references }),
    });

    const ctx = makeCtx({
      repoPath: repo,
      languages: ["go"],
      goSymbols: [
        {
          id: targetId,
          kind: "Function",
          name: "F",
          filePath: "srv.go",
          startLine: 1,
          endLine: 1,
        },
        {
          id: callerId,
          kind: "Function",
          name: "run",
          filePath: "main.go",
          startLine: 1,
          endLine: 10,
        },
      ],
    });

    await lspGoPhase.run(ctx, ctx.phaseOutputs);
    const edges = [...ctx.graph.edges()];
    const callEdges = edges.filter(
      (e) => e.type === "CALLS" && e.from === callerId && e.to === targetId,
    );
    const refEdges = edges.filter(
      (e) => e.type === "REFERENCES" && e.from === callerId && e.to === targetId,
    );
    assert.equal(callEdges.length, 1, "one CALLS edge");
    assert.equal(refEdges.length, 0, "same-line reference must not emit a REFERENCES edge");
  });
});
