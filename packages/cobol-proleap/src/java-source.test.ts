/**
 * Sanity checks for the committed Java wrapper source. The `.java` file is
 * the only Java artifact we ship in git — the compiled `.class` is produced
 * at `codehub setup --cobol-proleap` time. We verify that:
 *
 *  1. The source file exists at the canonical path the setup command
 *     reads from.
 *  2. The class name and main-method signature match what the subprocess
 *     invokes (`java -cp <cp> cobol_to_scip`).
 *  3. The reference to the runner class is the one ProLeap v4 actually
 *     exposes (`CobolParserRunnerImpl.analyzeFile`).
 *
 * A compile-time verification lives in README — any CI host can run
 * `javac packages/cobol-proleap/java/cobol_to_scip.java` with no classpath
 * and the pure-stdlib source compiles (reflection removes the ProLeap
 * compile-time dependency).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiled layout: packages/cobol-proleap/dist/java-source.test.js.
// Walk up two levels to reach the package root, then into java/.
// (src/java-source.test.ts → dist/java-source.test.js, so the test runtime
// sees a dist/ sibling to java/.)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const javaSourcePath = resolve(packageRoot, "java", "cobol_to_scip.java");

test("java wrapper: cobol_to_scip.java is committed at the canonical path", () => {
  // Readable → exists; a throw here means the setup command would fail.
  const body = readFileSync(javaSourcePath, "utf8");
  assert.ok(body.length > 0, "java source is empty");
});

test("java wrapper: declares `public class cobol_to_scip` with `main(String[])`", () => {
  const body = readFileSync(javaSourcePath, "utf8");
  assert.match(body, /public class cobol_to_scip\b/);
  assert.match(body, /public static void main\(String\[\] args\)/);
});

test("java wrapper: references CobolParserRunnerImpl.analyzeFile from ProLeap v4", () => {
  const body = readFileSync(javaSourcePath, "utf8");
  // The runner FQN is the contract anchor between our wrapper and the
  // ProLeap JAR. A rename here would break every installed wrapper, so we
  // lock it in a test.
  assert.match(body, /io\.proleap\.cobol\.asg\.runner\.impl\.CobolParserRunnerImpl/);
  assert.match(body, /analyzeFile/);
});

test("java wrapper: references the CobolSourceFormatEnum FIXED format", () => {
  const body = readFileSync(javaSourcePath, "utf8");
  assert.match(body, /CobolSourceFormatEnum/);
  assert.match(body, /"FIXED"/);
});
