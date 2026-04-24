/**
 * lsp-rust phase — unit tests.
 *
 * All tests use a mocked `RustAnalyzerClient` to avoid spawning a real
 * rust-analyzer subprocess. Coverage:
 *
 *   1. Phase skips when `CODEHUB_DISABLE_LSP=1`.
 *   2. Phase skips when `profile.languages` lacks "rust".
 *   3. Happy path: one .rs file, mocked client → edges with
 *      `confidence=1.0` and `reason` containing `rust-analyzer@`.
 *   4. Rust identifier column lookup: `fn`, `pub fn`, `async fn`,
 *      `struct`, `enum`, `trait`, `impl`, `mod`.
 *   5. `warmup` is called once after `start()` and before any query.
 *   6. A reference matching a CALLS edge is not double-emitted as
 *      REFERENCES.
 *   7. Enclosing-symbol resolution picks the tightest node.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { KnowledgeGraph, makeNodeId, type NodeId } from "@opencodehub/core-types";
import type { CallerSite, ReferenceSite, SymbolKind } from "@opencodehub/lsp-oracle";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import {
  __setLspRustTestHooks__,
  findRustIdentifierColumn,
  LSP_RUST_PHASE_NAME,
  type LspClientLike,
  lspRustPhase,
} from "./lsp-rust.js";
import { PARSE_PHASE_NAME } from "./parse.js";
import { PROFILE_PHASE_NAME } from "./profile.js";
import { SCAN_PHASE_NAME } from "./scan.js";

// ---------------------------------------------------------------- fixtures

interface MockClientCalls {
  readonly events: string[];
  readonly queryArgs: Array<{
    readonly kind: "callers" | "references" | "implementations";
    readonly filePath: string;
    readonly line: number;
    readonly character: number;
    readonly symbolKind?: SymbolKind;
  }>;
}

/**
 * Build a mock client that tracks lifecycle events + query args and
 * serves canned responses keyed by `(symbolKind, symbolName)`.
 */
function makeMockClient(options: {
  readonly calls: MockClientCalls;
  readonly version?: string | null;
  readonly callersByTarget?: ReadonlyMap<string, readonly CallerSite[]>;
  readonly referencesByTarget?: ReadonlyMap<string, readonly ReferenceSite[]>;
  readonly implementationsByTarget?: ReadonlyMap<
    string,
    readonly { readonly file: string; readonly line: number; readonly character: number }[]
  >;
}): LspClientLike {
  let started = false;
  let warmedUp = false;
  return {
    async start() {
      options.calls.events.push("start");
      started = true;
    },
    async stop() {
      options.calls.events.push("stop");
    },
    async warmup(_timeoutMs?: number) {
      if (!started) {
        throw new Error("warmup before start");
      }
      options.calls.events.push("warmup");
      warmedUp = true;
    },
    getStatus() {
      return {
        rustAnalyzerVersion: options.version === undefined ? "0.3.2130" : options.version,
      };
    },
    async queryCallers(input) {
      if (!warmedUp) throw new Error("query before warmup");
      options.calls.events.push("queryCallers");
      options.calls.queryArgs.push({
        kind: "callers",
        filePath: input.filePath,
        line: input.line,
        character: input.character,
        symbolKind: input.symbolKind,
      });
      return options.callersByTarget?.get(input.symbolName) ?? [];
    },
    async queryReferences(input) {
      if (!warmedUp) throw new Error("query before warmup");
      options.calls.events.push("queryReferences");
      options.calls.queryArgs.push({
        kind: "references",
        filePath: input.filePath,
        line: input.line,
        character: input.character,
      });
      // Indexed by "filePath:line" so callers seed the exact sites that
      // should return references.
      const key = `${input.filePath}:${input.line}`;
      return options.referencesByTarget?.get(key) ?? [];
    },
    async queryImplementations(input) {
      if (!warmedUp) throw new Error("query before warmup");
      options.calls.events.push("queryImplementations");
      options.calls.queryArgs.push({
        kind: "implementations",
        filePath: input.filePath,
        line: input.line,
        character: input.character,
      });
      const key = `${input.filePath}:${input.line}`;
      return options.implementationsByTarget?.get(key) ?? [];
    },
  };
}

function makeCtx(opts: {
  readonly repoPath: string;
  readonly languages: readonly string[];
  readonly rustNodes?: readonly {
    readonly kind: "Class" | "Method" | "Function";
    readonly name: string;
    readonly qualifiedName: string;
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
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

  for (const n of opts.rustNodes ?? []) {
    const id = makeNodeId(n.kind, n.filePath, n.qualifiedName) as NodeId;
    graph.addNode({
      id,
      kind: n.kind,
      name: n.name,
      filePath: n.filePath,
      startLine: n.startLine,
      endLine: n.endLine,
      ...(n.kind === "Method" ? { owner: n.qualifiedName.split("::").slice(-2, -1)[0] ?? "" } : {}),
    });
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
          symbolIndex: {
            byFile: new Map(),
            byGlobal: new Map(),
            importEdges: new Map(),
          },
          sourceByFile: new Map(),
          parseTimeMs: 0,
          fileCount: 0,
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
          totalFiles: 0,
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

// ----------------------------------------------------------------- tests

describe("lsp-rust phase — skip paths", () => {
  const originalEnv = process.env["CODEHUB_DISABLE_LSP"];

  afterEach(() => {
    __setLspRustTestHooks__(undefined);
    if (originalEnv !== undefined) process.env["CODEHUB_DISABLE_LSP"] = originalEnv;
    else delete process.env["CODEHUB_DISABLE_LSP"];
  });

  it("returns enabled:false when CODEHUB_DISABLE_LSP=1 is set", async () => {
    process.env["CODEHUB_DISABLE_LSP"] = "1";
    const ctx = makeCtx({
      repoPath: "/tmp/nonexistent-for-lsp-rust-skip",
      languages: ["rust"],
      rustNodes: [
        {
          kind: "Function",
          name: "hello",
          qualifiedName: "hello",
          filePath: "src/lib.rs",
          startLine: 1,
          endLine: 3,
        },
      ],
    });
    const before = ctx.graph.edgeCount();

    // Ensure no client is spawned even if the hook is installed.
    const calls: MockClientCalls = { events: [], queryArgs: [] };
    __setLspRustTestHooks__({
      clientFactory: () => makeMockClient({ calls }),
    });

    const out = await lspRustPhase.run(ctx, ctx.phaseOutputs);

    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "CODEHUB_DISABLE_LSP=1");
    assert.equal(ctx.graph.edgeCount(), before);
    assert.deepEqual(calls.events, [], "client must not be touched on disable path");
  });

  it("returns enabled:false when profile.languages lacks 'rust'", async () => {
    const ctx = makeCtx({
      repoPath: "/tmp/nonexistent-for-lsp-rust-skip",
      languages: ["python"],
      rustNodes: [],
    });
    const before = ctx.graph.edgeCount();
    const calls: MockClientCalls = { events: [], queryArgs: [] };
    __setLspRustTestHooks__({
      clientFactory: () => makeMockClient({ calls }),
    });

    const out = await lspRustPhase.run(ctx, ctx.phaseOutputs);

    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "no-rust-in-profile");
    assert.equal(ctx.graph.edgeCount(), before);
    assert.deepEqual(calls.events, [], "client must not spawn when language absent");
  });

  it("returns enabled:false when no Rust symbols exist in the graph", async () => {
    const ctx = makeCtx({
      repoPath: "/tmp/nonexistent-for-lsp-rust-skip",
      languages: ["rust"],
      rustNodes: [],
    });
    const calls: MockClientCalls = { events: [], queryArgs: [] };
    __setLspRustTestHooks__({
      clientFactory: () => makeMockClient({ calls }),
    });

    const out = await lspRustPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, false);
    assert.equal(out.skippedReason, "no-rust-symbols-in-graph");
    assert.deepEqual(calls.events, [], "client must not spawn when no symbols");
  });

  it("declares the expected DAG dependencies", () => {
    const deps = new Set(lspRustPhase.deps);
    assert.ok(deps.has(SCAN_PHASE_NAME));
    assert.ok(deps.has(PROFILE_PHASE_NAME));
    assert.ok(deps.has(PARSE_PHASE_NAME));
    assert.ok(deps.has(CROSS_FILE_PHASE_NAME));
    assert.ok(deps.has(INCREMENTAL_SCOPE_PHASE_NAME));
    assert.equal(lspRustPhase.name, LSP_RUST_PHASE_NAME);
  });
});

describe("lsp-rust phase — happy path (mocked client)", () => {
  afterEach(() => {
    __setLspRustTestHooks__(undefined);
  });

  it("emits CALLS / REFERENCES / EXTENDS edges with reason=rust-analyzer@<version>", async () => {
    const events: ProgressEvent[] = [];
    const ctx = makeCtx({
      repoPath: "/tmp/nonexistent-for-lsp-rust-happy",
      languages: ["rust"],
      events,
      rustNodes: [
        // `Greeter` struct (Class-kind in OCH taxonomy).
        {
          kind: "Class",
          name: "Greeter",
          qualifiedName: "Greeter",
          filePath: "src/lib.rs",
          startLine: 1,
          endLine: 10,
        },
        // `Greeter::hello` method.
        {
          kind: "Method",
          name: "hello",
          qualifiedName: "Greeter::hello",
          filePath: "src/lib.rs",
          startLine: 5,
          endLine: 7,
        },
        // `run_app` top-level function.
        {
          kind: "Function",
          name: "run_app",
          qualifiedName: "run_app",
          filePath: "src/main.rs",
          startLine: 1,
          endLine: 5,
        },
        // `LoudGreeter` struct that impls some trait — enclosing the
        // implementation site line.
        {
          kind: "Class",
          name: "LoudGreeter",
          qualifiedName: "LoudGreeter",
          filePath: "src/loud.rs",
          startLine: 1,
          endLine: 20,
        },
      ],
    });

    const runAppQname = "run_app";
    const helloQname = "Greeter::hello";
    const greeterQname = "Greeter";

    // Caller: run_app (main.rs:3) calls Greeter::hello
    const callersByTarget = new Map<string, readonly CallerSite[]>([
      [
        helloQname,
        [
          {
            file: "src/main.rs",
            line: 3,
            character: 12,
            enclosingSymbolName: "run_app",
            source: "callHierarchy",
          },
        ],
      ],
    ]);

    // References on hello: one that DUPLICATES the call site (main.rs:3)
    // — must NOT be double-emitted — and one pure reference site
    // (loud.rs:5) inside `LoudGreeter`.
    const referencesByTarget = new Map<string, readonly ReferenceSite[]>([
      [
        "src/lib.rs:5",
        [
          { file: "src/main.rs", line: 3, character: 12 }, // matches CALLS site
          { file: "src/loud.rs", line: 5, character: 8 },
        ],
      ],
    ]);

    // Implementations of Greeter: LoudGreeter impls it at loud.rs:4
    const implementationsByTarget = new Map<
      string,
      readonly { readonly file: string; readonly line: number; readonly character: number }[]
    >([["src/lib.rs:1", [{ file: "src/loud.rs", line: 4, character: 6 }]]]);

    const calls: MockClientCalls = { events: [], queryArgs: [] };
    __setLspRustTestHooks__({
      clientFactory: () =>
        makeMockClient({
          calls,
          version: "0.3.2130",
          callersByTarget,
          referencesByTarget,
          implementationsByTarget,
        }),
    });

    const out = await lspRustPhase.run(ctx, ctx.phaseOutputs);

    assert.equal(out.enabled, true, "phase must be enabled with rust + symbols present");
    assert.equal(out.rustAnalyzerVersion, "0.3.2130");
    assert.ok(out.symbolsQueried >= 3, "all three LSP-queryable symbols must be hit");

    // Scan graph for the three expected edges.
    const runAppId = makeNodeId("Function", "src/main.rs", runAppQname);
    const helloId = makeNodeId("Method", "src/lib.rs", helloQname);
    const greeterId = makeNodeId("Class", "src/lib.rs", greeterQname);
    const loudGreeterId = makeNodeId("Class", "src/loud.rs", "LoudGreeter");

    let callsEdge: { readonly confidence: number; readonly reason?: string } | undefined;
    let refEdgeCount = 0;
    let extendsEdge: { readonly confidence: number; readonly reason?: string } | undefined;
    let doubleEmitCount = 0;

    for (const e of ctx.graph.edges()) {
      if (e.type === "CALLS" && e.from === runAppId && e.to === helloId) {
        callsEdge = e;
      }
      if (e.type === "REFERENCES" && e.to === helloId) {
        refEdgeCount += 1;
        // Also check no REFERENCES edge was emitted for the CALLS dup site.
        if (e.from === runAppId) doubleEmitCount += 1;
      }
      if (e.type === "EXTENDS" && e.from === loudGreeterId && e.to === greeterId) {
        extendsEdge = e;
      }
    }

    assert.ok(callsEdge !== undefined, "CALLS edge run_app → Greeter::hello missing");
    assert.equal(callsEdge.confidence, 1.0);
    assert.ok(
      callsEdge.reason?.startsWith("rust-analyzer@"),
      `CALLS reason should start with "rust-analyzer@" — got ${callsEdge.reason}`,
    );

    assert.equal(
      doubleEmitCount,
      0,
      "call-site reference must not be double-emitted as REFERENCES",
    );
    assert.equal(refEdgeCount, 1, "exactly one REFERENCES edge to hello (from LoudGreeter)");

    assert.ok(extendsEdge !== undefined, "EXTENDS edge LoudGreeter → Greeter missing");
    assert.equal(extendsEdge.confidence, 1.0);
    assert.ok(extendsEdge.reason?.startsWith("rust-analyzer@"));

    // Note: unused ids retained for clarity of the test expectations above.
    void greeterId;
  });

  it("calls warmup exactly once, after start(), and before the first query", async () => {
    const ctx = makeCtx({
      repoPath: "/tmp/nonexistent-for-lsp-rust-warmup",
      languages: ["rust"],
      rustNodes: [
        {
          kind: "Function",
          name: "hello",
          qualifiedName: "hello",
          filePath: "src/lib.rs",
          startLine: 1,
          endLine: 3,
        },
      ],
    });

    const calls: MockClientCalls = { events: [], queryArgs: [] };
    __setLspRustTestHooks__({
      clientFactory: () => makeMockClient({ calls }),
    });

    const out = await lspRustPhase.run(ctx, ctx.phaseOutputs);
    assert.equal(out.enabled, true);

    const startIdx = calls.events.indexOf("start");
    const warmupIdx = calls.events.indexOf("warmup");
    const firstQueryIdx = calls.events.findIndex((e) => e.startsWith("query"));

    assert.ok(startIdx >= 0, "start must be called");
    assert.ok(warmupIdx >= 0, "warmup must be called");
    assert.equal(
      calls.events.filter((e) => e === "warmup").length,
      1,
      "warmup must be called exactly once",
    );
    assert.ok(startIdx < warmupIdx, "warmup must follow start");
    if (firstQueryIdx >= 0) {
      assert.ok(warmupIdx < firstQueryIdx, "warmup must precede the first query");
    }
  });

  it("resolves the tightest enclosing symbol for a reference site", async () => {
    const events: ProgressEvent[] = [];
    const ctx = makeCtx({
      repoPath: "/tmp/nonexistent-for-lsp-rust-enclosing",
      languages: ["rust"],
      events,
      rustNodes: [
        // Outer impl block (Class) spans lines 1..50.
        {
          kind: "Class",
          name: "OuterHost",
          qualifiedName: "OuterHost",
          filePath: "src/host.rs",
          startLine: 1,
          endLine: 50,
        },
        // Inner method (Method) spans 10..20 — tighter.
        {
          kind: "Method",
          name: "inner_caller",
          qualifiedName: "OuterHost::inner_caller",
          filePath: "src/host.rs",
          startLine: 10,
          endLine: 20,
        },
        // Target function to call.
        {
          kind: "Function",
          name: "target",
          qualifiedName: "target",
          filePath: "src/util.rs",
          startLine: 1,
          endLine: 3,
        },
      ],
    });

    // Caller for `target` is at src/host.rs:15 — inside BOTH OuterHost
    // (1..50) and inner_caller (10..20). Expected enclosing: inner_caller.
    const callersByTarget = new Map<string, readonly CallerSite[]>([
      [
        "target",
        [
          {
            file: "src/host.rs",
            line: 15,
            character: 8,
            enclosingSymbolName: "inner_caller",
            source: "callHierarchy",
          },
        ],
      ],
    ]);

    const calls: MockClientCalls = { events: [], queryArgs: [] };
    __setLspRustTestHooks__({
      clientFactory: () =>
        makeMockClient({
          calls,
          callersByTarget,
        }),
    });

    await lspRustPhase.run(ctx, ctx.phaseOutputs);

    const innerId = makeNodeId("Method", "src/host.rs", "OuterHost::inner_caller");
    const outerId = makeNodeId("Class", "src/host.rs", "OuterHost");
    const targetId = makeNodeId("Function", "src/util.rs", "target");

    let sawInner = false;
    let sawOuter = false;
    for (const e of ctx.graph.edges()) {
      if (e.type !== "CALLS") continue;
      if (e.to !== targetId) continue;
      if (e.from === innerId) sawInner = true;
      if (e.from === outerId) sawOuter = true;
    }
    assert.ok(sawInner, "CALLS from tightest (inner_caller) must be emitted");
    assert.equal(sawOuter, false, "CALLS must NOT be attributed to the wider OuterHost node");
  });
});

// --------------------------------------------------- identifier-column tests

describe("findRustIdentifierColumn", () => {
  it("finds `fn` at top level", () => {
    const col = findRustIdentifierColumn("fn hello() {}", "hello");
    assert.equal(col, 4); // "fn " + "hello" starts at col 4 (1-indexed)
  });

  it("finds `pub fn`", () => {
    const col = findRustIdentifierColumn("pub fn hello() {}", "hello");
    assert.equal(col, 8);
  });

  it("finds `pub(crate) fn`", () => {
    const col = findRustIdentifierColumn("pub(crate) fn hello() {}", "hello");
    assert.equal(col, 15);
  });

  it("finds `async fn`", () => {
    const col = findRustIdentifierColumn("async fn hello() {}", "hello");
    assert.equal(col, 10);
  });

  it("finds `pub async unsafe fn`", () => {
    const col = findRustIdentifierColumn("pub async unsafe fn hello() {}", "hello");
    assert.equal(col, 21);
  });

  it('finds `extern "C" fn`', () => {
    const col = findRustIdentifierColumn('extern "C" fn hello() {}', "hello");
    assert.equal(col, 15);
  });

  it("finds `struct`", () => {
    const col = findRustIdentifierColumn("struct Greeter {", "Greeter");
    assert.equal(col, 8);
  });

  it("finds `pub struct`", () => {
    const col = findRustIdentifierColumn("pub struct Greeter {", "Greeter");
    assert.equal(col, 12);
  });

  it("finds `enum`", () => {
    const col = findRustIdentifierColumn("enum Color {", "Color");
    assert.equal(col, 6);
  });

  it("finds `trait`", () => {
    const col = findRustIdentifierColumn("trait Greet {", "Greet");
    assert.equal(col, 7);
  });

  it("finds `impl <name>` (inherent)", () => {
    const col = findRustIdentifierColumn("impl Greeter {", "Greeter");
    assert.equal(col, 6);
  });

  it("finds `impl <Trait> for <Type>` — captures the trait name first", () => {
    // For `impl Greet for LoudGreeter`, the regex matches `impl Greet`
    // since `Greet` is the simple name of the queried symbol.
    const col = findRustIdentifierColumn("impl Greet for LoudGreeter {", "Greet");
    assert.equal(col, 6);
  });

  it("finds `mod`", () => {
    const col = findRustIdentifierColumn("mod utils {", "utils");
    assert.equal(col, 5);
  });

  it("falls back to first occurrence when no keyword prefix matches", () => {
    // Extremely unusual header line with no keyword — fallback kicks in.
    const col = findRustIdentifierColumn("    hello;", "hello");
    assert.equal(col, 5);
  });
});
