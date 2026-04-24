import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { kotlinProvider } from "./kotlin.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
package auth

import java.util.UUID
import kotlin.collections.*

interface Logger {
    fun log(msg: String)
}

open class Base {
    open fun hello(): String = "hi"
}

class Greeter(val name: String) : Base(), Logger {
    override fun hello(): String {
        log("saying hi to " + name)
        return super.hello() + " " + name
    }

    override fun log(msg: String) {
        println(msg)
    }
}

fun run() {
    val g = Greeter("world")
    g.hello()
}
`;

describe("kotlinProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "kotlin", "Auth.kt", FIXTURE);
  });

  it("extracts classes, interface, and functions", () => {
    const defs = kotlinProvider.extractDefinitions({
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

  it("emits EXTENDS/IMPLEMENTS edges from delegation specifiers", () => {
    const defs = kotlinProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = kotlinProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const greeterParents = heritage
      .filter((h) => h.childQualifiedName === "Greeter")
      .map((h) => h.parentName);
    assert.ok(greeterParents.includes("Base"));
    assert.ok(greeterParents.includes("Logger"));
  });

  it("parses package and wildcard imports", () => {
    const imports = kotlinProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("java.util.UUID"));
    const wildcard = imports.find((i) => i.source === "kotlin.collections");
    assert.equal(wildcard?.isWildcard, true);
  });

  it("extracts function calls", () => {
    const defs = kotlinProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const calls = kotlinProvider.extractCalls({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const names = new Set(calls.map((c) => c.calleeName));
    assert.ok(names.has("Greeter") || names.has("println") || names.has("log"));
  });
});
