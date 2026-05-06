/**
 * Tests for the JVM subprocess wrapper. We CANNOT assume a real JVM is on
 * PATH in CI, so these tests exercise the error-handling boundaries:
 *
 *   - JarMissingError fires before any spawn when the JAR path is absent.
 *   - recordToElement() round-trips wrapper output into CobolDeepElement
 *     and silently drops "diagnostic" entries.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JarMissingError, type JvmRecord, recordToElement, runBatch } from "./subprocess.js";

test("runBatch: empty path list returns an ok outcome with no records", async () => {
  const res = await runBatch([], {
    jarPath: "/does/not/exist.jar",
    wrapperClassPath: "/does/not/exist",
  });
  assert.equal(res.kind, "ok");
  assert.deepEqual(res.kind === "ok" ? [...res.records] : null, []);
});

test("runBatch: throws JarMissingError when the JAR path is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobol-proleap-"));
  await assert.rejects(
    runBatch(["/any.cbl"], {
      jarPath: join(dir, "does-not-exist.jar"),
      wrapperClassPath: dir,
    }),
    (err: unknown) => err instanceof JarMissingError,
  );
});

test("recordToElement: maps a program-id record to a CobolDeepElement", () => {
  const rec: JvmRecord = {
    kind: "program-id",
    name: "HELLO",
    filePath: "/tmp/hello.cbl",
    startLine: 3,
    endLine: 3,
  };
  const el = recordToElement(rec);
  assert.ok(el !== undefined);
  assert.equal(el.kind, "program-id");
  assert.equal(el.name, "HELLO");
  assert.equal(el.language, "cobol");
  assert.equal(el.confidence, "parse");
});

test("recordToElement: drops diagnostic records", () => {
  const rec: JvmRecord = {
    kind: "diagnostic",
    filePath: "/tmp/bad.cbl",
    message: "NullPointerException: ...",
  };
  assert.equal(recordToElement(rec), undefined);
});
