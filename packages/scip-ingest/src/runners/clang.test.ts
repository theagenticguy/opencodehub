/**
 * Tests for the scip-clang adapter (AC-M4-1).
 *
 * Coverage mirrors the other adapter contracts:
 *   1. `buildCommand("clang", ...)` shell shape matches scip-clang v0.4.0:
 *      `--compdb-path=<abs>` + `--index-output-path=<abs>` with the project
 *      root as cwd. Exact flag names were verified against the upstream
 *      source at `indexer/main.cc` (scip-clang/tree/v0.4.0).
 *   2. Missing `compile_commands.json` → `buildCommand` returns a plan
 *      with the specific `skipReason` the preflight mandates.
 *   3. `detectLanguages()` surfaces `"clang"` when a C/C++ source file or
 *      `compile_commands.json` sits at the project root.
 *   4. `runIndexer("clang", ...)` propagates the preflight skip path (no
 *      subprocess spawn when the compile-db is missing).
 *   5. Missing binary path: with a present compile-db but an empty PATH,
 *      `runIndexer` reports `skipped: true` via the ENOENT → "missing"
 *      branch shared by every adapter.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildCommand,
  detectLanguages,
  type IndexerKind,
  type RunIndexerOptions,
  runIndexer,
} from "./index.js";

async function makeTempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function baseOpts(projectRoot: string): RunIndexerOptions {
  return {
    projectRoot,
    outputDir: join(projectRoot, ".codehub", "scip"),
    projectName: "fixture",
    envOverlay: { PATH: "" },
    timeoutMs: 5000,
  };
}

describe('buildCommand("clang", …)', () => {
  it("emits `scip-clang --compdb-path --index-output-path` when compile_commands.json exists", async () => {
    const root = await makeTempRoot("och-clang-buildcmd-");
    try {
      const compdb = join(root, "compile_commands.json");
      await writeFile(compdb, "[]\n");
      const scipPath = join(root, ".codehub", "scip", "clang.scip");

      const plan = buildCommand("clang", baseOpts(root), scipPath);

      assert.equal(plan.cmd, "scip-clang");
      assert.equal(plan.tool, "scip-clang");
      assert.equal(plan.cwd, root);
      assert.equal(plan.skipReason, undefined);
      assert.deepEqual(Array.from(plan.args), [
        `--compdb-path=${compdb}`,
        `--index-output-path=${scipPath}`,
      ]);
      // Exact flag names are load-bearing — they match scip-clang v0.4.0
      // (`indexer/main.cc` — `compdb-path`, `index-output-path`). Guard
      // against an accidental rename to `--output` / `--compilation-database`.
      assert.ok(!plan.args.includes("--output"));
      assert.ok(plan.args.every((a) => !a.startsWith("--compilation-database")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a specific skipReason when compile_commands.json is absent", async () => {
    const root = await makeTempRoot("och-clang-no-compdb-");
    try {
      const scipPath = join(root, ".codehub", "scip", "clang.scip");
      const plan = buildCommand("clang", baseOpts(root), scipPath);

      assert.equal(plan.cmd, "scip-clang");
      assert.equal(plan.tool, "scip-clang");
      assert.equal(plan.args.length, 0);
      assert.equal(plan.skipReason, "scip-clang requires compile_commands.json at project root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("detectLanguages() — clang branch", () => {
  it("surfaces `clang` when compile_commands.json sits at the project root", async () => {
    const root = await makeTempRoot("och-clang-detect-compdb-");
    try {
      await writeFile(join(root, "compile_commands.json"), "[]\n");
      const langs: readonly IndexerKind[] = detectLanguages(root);
      assert.ok(langs.includes("clang"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces `clang` for a project with only C++ sources at the root", async () => {
    const root = await makeTempRoot("och-clang-detect-cpp-");
    try {
      await writeFile(join(root, "main.cpp"), "int main() { return 0; }\n");
      const langs = detectLanguages(root);
      assert.ok(langs.includes("clang"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces `clang` when a header is nested one level deep", async () => {
    const root = await makeTempRoot("och-clang-detect-nested-");
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(root, "include"));
      await writeFile(join(root, "include", "api.hpp"), "#pragma once\n");
      const langs = detectLanguages(root);
      assert.ok(langs.includes("clang"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does NOT surface `clang` on a pure TypeScript project", async () => {
    const root = await makeTempRoot("och-clang-detect-ts-");
    try {
      await writeFile(join(root, "package.json"), "{}\n");
      const langs = detectLanguages(root);
      assert.ok(!langs.includes("clang"));
      assert.ok(langs.includes("typescript"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('runIndexer("clang", …)', () => {
  it("skips cleanly when compile_commands.json is missing (no subprocess spawn)", async () => {
    const root = await makeTempRoot("och-clang-run-no-compdb-");
    try {
      const result = await runIndexer("clang", baseOpts(root));
      assert.equal(result.kind, "clang");
      assert.equal(result.skipped, true);
      assert.equal(result.skipReason, "scip-clang requires compile_commands.json at project root");
      assert.equal(result.tool, "scip-clang");
      assert.equal(result.version, "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports `skipped` with a 'binary not found' reason when scip-clang is not on PATH (ENOENT)", async () => {
    const root = await makeTempRoot("och-clang-run-no-binary-");
    try {
      // Preflight must pass so the spawn path runs. The empty PATH in
      // baseOpts().envOverlay blocks `scip-clang` lookup → ENOENT →
      // `missing` → adapter returns `skipped: true`.
      await writeFile(join(root, "compile_commands.json"), "[]\n");
      const result = await runIndexer("clang", baseOpts(root));
      assert.equal(result.kind, "clang");
      assert.equal(result.skipped, true);
      assert.ok(result.skipReason?.includes("indexer binary not found"));
      assert.ok(result.skipReason?.includes("scip-clang"));
      assert.equal(result.tool, "scip-clang");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
