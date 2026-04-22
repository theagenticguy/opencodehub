import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { phpProvider } from "./php.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `<?php
namespace Auth;

use Psr\\Log\\LoggerInterface;
require_once 'config.php';

interface Authenticatable
{
    public function login(): bool;
}

trait Timestamps
{
    public function touch(): void {}
}

class Base
{
    public function hello(): string { return "hi"; }
}

class Greeter extends Base implements Authenticatable
{
    use Timestamps;

    private string $name;

    public function __construct(string $name)
    {
        $this->name = $name;
    }

    public function login(): bool
    {
        $this->hello();
        return true;
    }
}

function run(): void
{
    $g = new Greeter("world");
    $g->login();
}
`;

describe("phpProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "php", "Auth.php", FIXTURE);
  });

  it("extracts classes, interfaces, traits, and functions", () => {
    const defs = phpProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const byName = new Map(defs.map((d) => [d.name, d]));
    assert.ok(byName.has("Authenticatable"));
    assert.ok(byName.has("Timestamps"));
    assert.ok(byName.has("Base"));
    assert.ok(byName.has("Greeter"));
    assert.equal(byName.get("Authenticatable")?.kind, "Interface");
    assert.equal(byName.get("Timestamps")?.kind, "Trait");
  });

  it("emits EXTENDS + IMPLEMENTS + trait-use edges", () => {
    const defs = phpProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = phpProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const greeter = heritage.filter((h) => h.childQualifiedName.endsWith("Greeter"));
    const extends_ = greeter.find((h) => h.relation === "EXTENDS" && h.parentName === "Base");
    const impls = greeter.find(
      (h) => h.relation === "IMPLEMENTS" && h.parentName === "Authenticatable",
    );
    const trait = greeter.find((h) => h.relation === "IMPLEMENTS" && h.parentName === "Timestamps");
    assert.ok(extends_, "EXTENDS Base edge missing");
    assert.ok(impls, "IMPLEMENTS Authenticatable edge missing");
    assert.ok(trait, "trait Timestamps edge missing");
  });

  it("parses use and require imports", () => {
    const imports = phpProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.some((s) => s.includes("Psr") && s.includes("LoggerInterface")));
    assert.ok(sources.some((s) => s.includes("config.php")));
  });

  it("extracts method call sites", () => {
    const defs = phpProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const calls = phpProvider.extractCalls({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const names = new Set(calls.map((c) => c.calleeName));
    assert.ok(names.has("hello") || names.has("login"));
  });
});
