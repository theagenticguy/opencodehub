import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { rustProvider } from "./rust.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
use std::collections::{HashMap, BTreeMap as Sorted};
use crate::logger::Logger;
use crate::util::*;
pub use self::public_api::*;

pub trait Greet {
    fn greet(&self, name: &str) -> String;
}

pub struct Greeter {
    pub name: String,
}

impl Greet for Greeter {
    fn greet(&self, name: &str) -> String {
        self.log(name);
        format!("hi {}", name)
    }
}

impl Greeter {
    fn log(&self, msg: &str) {
        Logger::debug(msg);
    }
}

pub const DEFAULT: u32 = 42;

fn internal() {}
pub fn run() {
    let g = Greeter { name: "world".to_string() };
    g.greet("hello");
}
`;

describe("rustProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "rust", "lib.rs", FIXTURE);
  });

  it("extracts structs, traits, methods, functions, and constants", () => {
    const defs = rustProvider.extractDefinitions({
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
    assert.ok(byKind.get("Trait")?.includes("Greet"));
    assert.ok(byKind.get("Function")?.includes("run"));
    assert.ok(byKind.get("Function")?.includes("internal"));
    assert.ok(byKind.get("Const")?.includes("DEFAULT"));
    // The `impl Greeter` block contains `log` — it should be a Method owned by Greeter.
    assert.ok(byKind.get("Method")?.includes("Greeter.log"));
    // The `impl Greet for Greeter` block contains `greet`.
    assert.ok(byKind.get("Method")?.some((n) => n === "Greeter.greet"));
  });

  it("marks `pub` names as exported, others as not", () => {
    const defs = rustProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    assert.equal(defs.find((d) => d.qualifiedName === "run")?.isExported, true);
    assert.equal(defs.find((d) => d.qualifiedName === "internal")?.isExported, false);
    assert.equal(defs.find((d) => d.qualifiedName === "Greeter")?.isExported, true);
    assert.equal(defs.find((d) => d.qualifiedName === "DEFAULT")?.isExported, true);
  });

  it("parses plain, grouped, aliased, and wildcard use statements", () => {
    const imports = rustProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });

    const stdColl = imports.filter((i) => i.source === "std::collections");
    assert.ok(stdColl.length > 0, `imports: ${JSON.stringify(imports)}`);
    const named = stdColl.find((i) => i.kind === "named");
    assert.ok(named?.importedNames?.includes("HashMap"));
    // `BTreeMap as Sorted` — inline aliasing may resolve to "Sorted".
    const hasSorted =
      named?.importedNames?.includes("Sorted") || named?.importedNames?.includes("BTreeMap");
    assert.ok(hasSorted);

    const logger = imports.find((i) => i.source === "crate::logger");
    assert.equal(logger?.kind, "named");
    assert.ok(logger?.importedNames?.includes("Logger"));

    const utilWildcard = imports.find((i) => i.source === "crate::util" && i.isWildcard === true);
    assert.ok(utilWildcard);
  });

  it("emits IMPLEMENTS edges for `impl Trait for Type`", () => {
    const defs = rustProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = rustProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const greetImpl = heritage.find(
      (h) =>
        h.childQualifiedName === "Greeter" &&
        h.parentName === "Greet" &&
        h.relation === "IMPLEMENTS",
    );
    assert.ok(greetImpl, `heritage: ${JSON.stringify(heritage)}`);
  });

  it("extracts self-method and path-qualified calls", () => {
    const defs = rustProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const calls = rustProvider.extractCalls({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const loggerCall = calls.find((c) => c.calleeName === "debug");
    assert.ok(loggerCall);
    assert.equal(loggerCall?.calleeOwner, "Logger");
  });
});
