/**
 * Tests for stage 5 — import / SCIP usage detection.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  detectFromImports,
  type ImportEdgeLike,
  type ImportNodeLike,
  type ImportStageGraph,
} from "./imports.js";

class FakeGraph implements ImportStageGraph {
  private readonly _edges: ImportEdgeLike[] = [];
  private readonly _nodes = new Map<string, ImportNodeLike>();

  addNode(node: ImportNodeLike): this {
    this._nodes.set(node.id, node);
    return this;
  }

  addEdge(edge: ImportEdgeLike): this {
    this._edges.push(edge);
    return this;
  }

  edges(): IterableIterator<ImportEdgeLike> {
    return this._edges[Symbol.iterator]();
  }

  getNode(id: string): ImportNodeLike | undefined {
    return this._nodes.get(id);
  }
}

function externalStub(id: string, source: string, symbol: string): ImportNodeLike {
  return {
    id,
    kind: "CodeElement",
    name: symbol,
    content: `external import: ${source}:${symbol}`,
    filePath: "<external>",
  };
}

describe("imports stage — root module match", () => {
  it("maps fastapi import to fastapi framework", () => {
    const g = new FakeGraph()
      .addNode(externalStub("ext:fastapi:FastAPI", "fastapi", "FastAPI"))
      .addEdge({ from: "src:main.py", to: "ext:fastapi:FastAPI", type: "IMPORTS", confidence: 1 });
    const out = detectFromImports(g);
    assert.deepEqual(out, [
      { framework: "fastapi", source: "fastapi", confidence: "deterministic" },
    ]);
  });

  it("maps django.db import to django framework", () => {
    const g = new FakeGraph()
      .addNode(externalStub("ext:django.db:Model", "django.db", "Model"))
      .addEdge({ from: "src:m.py", to: "ext:django.db:Model", type: "IMPORTS", confidence: 1 });
    const out = detectFromImports(g);
    assert.deepEqual(out, [
      { framework: "django", source: "django.db", confidence: "deterministic" },
    ]);
  });

  it("maps @nestjs/core import to nestjs framework", () => {
    const g = new FakeGraph()
      .addNode(externalStub("ext:@nestjs/core:Module", "@nestjs/core", "Module"))
      .addEdge({
        from: "src:app.ts",
        to: "ext:@nestjs/core:Module",
        type: "IMPORTS",
        confidence: 1,
      });
    const out = detectFromImports(g);
    assert.deepEqual(out, [
      { framework: "nestjs", source: "@nestjs/core", confidence: "deterministic" },
    ]);
  });

  it("maps org.springframework.boot import to spring-boot framework", () => {
    const g = new FakeGraph()
      .addNode(externalStub("ext:sb:App", "org.springframework.boot", "SpringApplication"))
      .addEdge({ from: "src:App.java", to: "ext:sb:App", type: "IMPORTS", confidence: 1 });
    const out = detectFromImports(g);
    assert.deepEqual(out, [
      {
        framework: "spring-boot",
        source: "org.springframework.boot",
        confidence: "deterministic",
      },
    ]);
  });
});

describe("imports stage — confidence tiering", () => {
  it("confidence < 1 yields heuristic", () => {
    const g = new FakeGraph()
      .addNode(externalStub("ext:express:Router", "express", "Router"))
      .addEdge({ from: "src:s.ts", to: "ext:express:Router", type: "IMPORTS", confidence: 0.8 });
    const out = detectFromImports(g);
    assert.equal(out[0]?.confidence, "heuristic");
  });
});

describe("imports stage — dedup + ordering", () => {
  it("dedupes findings per (framework, source) across repeated import sites", () => {
    const g = new FakeGraph()
      .addNode(externalStub("ext:react:useState", "react", "useState"))
      .addNode(externalStub("ext:react:useEffect", "react", "useEffect"))
      .addEdge({ from: "src:a.ts", to: "ext:react:useState", type: "IMPORTS", confidence: 1 })
      .addEdge({ from: "src:b.ts", to: "ext:react:useEffect", type: "IMPORTS", confidence: 1 });
    const out = detectFromImports(g);
    // Both edges target `react` — collapsed to a single finding.
    assert.equal(out.length, 1);
    assert.equal(out[0]?.framework, "react");
  });

  it("sorts findings by (framework, source)", () => {
    const g = new FakeGraph()
      .addNode(externalStub("ext:fastapi:FastAPI", "fastapi", "FastAPI"))
      .addNode(externalStub("ext:react:useState", "react", "useState"))
      .addEdge({ from: "src:m.py", to: "ext:fastapi:FastAPI", type: "IMPORTS", confidence: 1 })
      .addEdge({ from: "src:a.ts", to: "ext:react:useState", type: "IMPORTS", confidence: 1 });
    const out = detectFromImports(g);
    assert.deepEqual(
      out.map((f) => f.framework),
      ["fastapi", "react"],
    );
  });
});

describe("imports stage — non-matches", () => {
  it("skips non-IMPORTS edges", () => {
    const g = new FakeGraph()
      .addNode(externalStub("ext:react:useState", "react", "useState"))
      .addEdge({ from: "src:a.ts", to: "ext:react:useState", type: "CALLS", confidence: 1 });
    const out = detectFromImports(g);
    assert.deepEqual(out, []);
  });

  it("skips stubs whose source isn't in the framework registry", () => {
    const g = new FakeGraph()
      .addNode(externalStub("ext:lodash:debounce", "lodash", "debounce"))
      .addEdge({ from: "src:a.ts", to: "ext:lodash:debounce", type: "IMPORTS", confidence: 1 });
    const out = detectFromImports(g);
    assert.deepEqual(out, []);
  });

  it("skips IMPORTS edges whose target is not a CodeElement", () => {
    const g = new FakeGraph()
      .addNode({ id: "file:foo.ts", kind: "File", name: "foo.ts" })
      .addEdge({ from: "src:a.ts", to: "file:foo.ts", type: "IMPORTS", confidence: 1 });
    const out = detectFromImports(g);
    assert.deepEqual(out, []);
  });

  it("skips stubs whose content is missing or malformed", () => {
    const g = new FakeGraph()
      .addNode({ id: "ext:x", kind: "CodeElement", name: "x" })
      .addEdge({ from: "src:a.ts", to: "ext:x", type: "IMPORTS", confidence: 1 });
    const out = detectFromImports(g);
    assert.deepEqual(out, []);
  });
});
