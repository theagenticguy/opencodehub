import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { csharpProvider } from "./csharp.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
using System;
using System.Collections.Generic;
using Json = Newtonsoft.Json;

namespace App.Greet
{
    public interface IGreeter
    {
        string Greet(string name);
    }

    public abstract class Base
    {
        protected string Prefix = "hi";
    }

    public class Welcomer : Base, IGreeter, IDisposable
    {
        private int _count;

        public Welcomer()
        {
            this._count = 1;
        }

        public string Greet(string name)
        {
            return Prefix + " " + name;
        }

        public void Dispose()
        {
            Console.WriteLine("done");
        }
    }

    public record Pair(string First, string Second);

    public struct Point { public int X; public int Y; }

    internal class Hidden {}
}
`;

describe("csharpProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "csharp", "Welcomer.cs", FIXTURE);
  });

  it("extracts class, interface, struct, record, and constructor kinds", () => {
    const defs = csharpProvider.extractDefinitions({
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
    assert.ok(byKind.get("Interface")?.some((n) => n.endsWith("IGreeter")));
    assert.ok(byKind.get("Class")?.some((n) => n.endsWith("Welcomer")));
    assert.ok(byKind.get("Record")?.some((n) => n.endsWith("Pair")));
    assert.ok(byKind.get("Struct")?.some((n) => n.endsWith("Point")));
    assert.ok(byKind.get("Constructor")?.some((n) => n.endsWith("Welcomer")));
  });

  it("treats `public` as exported, `internal` as not", () => {
    const defs = csharpProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const welcomer = defs.find((d) => d.qualifiedName.endsWith("Welcomer") && d.kind === "Class");
    const hidden = defs.find((d) => d.qualifiedName.endsWith("Hidden"));
    assert.equal(welcomer?.isExported, true);
    assert.equal(hidden?.isExported, false);
  });

  it("parses namespace, static, and aliased using directives", () => {
    const imports = csharpProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("System"));
    assert.ok(sources.includes("System.Collections.Generic"));
    const aliased = imports.find((i) => i.localAlias === "Json");
    assert.ok(aliased, `imports: ${JSON.stringify(imports)}`);
    assert.equal(aliased?.source, "Newtonsoft.Json");
  });

  it("applies the I-prefix heuristic: first item is EXTENDS unless it looks like an interface", () => {
    const defs = csharpProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const heritage = csharpProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const extendsBase = heritage.find((h) => h.relation === "EXTENDS" && h.parentName === "Base");
    const implementsIGreeter = heritage.find(
      (h) => h.relation === "IMPLEMENTS" && h.parentName === "IGreeter",
    );
    const implementsIDisposable = heritage.find(
      (h) => h.relation === "IMPLEMENTS" && h.parentName === "IDisposable",
    );
    assert.ok(extendsBase, `heritage: ${JSON.stringify(heritage)}`);
    assert.ok(implementsIGreeter);
    assert.ok(implementsIDisposable);
  });
});
