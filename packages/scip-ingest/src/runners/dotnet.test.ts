/**
 * Unit tests for the scip-dotnet adapter.
 *
 * scip-dotnet is NOT a self-contained binary — it is distributed via
 * `dotnet tool install --global scip-dotnet` and requires .NET SDK 8.0+
 * on PATH. We therefore probe `dotnet --version` before building the
 * command. The probe is dependency-injected so this test file never
 * needs a real `dotnet` on the runner.
 *
 * Covered paths:
 *   1. normal — probe returns "8.0.404" → buildCommand emits the correct
 *      `scip-dotnet index <path> -o <output>` plan.
 *   2. SDK-old — probe returns "6.0.200" → runIndexer short-circuits with
 *      a skip pointing at `codehub setup --scip=dotnet`.
 *   3. dotnet-missing — probe returns undefined → runIndexer short-circuits
 *      with the "dotnet is not on PATH" variant of the skip message.
 *   4. detectLanguages — `.csproj` at the root adds `"dotnet"` to the
 *      candidate list.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCommand,
  type DotnetProbe,
  detectLanguages,
  runIndexer,
  SCIP_DOTNET_MIN_SDK_MAJOR,
} from "./index.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "scip-dotnet-test-"));
}

test("buildCommand: dotnet emits `scip-dotnet index <cwd> -o <scipPath>`", () => {
  const plan = buildCommand(
    "dotnet",
    { projectRoot: "/tmp/my-dotnet-repo", outputDir: "/tmp/out" },
    "/tmp/out/dotnet.scip",
  );
  assert.equal(plan.cmd, "scip-dotnet");
  assert.equal(plan.tool, "scip-dotnet");
  assert.deepEqual(plan.args, ["index", "/tmp/my-dotnet-repo", "-o", "/tmp/out/dotnet.scip"]);
  assert.equal(plan.versionCmd, "scip-dotnet");
  assert.deepEqual(plan.versionArgs, ["--version"]);
  assert.equal(plan.skipReason, undefined, "normal dotnet plan must not carry a skipReason");
});

test("runIndexer: dotnet-missing path skips with install hint", async () => {
  const dir = makeTempDir();
  try {
    const probe: DotnetProbe = async () => undefined;
    const result = await runIndexer("dotnet", {
      projectRoot: dir,
      outputDir: join(dir, "out"),
      dotnetProbe: probe,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.tool, "scip-dotnet");
    assert.equal(result.version, "");
    assert.ok(result.skipReason !== undefined, "skipReason must be set");
    assert.match(result.skipReason, /scip-dotnet requires \.NET SDK 8\.0\+/);
    assert.match(
      result.skipReason,
      /dotnet is not on PATH/,
      "message should call out the missing-PATH case explicitly",
    );
    assert.match(
      result.skipReason,
      /codehub setup --scip=dotnet/,
      "message should point at the documented install entry point",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runIndexer: dotnet-old path skips with upgrade hint", async () => {
  const dir = makeTempDir();
  try {
    const probe: DotnetProbe = async () => "6.0.200";
    const result = await runIndexer("dotnet", {
      projectRoot: dir,
      outputDir: join(dir, "out"),
      dotnetProbe: probe,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.tool, "scip-dotnet");
    assert.ok(result.skipReason !== undefined);
    assert.match(result.skipReason, /scip-dotnet requires \.NET SDK 8\.0\+/);
    assert.match(
      result.skipReason,
      /detected dotnet --version: 6\.0\.200/,
      "message should surface the detected SDK version",
    );
    assert.match(result.skipReason, /codehub setup --scip=dotnet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runIndexer: dotnet preflight accepts SDK ≥ minimum", async () => {
  // The probe returns a conforming version, so runIndexer proceeds to
  // spawn `scip-dotnet` — which is not on the test runner's PATH. That
  // gives us the `missing` branch, which we assert differs from the
  // preflight-skip branch (tool === "scip-dotnet", version === "", but
  // skipReason is the "indexer binary not found" message, not the SDK
  // install hint).
  const dir = makeTempDir();
  try {
    const probe: DotnetProbe = async () => `${SCIP_DOTNET_MIN_SDK_MAJOR}.0.404`;
    const result = await runIndexer("dotnet", {
      projectRoot: dir,
      outputDir: join(dir, "out"),
      dotnetProbe: probe,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.tool, "scip-dotnet");
    assert.ok(result.skipReason !== undefined);
    assert.match(
      result.skipReason,
      /indexer binary not found: scip-dotnet/,
      "preflight must pass and the missing-binary skip must fire instead",
    );
    assert.doesNotMatch(
      result.skipReason,
      /\.NET SDK/,
      "preflight skip must NOT fire when the probed major meets the minimum",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runIndexer: dotnet preflight accepts a future SDK major", async () => {
  const dir = makeTempDir();
  try {
    const probe: DotnetProbe = async () => "9.0.100";
    const result = await runIndexer("dotnet", {
      projectRoot: dir,
      outputDir: join(dir, "out"),
      dotnetProbe: probe,
    });
    assert.equal(result.skipped, true);
    assert.doesNotMatch(
      result.skipReason ?? "",
      /\.NET SDK/,
      "SDK 9 must clear the preflight (≥ 8.0)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectLanguages: .csproj at root adds dotnet candidate", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "MyLib.csproj"), "<Project />", "utf8");
    const langs = detectLanguages(dir);
    assert.ok(langs.includes("dotnet"), `expected dotnet candidate, got ${JSON.stringify(langs)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectLanguages: .sln at root adds dotnet candidate", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "MySolution.sln"), "Microsoft Visual Studio Solution File\n", "utf8");
    const langs = detectLanguages(dir);
    assert.ok(langs.includes("dotnet"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectLanguages: .vbproj at root adds dotnet candidate", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "Legacy.vbproj"), "<Project />", "utf8");
    const langs = detectLanguages(dir);
    assert.ok(langs.includes("dotnet"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectLanguages: loose .cs file at root adds dotnet candidate", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, "Program.cs"), "class Program {}", "utf8");
    const langs = detectLanguages(dir);
    assert.ok(langs.includes("dotnet"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectLanguages: empty project emits no dotnet candidate", () => {
  const dir = makeTempDir();
  try {
    const langs = detectLanguages(dir);
    assert.ok(!langs.includes("dotnet"), `unexpected dotnet candidate in ${JSON.stringify(langs)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
