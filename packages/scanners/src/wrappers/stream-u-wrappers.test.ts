/**
 * Tests for Stream U scanner wrappers (ruff, grype, checkov-docker-compose,
 * vulture, radon, ty, clamav).
 *
 * All tests use dependency-injected `which` / `runBinary` — no real binary
 * is spawned, no network or filesystem is touched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type SarifLog, SarifLogSchema } from "@opencodehub/sarif";
import type { RunBinaryResult } from "../exec.js";
import type { ScannerRunContext } from "../spec.js";
import { createClamAvWrapper } from "./clamav.js";
import {
  createCheckovDockerComposeWrapper,
  __testing as dockerComposeTesting,
} from "./docker-compose.js";
import { createGrypeWrapper } from "./grype.js";
import { createRadonWrapper } from "./radon.js";
import { createRuffWrapper } from "./ruff.js";
import type { WrapperDeps } from "./shared.js";
import { createTyWrapper } from "./ty.js";
import { createVultureWrapper } from "./vulture.js";

function makeFakeDeps(
  handler: (
    cmd: string,
    args: readonly string[],
  ) => { stdout: string; stderr?: string; exitCode?: number },
  opts: { readonly missing?: readonly string[] } = {},
): {
  deps: WrapperDeps;
  calls: Array<{ cmd: string; args: readonly string[] }>;
} {
  const missing = new Set(opts.missing ?? []);
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const deps: WrapperDeps = {
    which: async (binary: string) => ({ found: !missing.has(binary) }),
    runBinary: async (cmd, args): Promise<RunBinaryResult> => {
      calls.push({ cmd, args });
      const out = handler(cmd, args);
      return {
        stdout: out.stdout,
        stderr: out.stderr ?? "",
        exitCode: out.exitCode ?? 0,
      };
    },
  };
  return { deps, calls };
}

function fakeSarif(toolName: string, ruleId: string): SarifLog {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: toolName, version: "1.0.0" } },
        results: [
          {
            ruleId,
            level: "warning",
            message: { text: `test finding from ${toolName}` },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/foo.py" },
                  region: { startLine: 10 },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function assertValidSarif(log: unknown): void {
  const result = SarifLogSchema.safeParse(log);
  assert.ok(result.success, `expected valid SARIF: ${result.success ? "" : result.error.message}`);
}

const ctx: ScannerRunContext = {
  projectPath: "/tmp/fake-repo",
  timeoutMs: 10_000,
};

// ---------- ruff ----------------------------------------------------------

test("ruff wrapper invokes `ruff check --output-format sarif` on stdout", async () => {
  const sarif = fakeSarif("ruff", "F401");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const out = await createRuffWrapper(deps).run(ctx);
  assertValidSarif(out.sarif);
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "ruff");
  assert.equal(out.sarif.runs[0]?.results?.[0]?.ruleId, "F401");
  assert.equal(calls[0]?.cmd, "ruff");
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "check");
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("sarif"));
  assert.ok(args.includes("--no-cache"));
});

test("ruff wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["ruff"] });
  const out = await createRuffWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

// ---------- grype ---------------------------------------------------------

test("grype wrapper invokes `grype dir:<path> -o sarif -q`", async () => {
  const sarif = fakeSarif("grype", "CVE-2024-1");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const out = await createGrypeWrapper(deps).run(ctx);
  assertValidSarif(out.sarif);
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "grype");
  assert.equal(calls[0]?.cmd, "grype");
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], `dir:${ctx.projectPath}`);
  assert.ok(args.includes("-o"));
  assert.ok(args.includes("sarif"));
  assert.ok(args.includes("-q"));
});

test("grype wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["grype"] });
  const out = await createGrypeWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

// ---------- checkov-docker-compose ---------------------------------------

test("checkov-docker-compose wrapper rewrites tool driver name", async () => {
  const sarif = fakeSarif("checkov", "CKV_DOCKER_3");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const out = await createCheckovDockerComposeWrapper(deps, {
    composeFiles: ["docker-compose.yml"],
  }).run(ctx);
  assertValidSarif(out.sarif);
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "checkov-docker-compose");
  const automationDetails = (
    out.sarif.runs[0] as unknown as { automationDetails?: { id?: string } }
  ).automationDetails;
  assert.equal(automationDetails?.id, "docker-compose");
  assert.equal(out.sarif.runs[0]?.results?.[0]?.ruleId, "CKV_DOCKER_3");
  assert.equal(calls[0]?.cmd, "checkov");
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "-f");
  assert.equal(args[1], "docker-compose.yml");
  assert.ok(args.includes("--framework"));
  assert.ok(args.includes("yaml"));
  assert.ok(args.includes("secrets"));
  assert.ok(args.includes("--soft-fail"));
});

test("checkov-docker-compose wrapper short-circuits when no files", async () => {
  const { deps, calls } = makeFakeDeps(() => ({ stdout: "" }));
  const out = await createCheckovDockerComposeWrapper(deps, { composeFiles: [] }).run(ctx);
  assert.equal(calls.length, 0, "no child process spawned");
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("no docker-compose files"));
});

test("checkov-docker-compose wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["checkov"] });
  const out = await createCheckovDockerComposeWrapper(deps, {
    composeFiles: ["docker-compose.yml"],
  }).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

test("checkov-docker-compose rewriteToolIdentity preserves results byte-for-byte", () => {
  const sarif: SarifLog = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "checkov", version: "3.2.524" } },
        results: [
          {
            ruleId: "CKV_DOCKER_1",
            level: "warning",
            message: { text: "example" },
          },
        ],
      },
    ],
  };
  const rewritten = dockerComposeTesting.rewriteToolIdentity(sarif);
  assert.equal(rewritten.runs[0]?.tool.driver.name, "checkov-docker-compose");
  assert.equal(rewritten.runs[0]?.tool.driver.version, "3.2.524");
  assert.deepEqual(rewritten.runs[0]?.results, sarif.runs[0]?.results);
});

// ---------- vulture -------------------------------------------------------

test("vulture wrapper parses stdout into SARIF results", async () => {
  const stdout = [
    "src/app.py:42: unused variable 'foo' (80% confidence)",
    "src/app.py:10: unused function 'bar' (90% confidence)",
  ].join("\n");
  const { deps, calls } = makeFakeDeps(() => ({ stdout, exitCode: 1 }));
  const out = await createVultureWrapper(deps).run(ctx);
  assertValidSarif(out.sarif);
  assert.equal(calls[0]?.cmd, "vulture");
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], ctx.projectPath);
  assert.ok(args.includes("--min-confidence"));
  assert.ok(args.includes("80"));
  const results = out.sarif.runs[0]?.results ?? [];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.ruleId, "vulture.dead-code");
  assert.equal(results[0]?.level, "note");
  assert.equal(results[0]?.locations?.[0]?.physicalLocation?.region?.startLine, 42);
  const props = (results[0]?.properties as { opencodehub?: { confidence?: number } } | undefined)
    ?.opencodehub;
  assert.equal(props?.confidence, 80);
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "vulture");
});

test("vulture wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["vulture"] });
  const out = await createVultureWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

// ---------- radon ---------------------------------------------------------

test("radon wrapper parses cc JSON into SARIF results above threshold", async () => {
  const radonJson = {
    "src/app.py": [
      {
        name: "handler",
        type: "function",
        rank: "C",
        complexity: 12,
        lineno: 42,
        endline: 80,
        col_offset: 0,
      },
      {
        name: "simple",
        type: "function",
        rank: "A",
        complexity: 2,
        lineno: 5,
        endline: 10,
      },
    ],
  };
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(radonJson) }));
  const out = await createRadonWrapper(deps).run(ctx);
  assertValidSarif(out.sarif);
  assert.equal(calls[0]?.cmd, "radon");
  const args = calls[0]?.args ?? [];
  assert.deepEqual([...args], ["cc", "-s", "-j", ctx.projectPath]);
  const results = out.sarif.runs[0]?.results ?? [];
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ruleId, "radon.complexity.C");
  assert.equal(results[0]?.level, "warning");
  assert.equal(results[0]?.locations?.[0]?.physicalLocation?.artifactLocation?.uri, "src/app.py");
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "radon");
});

test("radon wrapper emits empty SARIF when stdout is garbage", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "not json", exitCode: 0 }));
  const out = await createRadonWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
});

test("radon wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["radon"] });
  const out = await createRadonWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

// ---------- ty ------------------------------------------------------------

test("ty wrapper parses mypy-style stdout into SARIF results", async () => {
  const stdout = [
    'src/app.py:42: error: Argument 1 to "f" has incompatible type [arg-type]',
    "src/app.py:10:5: warning: Missing type annotation [annotation-unchecked]",
    "src/app.py:99: note: See https://example.com [ref]",
  ].join("\n");
  const { deps, calls } = makeFakeDeps(() => ({ stdout, exitCode: 1 }));
  const out = await createTyWrapper(deps).run(ctx);
  assertValidSarif(out.sarif);
  assert.equal(calls[0]?.cmd, "ty");
  const args = calls[0]?.args ?? [];
  assert.deepEqual([...args], ["check", ctx.projectPath]);
  const results = out.sarif.runs[0]?.results ?? [];
  assert.equal(results.length, 3);
  assert.equal(results[0]?.ruleId, "ty.arg-type");
  assert.equal(results[0]?.level, "error");
  assert.equal(results[1]?.ruleId, "ty.annotation-unchecked");
  assert.equal(results[1]?.level, "warning");
  assert.equal(results[1]?.locations?.[0]?.physicalLocation?.region?.startColumn, 5);
  assert.equal(results[2]?.level, "note");
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "ty");
});

test("ty wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["ty"] });
  const out = await createTyWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

// ---------- clamav --------------------------------------------------------

test("clamav wrapper parses FOUND lines on exit 1", async () => {
  const stdout = [
    "/tmp/fake-repo/evil.bin: Win.Trojan.Agent-12345 FOUND",
    "/tmp/fake-repo/test.zip: Eicar-Test-Signature FOUND",
  ].join("\n");
  const { deps, calls } = makeFakeDeps(() => ({ stdout, exitCode: 1 }));
  const out = await createClamAvWrapper(deps).run(ctx);
  assertValidSarif(out.sarif);
  assert.equal(calls[0]?.cmd, "clamscan");
  const args = calls[0]?.args ?? [];
  assert.deepEqual([...args], ["--recursive", "--infected", "--no-summary", ctx.projectPath]);
  const results = out.sarif.runs[0]?.results ?? [];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.ruleId, "clamav.Win.Trojan.Agent-12345");
  assert.equal(results[0]?.level, "error");
  assert.equal(
    results[0]?.locations?.[0]?.physicalLocation?.artifactLocation?.uri,
    "/tmp/fake-repo/evil.bin",
  );
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "clamav");
});

test("clamav wrapper emits empty SARIF on exit 0 (clean scan)", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "", exitCode: 0 }));
  const out = await createClamAvWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.equal(out.skipped, undefined);
});

test("clamav wrapper emits empty SARIF + warn on exit 2 (scanner error)", async () => {
  const warns: string[] = [];
  const { deps } = makeFakeDeps(() => ({
    stdout: "",
    stderr: "DB load failed",
    exitCode: 2,
  }));
  const out = await createClamAvWrapper(deps).run({ ...ctx, onWarn: (m) => warns.push(m) });
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(warns.some((m) => m.includes("exit code 2")));
});

test("clamav wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["clamscan"] });
  const out = await createClamAvWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});
