import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { dartProvider } from "./dart.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
import 'dart:io';
import 'package:meta/meta.dart' as meta;

abstract class Logger {
  void log(String msg);
}

mixin Timestamps {
  void touch() {}
}

class Base {
  String hello() => "hi";
}

class Greeter extends Base with Timestamps implements Logger {
  final String name;

  Greeter(this.name);

  @override
  String hello() {
    log("saying hi");
    return super.hello() + " " + name;
  }

  @override
  void log(String msg) {
    stdout.writeln(msg);
  }
}

void run() {
  final g = Greeter("world");
  g.hello();
}
`;

describe("dartProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "dart", "auth.dart", FIXTURE);
  });

  it("extracts classes, mixin, and functions", () => {
    const defs = dartProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const byName = new Map(defs.map((d) => [d.name, d]));
    assert.ok(byName.has("Logger"));
    assert.ok(byName.has("Timestamps"));
    assert.equal(byName.get("Timestamps")?.kind, "Trait", "mixin -> Trait kind");
    assert.ok(byName.has("Base"));
    assert.ok(byName.has("Greeter"));
    assert.ok(byName.has("run"));
  });

  it("emits EXTENDS + IMPLEMENTS + mixin edges for extends/implements/with", () => {
    const defs = dartProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = dartProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const greeter = heritage.filter((h) => h.childQualifiedName === "Greeter");
    assert.ok(
      greeter.some((h) => h.relation === "EXTENDS" && h.parentName === "Base"),
      "missing EXTENDS Base",
    );
    assert.ok(
      greeter.some((h) => h.relation === "IMPLEMENTS" && h.parentName === "Logger"),
      "missing IMPLEMENTS Logger",
    );
    assert.ok(
      greeter.some((h) => h.relation === "IMPLEMENTS" && h.parentName === "Timestamps"),
      "missing mixin-as-IMPLEMENTS Timestamps",
    );
  });

  it("parses import directives", () => {
    const imports = dartProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("dart:io"));
    assert.ok(sources.includes("package:meta/meta.dart"));
    const aliased = imports.find((i) => i.source === "package:meta/meta.dart");
    assert.equal(aliased?.localAlias, "meta");
  });
});
