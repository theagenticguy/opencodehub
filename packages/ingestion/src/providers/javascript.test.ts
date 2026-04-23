import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { javascriptProvider } from "./javascript.js";
import { parseFixture } from "./test-helpers.js";

const ESM_FIXTURE = `
import { Logger } from "./logger.js";

export class Greeter extends Base {
  greet(name) {
    return "hi " + name;
  }
}

export function run() {
  const g = new Greeter();
  g.greet("world");
  Logger.debug("done");
}

export const VERSION = "1.0.0";
`;

const CJS_FIXTURE = `
const path = require("node:path");
const { readFile } = require("node:fs/promises");

class Loader {
  load(file) {
    return readFile(path.resolve(file));
  }
}

function helper() {
  return 42;
}

module.exports = { Loader, helper };
`;

describe("javascriptProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let esm: Awaited<ReturnType<typeof parseFixture>>;
  let cjs: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    esm = await parseFixture(pool, "javascript", "esm.js", ESM_FIXTURE);
    cjs = await parseFixture(pool, "javascript", "cjs.js", CJS_FIXTURE);
  });

  it("extracts ESM class, method, function, constant definitions", () => {
    const defs = javascriptProvider.extractDefinitions({
      filePath: esm.filePath,
      captures: esm.captures,
      sourceText: esm.sourceText,
    });
    const names = new Set(defs.map((d) => d.qualifiedName));
    assert.ok(names.has("Greeter"));
    assert.ok(names.has("Greeter.greet"));
    assert.ok(names.has("run"));
    assert.ok(names.has("VERSION"));
  });

  it("detects CommonJS exports via module.exports shorthand", () => {
    const defs = javascriptProvider.extractDefinitions({
      filePath: cjs.filePath,
      captures: cjs.captures,
      sourceText: cjs.sourceText,
    });
    const loader = defs.find((d) => d.qualifiedName === "Loader");
    const helper = defs.find((d) => d.qualifiedName === "helper");
    assert.ok(loader?.isExported, "Loader should be exported via module.exports");
    assert.ok(helper?.isExported, "helper should be exported via module.exports");
  });

  it("extracts require() calls as namespace imports", () => {
    const imports = javascriptProvider.extractImports({
      filePath: cjs.filePath,
      sourceText: cjs.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("node:path"));
    assert.ok(sources.includes("node:fs/promises"));
  });

  it("extracts call sites with enclosing caller names", () => {
    const defs = javascriptProvider.extractDefinitions({
      filePath: esm.filePath,
      captures: esm.captures,
      sourceText: esm.sourceText,
    });
    const calls = javascriptProvider.extractCalls({
      filePath: esm.filePath,
      captures: esm.captures,
      definitions: defs,
    });
    const callers = new Set(calls.map((c) => c.callerQualifiedName));
    assert.ok(callers.has("run"), `callers: ${[...callers].join(",")}`);
    const calleeNames = new Set(calls.map((c) => c.calleeName));
    assert.ok(calleeNames.has("greet"));
    assert.ok(calleeNames.has("debug"));
  });

  it("extracts class EXTENDS heritage edges", () => {
    const defs = javascriptProvider.extractDefinitions({
      filePath: esm.filePath,
      captures: esm.captures,
      sourceText: esm.sourceText,
    });
    const heritage = javascriptProvider.extractHeritage({
      filePath: esm.filePath,
      captures: esm.captures,
      definitions: defs,
    });
    const greeterExtends = heritage.find(
      (h) => h.childQualifiedName === "Greeter" && h.relation === "EXTENDS",
    );
    assert.ok(greeterExtends);
    assert.equal(greeterExtends?.parentName, "Base");
  });
});
