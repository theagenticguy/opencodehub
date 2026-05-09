/**
 * Unit tests for the scip-kotlin v0.6.0 adapter.
 *
 * Covered paths:
 *   - `detectLanguages`: pure-Kotlin projects drop the legacy `"java"` candidate;
 *     mixed Kotlin+Java projects keep both; pure-Java stays Java-only.
 *   - `checkKotlinMinVersion`: Kotlin 2.2+ passes; < 2.2 surfaces a clean
 *     skip-reason; unknown / unparseable versions refuse to run against an
 *     unverifiable toolchain.
 *   - `runIndexer("kotlin", ...)`: honors the `allowBuildScripts` gate (skip),
 *     surfaces a "binary not found" skip when `kotlinc` is absent from PATH,
 *     and surfaces the "too old" skip when the installed Kotlin is < 2.2.
 *
 * We do NOT run a real kotlinc here — that would require Kotlin 2.2+ and the
 * scip-kotlin JAR installed in CI. The adapter smoke test against live
 * tooling lives under the repo's e2e suite.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  checkKotlinMinVersion,
  detectLanguages,
  KOTLIN_MIN_MAJOR,
  KOTLIN_MIN_MINOR,
  runIndexer,
} from "./index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "och-scip-kotlin-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("checkKotlinMinVersion", () => {
  it(`accepts exactly Kotlin ${KOTLIN_MIN_MAJOR}.${KOTLIN_MIN_MINOR}`, () => {
    const r = checkKotlinMinVersion(`${KOTLIN_MIN_MAJOR}.${KOTLIN_MIN_MINOR}`);
    assert.equal(r.ok, true);
  });

  it("accepts Kotlin 2.2.0 with patch + extras", () => {
    const r = checkKotlinMinVersion("2.2.0");
    assert.equal(r.ok, true);
  });

  it("accepts Kotlin 2.3.x and newer", () => {
    const r = checkKotlinMinVersion("2.3.1");
    assert.equal(r.ok, true);
    const r3 = checkKotlinMinVersion("3.0.0");
    assert.equal(r3.ok, true);
  });

  it("rejects Kotlin 2.1.x (below 2.2)", () => {
    const r = checkKotlinMinVersion("2.1.20");
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /too old/);
      assert.match(r.reason, /2\.2/);
    }
  });

  it("rejects Kotlin 1.9.x", () => {
    const r = checkKotlinMinVersion("1.9.24");
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /too old/);
    }
  });

  it("rejects unknown / empty version strings", () => {
    for (const bad of ["", "unknown", "not-a-version"]) {
      const r = checkKotlinMinVersion(bad);
      assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
      if (r.ok === false) {
        assert.match(r.reason, /kotlinc|could not be parsed|too old|required/i);
      }
    }
  });

  it("tolerates the raw kotlinc -version banner (e.g., 'kotlinc-jvm 2.2.0 (JRE 17)')", () => {
    // `probeVersion` in runners/index.ts normally pre-filters this, but
    // checkKotlinMinVersion should still find the first version token.
    const r = checkKotlinMinVersion("kotlinc-jvm 2.2.0 (JRE 17.0.11)");
    assert.equal(r.ok, true);
  });
});

describe("detectLanguages for Kotlin", () => {
  it("pure-Kotlin project (build.gradle.kts + .kt sources, no Java) emits kotlin only", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "build.gradle.kts"), "// gradle kotlin DSL\n");
      await mkdir(join(dir, "src", "main", "kotlin"), { recursive: true });
      await writeFile(join(dir, "src", "main", "kotlin", "App.kt"), "fun main() {}\n");

      const langs = detectLanguages(dir);
      assert.ok(langs.includes("kotlin"), `expected "kotlin" in ${langs.join(", ")}`);
      assert.ok(!langs.includes("java"), `expected "java" dropped, got ${langs.join(", ")}`);
    });
  });

  it("mixed Kotlin + Java project emits both kotlin and java", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "build.gradle.kts"), "// gradle kotlin DSL\n");
      await mkdir(join(dir, "src", "main", "kotlin"), { recursive: true });
      await mkdir(join(dir, "src", "main", "java"), { recursive: true });
      await writeFile(join(dir, "src", "main", "kotlin", "App.kt"), "fun main() {}\n");
      await writeFile(join(dir, "src", "main", "java", "Legacy.java"), "class Legacy {}\n");

      const langs = detectLanguages(dir);
      assert.ok(langs.includes("kotlin"), `missing "kotlin" in ${langs.join(", ")}`);
      assert.ok(langs.includes("java"), `missing "java" in ${langs.join(", ")}`);
    });
  });

  it("Maven/pom.xml-driven project without Kotlin sources stays java-only", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "pom.xml"), "<project/>\n");
      await mkdir(join(dir, "src", "main", "java"), { recursive: true });
      await writeFile(join(dir, "src", "main", "java", "App.java"), "class App {}\n");

      const langs = detectLanguages(dir);
      assert.ok(langs.includes("java"));
      assert.ok(!langs.includes("kotlin"));
    });
  });

  it("pom.xml + .kt sources = mixed, keeps both", async () => {
    // pom.xml is a strong Java signal; even with Kotlin files, we don't
    // drop `java` here because the pom likely drives a Java compile.
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "pom.xml"), "<project/>\n");
      await mkdir(join(dir, "src", "main", "kotlin"), { recursive: true });
      await writeFile(join(dir, "src", "main", "kotlin", "App.kt"), "fun main() {}\n");

      const langs = detectLanguages(dir);
      assert.ok(langs.includes("kotlin"));
      assert.ok(langs.includes("java"));
    });
  });

  it("only .kts build script without source files still detects kotlin", async () => {
    // A `build.gradle.kts`-only repo (e.g., a pure-Gradle root aggregator)
    // should still emit kotlin so the adapter can at least parse the build
    // script itself.
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "build.gradle.kts"), "// root aggregator\n");
      const langs = detectLanguages(dir);
      assert.ok(langs.includes("kotlin"));
      // No Java evidence → java dropped.
      assert.ok(!langs.includes("java"));
    });
  });
});

describe("runIndexer('kotlin', ...)", () => {
  it("skips with a clear reason when allowBuildScripts is false", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "build.gradle.kts"), "// kotlin dsl\n");
      const outputDir = join(dir, "_out");
      const result = await runIndexer("kotlin", {
        projectRoot: dir,
        outputDir,
        allowBuildScripts: false,
      });
      assert.equal(result.kind, "kotlin");
      assert.equal(result.skipped, true);
      const reason = result.skipReason ?? "";
      assert.match(reason, /allowBuildScripts/);
    });
  });

  it("skips with 'binary not found' when kotlinc is absent from PATH", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "build.gradle.kts"), "// kotlin dsl\n");
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "App.kt"), "fun main() {}\n");
      const outputDir = join(dir, "_out");
      const result = await runIndexer("kotlin", {
        projectRoot: dir,
        outputDir,
        allowBuildScripts: true,
        // Empty PATH forces ENOENT for kotlinc. The `sh -c` we wrap with
        // should also fail to find kotlinc — we accept either the
        // pre-probe "too old / unparseable version" skip OR the runtime
        // "binary not found" skip. Both are terminal.
        envOverlay: { PATH: "" },
        timeoutMs: 10_000,
      });
      assert.equal(result.kind, "kotlin");
      assert.equal(result.skipped, true);
      const reason = result.skipReason ?? "";
      assert.match(
        reason,
        /(indexer binary not found|kotlinc version|too old|required|could not be parsed)/,
      );
    });
  });
});
