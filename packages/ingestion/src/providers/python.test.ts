import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { pythonProvider } from "./python.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
import os
import numpy as np
from typing import List, Optional as Opt
from utils import *

MAX_RETRY = 3
_internal_version = "0.1"

class Base:
    def greet(self, name):
        return "hi " + name

class Greeter(Base, Mixin):
    def greet(self, name):
        os.getenv("USER")
        return super().greet(name)

    def _private(self):
        self.greet("world")

def run():
    g = Greeter()
    g.greet("world")
`;

describe("pythonProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "python", "mod.py", FIXTURE);
  });

  it("classifies method vs function by nesting", () => {
    const defs = pythonProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const byName = new Map(defs.map((d) => [d.qualifiedName, d]));
    assert.equal(byName.get("Greeter.greet")?.kind, "Method");
    assert.equal(byName.get("run")?.kind, "Function");
    assert.equal(byName.get("Base")?.kind, "Class");
    assert.equal(byName.get("Greeter")?.kind, "Class");
    assert.equal(byName.get("MAX_RETRY")?.kind, "Const");
  });

  it("treats leading-underscore names as not exported", () => {
    const defs = pythonProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const priv = defs.find((d) => d.qualifiedName === "Greeter._private");
    const pub = defs.find((d) => d.qualifiedName === "Greeter.greet");
    const maxRetry = defs.find((d) => d.qualifiedName === "MAX_RETRY");
    const internalVer = defs.find((d) => d.qualifiedName === "_internal_version");
    assert.equal(priv?.isExported, false);
    assert.equal(pub?.isExported, true);
    assert.equal(maxRetry?.isExported, true);
    assert.equal(internalVer?.isExported, false);
  });

  it("emits a base-class edge per parent so C3 has the full list", () => {
    const defs = pythonProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = pythonProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const greeterParents = heritage
      .filter((h) => h.childQualifiedName === "Greeter")
      .map((h) => h.parentName);
    assert.deepEqual([...greeterParents].sort(), ["Base", "Mixin"]);
  });

  it("parses `import`, `from ... import`, aliased, and wildcard forms", () => {
    const imports = pythonProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const findBySource = (source: string) => imports.filter((i) => i.source === source);

    assert.equal(findBySource("os").length, 1);
    assert.equal(findBySource("os")[0]?.kind, "namespace");

    const numpy = findBySource("numpy")[0];
    assert.equal(numpy?.kind, "namespace");
    assert.equal(numpy?.localAlias, "np");

    const typing = findBySource("typing")[0];
    assert.equal(typing?.kind, "named");
    assert.ok(typing?.importedNames?.includes("List"));
    assert.ok(typing?.importedNames?.includes("Opt"));

    const utils = findBySource("utils")[0];
    assert.equal(utils?.kind, "package-wildcard");
    assert.equal(utils?.isWildcard, true);
  });

  it("extracts self-receiver calls in methods", () => {
    const defs = pythonProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const calls = pythonProvider.extractCalls({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const privCall = calls.find(
      (c) => c.callerQualifiedName === "Greeter._private" && c.calleeName === "greet",
    );
    assert.ok(privCall, `call not found among: ${JSON.stringify(calls)}`);
    assert.equal(privCall?.calleeOwner, "self");
  });

  it("class-body Property captures do not steal CALLS ownership", async () => {
    const propFx = await parseFixture(
      pool,
      "python",
      "cls.py",
      `
def make_default():
    return 1

class Config:
    retries: int = make_default()
    timeout = make_default()

    def configure(self):
        return make_default()
`,
    );
    const defs = pythonProvider.extractDefinitions({
      filePath: propFx.filePath,
      captures: propFx.captures,
      sourceText: propFx.sourceText,
    });
    // Property nodes are emitted for class-body attributes.
    const props = defs.filter((d) => d.kind === "Property");
    assert.equal(props.length, 2, `props: ${JSON.stringify(props)}`);
    assert.deepEqual(props.map((p) => p.name).sort(), ["retries", "timeout"]);

    const calls = pythonProvider.extractCalls({
      filePath: propFx.filePath,
      captures: propFx.captures,
      definitions: defs,
    });
    // Each call to make_default() must attribute to either a method or the
    // class itself or <module> — never to the Property (retries/timeout).
    for (const c of calls) {
      if (c.calleeName !== "make_default") continue;
      assert.notEqual(
        c.callerQualifiedName,
        "Config.retries",
        `call attributed to Property instead of enclosing scope: ${JSON.stringify(c)}`,
      );
      assert.notEqual(
        c.callerQualifiedName,
        "Config.timeout",
        `call attributed to Property instead of enclosing scope: ${JSON.stringify(c)}`,
      );
    }
    // The call in configure() must attribute to the method.
    const cfgCall = calls.find(
      (c) => c.calleeName === "make_default" && c.callerQualifiedName === "Config.configure",
    );
    assert.ok(cfgCall, `Config.configure call missing: ${JSON.stringify(calls)}`);
  });
});
