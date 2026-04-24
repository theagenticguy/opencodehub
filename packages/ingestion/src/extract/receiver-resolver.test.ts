/**
 * Receiver resolver + detector precision suite (P06).
 *
 * Tests the six regressions the packet closes plus ts-morph graceful
 * degradation. Each test scopes to the smallest surface that still
 * exercises the relevant path so failures point at a single function.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPrismaCalls, detectSupabaseCalls } from "./orm-detector.js";
import { type ImportedSymbol, resolveReceiver, type TsMorphProject } from "./receiver-resolver.js";
import { detectExpressRoutes } from "./route-detector.js";

test("resolveReceiver: matches a localAlias to its module", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([
    ["src/app.ts", [{ source: "express", localAlias: "express" }]],
  ]);
  const origin = resolveReceiver("express", "src/app.ts", imports);
  assert.equal(origin?.moduleName, "express");
  assert.equal(origin?.source, "import-graph");
});

test("resolveReceiver: matches a named import", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([
    ["src/db.ts", [{ source: "@prisma/client", importedNames: ["PrismaClient"] }]],
  ]);
  const origin = resolveReceiver("PrismaClient", "src/db.ts", imports);
  assert.equal(origin?.moduleName, "@prisma/client");
});

test("resolveReceiver: missing file in map → null", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>();
  assert.equal(resolveReceiver("foo", "src/app.ts", imports), null);
});

test("resolveReceiver: falls through to ts-morph when import map misses", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([["src/db.ts", []]]);
  const stub: TsMorphProject = {
    resolveReceiverModule(filePath, identifier) {
      if (filePath === "src/db.ts" && identifier === "prisma") {
        return { moduleName: "@prisma/client", typeName: "PrismaClient" };
      }
      return null;
    },
  };
  const origin = resolveReceiver("prisma", "src/db.ts", imports, stub);
  assert.equal(origin?.moduleName, "@prisma/client");
  assert.equal(origin?.resolvedType, "PrismaClient");
  assert.equal(origin?.source, "type-check");
});

test("resolveReceiver: DET-UN-001 — ts-morph throws → null (graceful)", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([["src/app.ts", []]]);
  const broken: TsMorphProject = {
    resolveReceiverModule() {
      throw new Error("tsconfig.json is corrupt");
    },
  };
  assert.equal(resolveReceiver("x", "src/app.ts", imports, broken), null);
});

// ---------------------------------------------------------------------------
// ORM precision — Prisma
// ---------------------------------------------------------------------------

test("detectPrismaCalls: logger.user.info(...) — no Prisma edge", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([
    ["src/log.ts", [{ source: "winston", localAlias: "logger" }]],
  ]);
  const edges = detectPrismaCalls({
    filePath: "src/log.ts",
    // The word "prisma" is there so the hot-skip guard passes and we
    // reach the actual receiver check. The receiver `logger` resolves
    // to `winston`, so the edge must NOT be emitted.
    content: "// prisma\nlogger.user.findMany();",
    importsByFile: imports,
  });
  assert.deepEqual(edges, []);
});

test("detectPrismaCalls: real @prisma/client import → edge emitted", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([
    ["src/db.ts", [{ source: "@prisma/client", importedNames: ["PrismaClient"] }]],
  ]);
  const edges = detectPrismaCalls({
    filePath: "src/db.ts",
    content: "const prisma = new PrismaClient();\nawait prisma.user.findMany();",
    importsByFile: imports,
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.modelName, "user");
  assert.equal(edges[0]?.operation, "findMany");
  assert.equal(edges[0]?.reason, "heuristic"); // receiver `prisma` isn't an import name,
  // but the module is imported → same-module heuristic applies.
});

// ---------------------------------------------------------------------------
// Route precision — Express
// ---------------------------------------------------------------------------

test("detectExpressRoutes: myApp.get(...) on non-express — no route emitted", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([
    ["src/custom.ts", [{ source: "./my-framework.js", localAlias: "myApp" }]],
  ]);
  const routes = detectExpressRoutes({
    filePath: "src/custom.ts",
    content: "myApp.get('/health', (req, res) => res.json({}));",
    importsByFile: imports,
  });
  assert.deepEqual(routes, []);
});

test("detectExpressRoutes: real express import → route emitted", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([
    ["src/server.ts", [{ source: "express", localAlias: "express" }]],
  ]);
  const routes = detectExpressRoutes({
    filePath: "src/server.ts",
    content: "const app = express();\napp.get('/health', (req, res) => res.json({}));",
    importsByFile: imports,
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.method, "GET");
  assert.equal(routes[0]?.url, "/health");
});

// ---------------------------------------------------------------------------
// Graceful degradation — ts-morph missing
// ---------------------------------------------------------------------------

test("detectExpressRoutes: ts-morph missing → still falls back to import-graph", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([
    ["src/server.ts", [{ source: "express", localAlias: "express" }]],
  ]);
  // No tsMorphProject supplied at all — the import-graph path must still
  // greenlight the emit.
  const routes = detectExpressRoutes({
    filePath: "src/server.ts",
    content: "const app = express();\napp.get('/x', h);",
    importsByFile: imports,
  });
  assert.equal(routes.length, 1);
});

test("detectSupabaseCalls: false positive is dropped when import map misses", () => {
  const imports = new Map<string, readonly ImportedSymbol[]>([
    ["src/other.ts", [{ source: "./fake-supabase.js", localAlias: "supabase" }]],
  ]);
  const edges = detectSupabaseCalls({
    filePath: "src/other.ts",
    content: "supabase.from('orders').select('*');",
    importsByFile: imports,
  });
  assert.deepEqual(edges, []);
});

// ---------------------------------------------------------------------------
// strictDetectors — DET-O-001
// ---------------------------------------------------------------------------

test("strictDetectors: drops heuristic matches when no import map is present", () => {
  const edges = detectPrismaCalls({
    filePath: "src/legacy.ts",
    content: "prisma.user.findMany();",
    strictDetectors: true,
  });
  assert.deepEqual(edges, []);
});

test("strictDetectors off: heuristic match is preserved (legacy)", () => {
  const edges = detectPrismaCalls({
    filePath: "src/legacy.ts",
    content: "prisma.user.findMany();",
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.reason, "heuristic");
});
