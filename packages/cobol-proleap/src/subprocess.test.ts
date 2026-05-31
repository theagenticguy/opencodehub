/**
 * Tests for the JVM subprocess wrapper. We CANNOT assume a real JVM is on
 * PATH in CI, so these tests exercise the error-handling boundaries:
 *
 *   - JarMissingError fires before any spawn when the JAR path is absent.
 *   - recordToElement() round-trips wrapper output into CobolDeepElement
 *     and silently drops "diagnostic" entries.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  JarMissingError,
  type JvmRecord,
  parseRecords,
  recordToElement,
  runBatch,
  superviseProcess,
} from "./subprocess.js";

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

test("parseRecords: accepts a well-formed symbol record", () => {
  const out = parseRecords(
    '{"kind":"program-id","name":"HELLO","filePath":"a.cbl","startLine":1,"endLine":1}\n',
  );
  assert.equal(out.length, 1);
  assert.equal(out.malformed, 0);
});

test("parseRecords: rejects a symbol record missing name/startLine/endLine as malformed", () => {
  // A truncated wrapper line that carries only kind+filePath used to pass
  // validation and leak undefined name/startLine/endLine into the graph.
  const out = parseRecords('{"kind":"program-id","filePath":"a.cbl"}\n');
  assert.equal(out.length, 0);
  assert.equal(out.malformed, 1);
});

test("parseRecords: rejects a symbol record with a non-numeric startLine", () => {
  const out = parseRecords(
    '{"kind":"paragraph","name":"P1","filePath":"a.cbl","startLine":"3","endLine":5}\n',
  );
  assert.equal(out.length, 0);
  assert.equal(out.malformed, 1);
});

test("parseRecords: accepts a diagnostic record with a message", () => {
  const out = parseRecords('{"kind":"diagnostic","filePath":"a.cbl","message":"NPE"}\n');
  assert.equal(out.length, 1);
  assert.equal(out.malformed, 0);
});

test("parseRecords: rejects a diagnostic record missing its message", () => {
  const out = parseRecords('{"kind":"diagnostic","filePath":"a.cbl"}\n');
  assert.equal(out.length, 0);
  assert.equal(out.malformed, 1);
});

test("parseRecords: rejects an unknown kind as malformed", () => {
  const out = parseRecords(
    '{"kind":"section","name":"S1","filePath":"a.cbl","startLine":1,"endLine":2}\n',
  );
  assert.equal(out.length, 0);
  assert.equal(out.malformed, 1);
});

test("superviseProcess: escalates to SIGKILL and settles when the child ignores SIGTERM", async () => {
  // A stand-in process that installs a SIGTERM handler and then spins
  // forever, modelling a JVM wedged in native code. Without the SIGKILL
  // escalation the supervising Promise would never resolve.
  const dir = mkdtempSync(join(tmpdir(), "cobol-proleap-kill-"));
  const script = join(dir, "ignore-sigterm.mjs");
  // The child installs a no-op SIGTERM handler, then spins forever. The
  // handler must be armed before the supervisor's SIGTERM lands or the child
  // dies on SIGTERM's default action and the escalation path never runs — the
  // generous timeoutMs below buys that boot margin.
  writeFileSync(
    script,
    ["process.on('SIGTERM', () => {});", "setInterval(() => {}, 1000);"].join("\n"),
    "utf8",
  );

  // timeoutMs is generous so a heavily-loaded CI box arms the child's SIGTERM
  // handler well before the supervisor's SIGTERM lands; the child ignores
  // SIGTERM regardless, so the longer timeout only delays — never skips — the
  // deterministic SIGKILL escalation. (A tight 150ms timeout flaked under the
  // full parallel suite: SIGTERM arrived mid-boot, before the handler, and the
  // child died on SIGTERM's default action instead of escalating.)
  const started = Date.now();
  const outcome = await superviseProcess(process.execPath, [script], [], {
    timeoutMs: 2_000,
    killGraceMs: 500,
  });
  const elapsed = Date.now() - started;

  assert.equal(outcome.kind, "crashed");
  assert.match(
    outcome.kind === "crashed" ? outcome.reason : "",
    /timed out .* ignored SIGTERM \(SIGKILL sent\)/,
  );
  // Resolved via the kill escalation, not by hanging forever.
  assert.ok(elapsed < 10_000, `expected resolution well under the grace ceiling, got ${elapsed}ms`);
});

test("superviseProcess: a child that exits 0 with clean NDJSON yields an ok outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobol-proleap-ok-"));
  const script = join(dir, "emit-ndjson.mjs");
  writeFileSync(
    script,
    'process.stdout.write(\'{"kind":"program-id","name":"OK","filePath":"x.cbl","startLine":1,"endLine":1}\\n\');',
    "utf8",
  );

  const outcome = await superviseProcess(process.execPath, [script], [], {
    timeoutMs: 5_000,
    killGraceMs: 1_000,
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.kind === "ok" ? outcome.records.length : -1, 1);
});
