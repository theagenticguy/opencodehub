import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { rubyProvider } from "./ruby.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
require 'digest'
require_relative './session'

module Auth
  class Base
    def greet(name)
      "hi " + name
    end
  end

  module Logger
    def log(msg); end
  end

  class Greeter < Base
    include Logger

    def greet(name)
      log("greeting " + name)
      super
    end

    def _private
      greet("world")
    end
  end
end

def run
  g = Auth::Greeter.new
  g.greet("world")
end
`;

describe("rubyProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "ruby", "auth.rb", FIXTURE);
  });

  it("extracts classes, modules, and methods", () => {
    const defs = rubyProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const names = new Set(defs.map((d) => d.name));
    assert.ok(names.has("Auth"), "module Auth");
    assert.ok(names.has("Base"));
    assert.ok(names.has("Greeter"));
    assert.ok(names.has("Logger"));
    assert.ok(names.has("greet"));
    assert.ok(names.has("run"));
  });

  it("emits EXTENDS for `class Foo < Bar`", () => {
    const defs = rubyProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = rubyProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const greeter = heritage.filter(
      (h) => h.relation === "EXTENDS" && h.childQualifiedName.endsWith("Greeter"),
    );
    assert.ok(greeter.some((h) => h.parentName === "Base"));
  });

  it("parses require and require_relative imports", () => {
    const imports = rubyProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("digest"));
    assert.ok(sources.includes("./session"));
    const rel = imports.find((i) => i.source === "./session");
    assert.equal(rel?.kind, "named");
  });

  it("extracts method calls (excluding include/require)", () => {
    const defs = rubyProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const calls = rubyProvider.extractCalls({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const names = new Set(calls.map((c) => c.calleeName));
    assert.ok(!names.has("require"), "require must not appear as a call");
    assert.ok(!names.has("include"), "include must not appear as a call");
    assert.ok(names.has("log") || names.has("greet"));
  });
});
