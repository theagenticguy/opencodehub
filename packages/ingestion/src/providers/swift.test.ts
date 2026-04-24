import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { swiftProvider } from "./swift.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
import Foundation

protocol Logger {
    func log(_ msg: String)
}

class Base {
    func hello() -> String { return "hi" }
}

class Greeter: Base, Logger {
    let name: String

    init(name: String) {
        self.name = name
    }

    override func hello() -> String {
        log("saying hi")
        return super.hello() + " " + name
    }

    func log(_ msg: String) {
        print(msg)
    }
}

func run() {
    let g = Greeter(name: "world")
    _ = g.hello()
}
`;

describe("swiftProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "swift", "Auth.swift", FIXTURE);
  });

  it("extracts classes, protocols, and functions", () => {
    const defs = swiftProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const names = new Set(defs.map((d) => d.name));
    assert.ok(names.has("Logger"));
    assert.ok(names.has("Base"));
    assert.ok(names.has("Greeter"));
    assert.ok(names.has("run"));
  });

  it("emits heritage edges from inheritance specifier", () => {
    const defs = swiftProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = swiftProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const greeter = heritage
      .filter((h) => h.childQualifiedName === "Greeter")
      .map((h) => h.parentName);
    assert.ok(greeter.includes("Base"));
    assert.ok(greeter.includes("Logger"));
  });

  it("parses import directives", () => {
    const imports = swiftProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("Foundation"));
  });

  it("extracts call sites", () => {
    const defs = swiftProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const calls = swiftProvider.extractCalls({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const names = new Set(calls.map((c) => c.calleeName));
    assert.ok(names.has("Greeter") || names.has("hello") || names.has("print"));
  });
});
