import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { cppProvider } from "./cpp.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
#include <string>
#include "db.h"

namespace auth {

class Base {
public:
    virtual std::string hello() { return "hi"; }
};

class Mixin {
public:
    virtual void mix() {}
};

class Greeter : public Base, private Mixin {
public:
    Greeter(std::string name) : name_(name) {}
    std::string hello() { return "hello " + name_; }
private:
    std::string name_;
};

void run() {
    Greeter g("world");
    g.hello();
}

}  // namespace auth
`;

describe("cppProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "cpp", "greet.cpp", FIXTURE);
  });

  it("extracts classes, namespace, and functions", () => {
    const defs = cppProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const names = new Set(defs.map((d) => d.name));
    assert.ok(names.has("Base"));
    assert.ok(names.has("Mixin"));
    assert.ok(names.has("Greeter"));
    assert.ok(names.has("auth"), "namespace auth should be extracted");
    assert.ok(names.has("run"));
  });

  it("emits base-class heritage edges for multiple inheritance", () => {
    const defs = cppProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = cppProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const greeterParents = heritage
      .filter((h) => h.childQualifiedName.endsWith("Greeter"))
      .map((h) => h.parentName)
      .sort();
    assert.deepEqual(greeterParents, ["Base", "Mixin"]);
  });

  it("parses #include directives", () => {
    const imports = cppProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("string"));
    assert.ok(sources.includes("db.h"));
  });

  it("parses C++20 import (named module, <system>, \"user\")", () => {
    const source = `import std;
export import math.core;
import <vector>;
import "utility.hpp";

int main() { return 0; }
`;
    const imports = cppProvider.extractImports({
      filePath: "app.cpp",
      sourceText: source,
    });
    const byKind = new Map<string, string[]>();
    for (const i of imports) {
      const bucket = byKind.get(i.kind) ?? [];
      bucket.push(i.source);
      byKind.set(i.kind, bucket);
    }
    assert.ok(byKind.get("named")?.includes("std"));
    assert.ok(byKind.get("named")?.includes("math.core"));
    assert.ok(byKind.get("package-wildcard")?.includes("vector"));
    assert.ok(byKind.get("package-wildcard")?.includes("utility.hpp"));
  });

  it("extracts calls", () => {
    const defs = cppProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const calls = cppProvider.extractCalls({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const names = calls.map((c) => c.calleeName);
    assert.ok(names.includes("hello") || names.includes("Greeter"));
  });
});
