import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { parseFixture } from "./test-helpers.js";
import { typescriptProvider } from "./typescript.js";

const FIXTURE = `
import { Logger } from "./logger.js";
import * as util from "./util";
import defaultExport, { other } from "./mixed";

export interface Greeter extends Base {
  greet(name: string): string;
}

export abstract class Welcomer implements Greeter {
  private banner: string;
  public greet(name: string): string {
    this.log(name);
    return "hi " + name;
  }
  private log(msg: string): void {
    Logger.debug(msg);
  }
}

export const MESSAGE = "welcome";

export function run(): void {
  const w = new Welcomer();
  w.greet("world");
}
`;

describe("typescriptProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let captures: (typeof fixture)["captures"];
  let fixture: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fixture = await parseFixture(pool, "typescript", "greeter.ts", FIXTURE);
    captures = fixture.captures;
  });

  it("extracts class, interface, method, const, function definitions with owners", () => {
    const defs = typescriptProvider.extractDefinitions({
      filePath: fixture.filePath,
      captures,
      sourceText: fixture.sourceText,
    });
    const byKind = new Map<string, string[]>();
    for (const d of defs) {
      const bucket = byKind.get(d.kind) ?? [];
      bucket.push(d.qualifiedName);
      byKind.set(d.kind, bucket);
    }
    assert.ok(byKind.get("Class")?.includes("Welcomer"), `got: ${JSON.stringify([...byKind])}`);
    assert.ok(byKind.get("Interface")?.includes("Greeter"));
    assert.ok(byKind.get("Method")?.includes("Welcomer.greet"));
    assert.ok(byKind.get("Method")?.includes("Welcomer.log"));
    assert.ok(byKind.get("Const")?.includes("MESSAGE"));
    assert.ok(byKind.get("Function")?.includes("run"));
  });

  it("marks exported vs non-exported defs correctly", () => {
    const defs = typescriptProvider.extractDefinitions({
      filePath: fixture.filePath,
      captures,
      sourceText: fixture.sourceText,
    });
    const welcomer = defs.find((d) => d.qualifiedName === "Welcomer");
    const run = defs.find((d) => d.qualifiedName === "run");
    const privateLog = defs.find((d) => d.qualifiedName === "Welcomer.log");
    assert.equal(welcomer?.isExported, true);
    assert.equal(run?.isExported, true);
    assert.equal(privateLog?.isExported, false, "private methods should not be exported");
  });

  it("extracts call sites with callerQualifiedName inferred from enclosing def", () => {
    const defs = typescriptProvider.extractDefinitions({
      filePath: fixture.filePath,
      captures,
      sourceText: fixture.sourceText,
    });
    const calls = typescriptProvider.extractCalls({
      filePath: fixture.filePath,
      captures,
      definitions: defs,
    });
    // We should see calls from `Welcomer.greet` -> this.log, from `Welcomer.log` -> Logger.debug,
    // and from `run` -> w.greet.
    const callerNames = new Set(calls.map((c) => c.callerQualifiedName));
    assert.ok(callerNames.has("Welcomer.greet"), `callers: ${[...callerNames].join(",")}`);
    assert.ok(callerNames.has("run"));

    const calleeNames = new Set(calls.map((c) => c.calleeName));
    assert.ok(calleeNames.has("log"));
    assert.ok(calleeNames.has("debug"));
    assert.ok(calleeNames.has("greet"));
  });

  it("extracts named, namespace, default, and side-effect imports", () => {
    const imports = typescriptProvider.extractImports({
      filePath: fixture.filePath,
      sourceText: fixture.sourceText,
    });
    const sources = imports.map((i) => `${i.kind}:${i.source}`);
    assert.ok(
      sources.some((s) => s.startsWith("named:./logger")),
      `imports: ${JSON.stringify(imports)}`,
    );
    assert.ok(
      imports.some((i) => i.kind === "namespace" && i.localAlias === "util"),
      `expected namespace alias 'util'; got ${JSON.stringify(imports)}`,
    );
    assert.ok(
      imports.some((i) => i.kind === "default" && i.localAlias === "defaultExport"),
      `expected default import`,
    );
  });

  it("preprocessImportPath strips known script suffixes", () => {
    assert.equal(typescriptProvider.preprocessImportPath?.("./logger.js"), "./logger");
    assert.equal(typescriptProvider.preprocessImportPath?.("./util"), "./util");
    assert.equal(typescriptProvider.preprocessImportPath?.("./a.tsx"), "./a");
  });

  it("extracts EXTENDS and IMPLEMENTS heritage edges", () => {
    const defs = typescriptProvider.extractDefinitions({
      filePath: fixture.filePath,
      captures,
      sourceText: fixture.sourceText,
    });
    const heritage = typescriptProvider.extractHeritage({
      filePath: fixture.filePath,
      captures,
      definitions: defs,
    });
    const extends_ = heritage.filter((h) => h.relation === "EXTENDS");
    const implements_ = heritage.filter((h) => h.relation === "IMPLEMENTS");
    assert.ok(
      extends_.some((h) => h.childQualifiedName === "Greeter" && h.parentName === "Base"),
      `extends edges: ${JSON.stringify(extends_)}`,
    );
    assert.ok(
      implements_.some((h) => h.childQualifiedName === "Welcomer" && h.parentName === "Greeter"),
      `implements edges: ${JSON.stringify(implements_)}`,
    );
  });
});

// Barrel re-exports, multi-line import clauses, and dynamic imports used to be
// silently dropped by the shared TS/JS extractor (the per-line scan required a
// `from` clause on one physical line and a leading `import` keyword). These
// fixtures lock in that each now produces an import/dependency record.
const EDGE_FIXTURE = `
import {
  alpha,
  beta as renamedBeta,
  gamma,
} from "./multi.js";

export { x, y as aliasedY } from "./named-barrel.js";
export * from "./star-barrel.js";
export * as ns from "./ns-barrel.js";

export async function load(name: string) {
  const mod = await import("./dynamic.js");
  const tpl = await import(\`./locales/\${name}.json\`);
  const pure = await import(\`./pure-template.js\`);
  return [mod, tpl, pure];
}
`;

describe("extractTsImports (re-exports, multi-line, dynamic)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fixture: Awaited<ReturnType<typeof parseFixture>>;
  before(async () => {
    fixture = await parseFixture(pool, "typescript", "barrels.ts", EDGE_FIXTURE);
  });

  it("captures a multi-line `import { a, b } from` clause", () => {
    const imports = typescriptProvider.extractImports({
      filePath: fixture.filePath,
      sourceText: fixture.sourceText,
    });
    const multi = imports.find((i) => i.source === "./multi.js");
    assert.ok(multi, `expected multi-line import; got ${JSON.stringify(imports)}`);
    assert.equal(multi?.kind, "named");
    assert.deepEqual([...(multi?.importedNames ?? [])].sort(), ["alpha", "gamma", "renamedBeta"]);
  });

  it("captures `export { x } from` re-export barrels as named imports", () => {
    const imports = typescriptProvider.extractImports({
      filePath: fixture.filePath,
      sourceText: fixture.sourceText,
    });
    const reexport = imports.find((i) => i.source === "./named-barrel.js");
    assert.ok(reexport, `expected named re-export; got ${JSON.stringify(imports)}`);
    assert.equal(reexport?.kind, "named");
    assert.deepEqual([...(reexport?.importedNames ?? [])].sort(), ["aliasedY", "x"]);
  });

  it("captures `export * from` and `export * as ns from` barrels as wildcards", () => {
    const imports = typescriptProvider.extractImports({
      filePath: fixture.filePath,
      sourceText: fixture.sourceText,
    });
    const star = imports.find((i) => i.source === "./star-barrel.js");
    assert.ok(star, `expected star re-export; got ${JSON.stringify(imports)}`);
    assert.equal(star?.kind, "package-wildcard");
    assert.equal(star?.isWildcard, true);

    const namedStar = imports.find((i) => i.source === "./ns-barrel.js");
    assert.ok(namedStar, "expected `export * as ns` re-export");
    assert.equal(namedStar?.kind, "package-wildcard");
    assert.equal(namedStar?.localAlias, "ns");
  });

  it("captures string-literal and static-template dynamic imports", () => {
    const imports = typescriptProvider.extractImports({
      filePath: fixture.filePath,
      sourceText: fixture.sourceText,
    });
    const sources = new Set(imports.map((i) => i.source));
    assert.ok(sources.has("./dynamic.js"), "string-literal dynamic import");
    assert.ok(sources.has("./pure-template.js"), "pure template-literal dynamic import");
    // A static-prefixed template yields the determinable prefix, not the
    // unresolvable interpolation tail.
    assert.ok(sources.has("./locales/"), `template prefix; got ${[...sources].join(",")}`);
  });
});
