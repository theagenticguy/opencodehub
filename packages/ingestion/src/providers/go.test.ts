import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { goProvider } from "./go.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `package greet

import (
    "fmt"
    str "strings"
    . "errors"
)

type Greeter struct {
    name string
}

type Speaker interface {
    Speak() string
}

const (
    MaxGreet = 3
)

func (g *Greeter) Greet(msg string) string {
    return fmt.Sprintf("hi %s: %s", g.name, str.ToLower(msg))
}

func run() {
    g := &Greeter{name: "world"}
    g.Greet("hello")
}

func Exported() {}
func internal() {}
`;

describe("goProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "go", "greet.go", FIXTURE);
  });

  it("extracts struct, interface, function, method, and constants", () => {
    const defs = goProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const byKind = new Map<string, string[]>();
    for (const d of defs) {
      const bucket = byKind.get(d.kind) ?? [];
      bucket.push(d.qualifiedName);
      byKind.set(d.kind, bucket);
    }
    assert.ok(byKind.get("Struct")?.includes("Greeter"));
    assert.ok(byKind.get("Interface")?.includes("Speaker"));
    assert.ok(byKind.get("Function")?.includes("run"));
    assert.ok(byKind.get("Function")?.includes("Exported"));
    assert.ok(byKind.get("Method")?.includes("Greeter.Greet"));
    assert.ok(byKind.get("Const")?.includes("MaxGreet"));
  });

  it("uses uppercase-first rule for exports", () => {
    const defs = goProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const exported = defs.find((d) => d.qualifiedName === "Exported");
    const internal = defs.find((d) => d.qualifiedName === "internal");
    const method = defs.find((d) => d.qualifiedName === "Greeter.Greet");
    const run = defs.find((d) => d.qualifiedName === "run");
    assert.equal(exported?.isExported, true);
    assert.equal(internal?.isExported, false);
    assert.equal(method?.isExported, true);
    assert.equal(run?.isExported, false);
  });

  it("parses single, grouped, aliased, and dot-imports", () => {
    const imports = goProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("fmt"));
    assert.ok(sources.includes("strings"));
    assert.ok(sources.includes("errors"));
    const aliased = imports.find((i) => i.source === "strings");
    assert.equal(aliased?.localAlias, "str");
    const dot = imports.find((i) => i.source === "errors");
    assert.equal(dot?.localAlias, ".");
  });

  it("emits no heritage edges when method sets don't match", () => {
    // Greeter has `Greet` but the Speaker interface wants `Speak` —
    // no IMPLEMENTS edge should fire.
    const defs = goProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = goProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    assert.equal(heritage.length, 0);
  });

  it("emits IMPLEMENTS when a struct's method set covers an interface", async () => {
    const source = `package shop

type Greeter interface {
    Greet(msg string) string
}

type Speaker struct {
    name string
}

func (s *Speaker) Greet(msg string) string {
    return "hi: " + msg
}

func (s *Speaker) Whisper(msg string) string {
    return msg
}
`;
    const localFx = await parseFixture(pool, "go", "shop.go", source);
    const defs = goProvider.extractDefinitions({
      filePath: localFx.filePath,
      captures: localFx.captures,
      sourceText: localFx.sourceText,
    });
    const heritage = goProvider.extractHeritage({
      filePath: localFx.filePath,
      captures: localFx.captures,
      definitions: defs,
    });
    const impl = heritage.find((h) => h.relation === "IMPLEMENTS");
    assert.ok(impl !== undefined, "expected Speaker IMPLEMENTS Greeter");
    assert.equal(impl?.childQualifiedName, "Speaker");
    assert.equal(impl?.parentName, "Greeter");
  });

  it("does not emit IMPLEMENTS when method set is strictly smaller", async () => {
    const source = `package shop

type Mover interface {
    Move() string
    Rotate() string
}

type Car struct{}

func (c *Car) Move() string { return "vroom" }
`;
    const localFx = await parseFixture(pool, "go", "partial.go", source);
    const defs = goProvider.extractDefinitions({
      filePath: localFx.filePath,
      captures: localFx.captures,
      sourceText: localFx.sourceText,
    });
    const heritage = goProvider.extractHeritage({
      filePath: localFx.filePath,
      captures: localFx.captures,
      definitions: defs,
    });
    assert.equal(heritage.length, 0);
  });

  it("extracts method and package-qualified call sites", () => {
    const defs = goProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const calls = goProvider.extractCalls({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const names = new Set(calls.map((c) => c.calleeName));
    assert.ok(names.has("Greet"));
    assert.ok(names.has("Sprintf") || names.has("ToLower"));
    const pkgCall = calls.find((c) => c.calleeName === "Sprintf");
    if (pkgCall !== undefined) {
      assert.equal(pkgCall.calleeOwner, "fmt");
    }
  });
});
