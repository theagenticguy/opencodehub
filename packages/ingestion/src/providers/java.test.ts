import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { javaProvider } from "./java.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
package com.example.greet;

import java.util.List;
import java.util.concurrent.*;
import static java.lang.Math.PI;

public interface Greeter {
    String greet(String name);
}

public abstract class Base {
    protected String prefix = "hi";
}

public class Welcomer extends Base implements Greeter, Runnable {
    private int count = 0;

    public Welcomer() {
        this.count = 1;
    }

    public String greet(String name) {
        return prefix + " " + name;
    }

    public void run() {
        greet("world");
    }
}

class Internal {}
`;

describe("javaProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "java", "Welcomer.java", FIXTURE);
  });

  it("extracts class, interface, constructor, and method definitions", () => {
    const defs = javaProvider.extractDefinitions({
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
    assert.ok(byKind.get("Interface")?.includes("Greeter"));
    assert.ok(byKind.get("Class")?.includes("Welcomer"));
    assert.ok(byKind.get("Method")?.includes("Welcomer.greet"));
    assert.ok(byKind.get("Method")?.includes("Welcomer.run"));
    assert.ok(byKind.get("Constructor")?.includes("Welcomer.Welcomer"));
  });

  it("treats `public` as exported, package-private as not", () => {
    const defs = javaProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    assert.equal(defs.find((d) => d.qualifiedName === "Welcomer")?.isExported, true);
    assert.equal(defs.find((d) => d.qualifiedName === "Internal")?.isExported, false);
  });

  it("parses named and wildcard imports, including static imports", () => {
    const imports = javaProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const listImport = imports.find(
      (i) => i.source === "java.util" && i.importedNames?.includes("List"),
    );
    assert.ok(listImport);
    const concurrent = imports.find(
      (i) => i.source === "java.util.concurrent" && i.kind === "package-wildcard",
    );
    assert.ok(concurrent);
    const staticPi = imports.find((i) => i.importedNames?.includes("PI"));
    assert.ok(staticPi);
  });

  it("extracts EXTENDS and IMPLEMENTS heritage", () => {
    const defs = javaProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = javaProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const extends_ = heritage.find(
      (h) => h.childQualifiedName === "Welcomer" && h.relation === "EXTENDS",
    );
    const implementsGreeter = heritage.find(
      (h) =>
        h.childQualifiedName === "Welcomer" &&
        h.relation === "IMPLEMENTS" &&
        h.parentName === "Greeter",
    );
    const implementsRunnable = heritage.find(
      (h) =>
        h.childQualifiedName === "Welcomer" &&
        h.relation === "IMPLEMENTS" &&
        h.parentName === "Runnable",
    );
    assert.ok(extends_);
    assert.equal(extends_?.parentName, "Base");
    assert.ok(implementsGreeter);
    assert.ok(implementsRunnable);
  });
});
