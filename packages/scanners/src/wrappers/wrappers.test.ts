/**
 * Wrapper tests exercise dependency-injected `which` + `runBinary` so we
 * never touch the real filesystem. Each test builds a fake SARIF on
 * stdout and asserts the wrapper parsed it, OR forces `which` to say the
 * binary is missing and asserts the wrapper emits an empty-SARIF
 * `skipped` result.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SarifLog } from "@opencodehub/sarif";
import type { RunBinaryResult } from "../exec.js";
import type { ScannerRunContext } from "../spec.js";
import { createBanditWrapper } from "./bandit.js";
import { createBetterleaksWrapper } from "./betterleaks.js";
import { createBiomeWrapper } from "./biome.js";
import { createOsvScannerWrapper } from "./osv-scanner.js";
import { createSemgrepWrapper } from "./semgrep.js";
import type { WrapperDeps } from "./shared.js";

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
                  artifactLocation: { uri: "src/foo.ts" },
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

const ctx: ScannerRunContext = {
  projectPath: "/tmp/fake-repo",
  timeoutMs: 10_000,
};

test("semgrep wrapper parses SARIF from stdout", async () => {
  const sarif = fakeSarif("semgrep", "semgrep.xss");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif), exitCode: 0 }));
  const wrapper = createSemgrepWrapper(deps);
  const out = await wrapper.run(ctx);
  assert.equal(out.sarif.runs.length, 1);
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "semgrep");
  assert.equal(out.sarif.runs[0]?.results?.[0]?.ruleId, "semgrep.xss");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cmd, "semgrep");
  assert.ok(calls[0]?.args.includes("--sarif"));
  assert.ok(calls[0]?.args.includes("--config=p/owasp-top-ten"));
});

test("semgrep wrapper returns empty SARIF + skipped when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["semgrep"] });
  const wrapper = createSemgrepWrapper(deps);
  const out = await wrapper.run(ctx);
  assert.equal(out.sarif.runs.length, 1);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

test("betterleaks wrapper passes --report-path=- (avoids /dev/stdout ENXIO bug)", async () => {
  const sarif = fakeSarif("betterleaks", "aws-access-token");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const wrapper = createBetterleaksWrapper(deps);
  await wrapper.run(ctx);
  assert.equal(calls[0]?.cmd, "betterleaks");
  assert.ok(calls[0]?.args.includes("--report-format=sarif"));
  assert.ok(
    calls[0]?.args.includes("--report-path=-"),
    "must use '-' for stdout — '/dev/stdout' fails ENXIO inside execFile",
  );
  assert.ok(calls[0]?.args.includes("--no-banner"));
});

test("betterleaks wrapper uses `dir` mode and injects vendored config", async () => {
  const sarif = fakeSarif("betterleaks", "aws-access-token");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const wrapper = createBetterleaksWrapper(deps);
  // ctx.projectPath = "/tmp/fake-repo" (no user betterleaks.toml). Wrapper
  // uses `dir` mode so the scan reflects working-tree state, not git
  // history.
  await wrapper.run(ctx);
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "dir", "wrapper always uses `dir` subcommand");
  // Vendored config should be injected when no user config is present.
  const cfgArg = [...args].find((a) => a.startsWith("--config="));
  assert.ok(cfgArg, "vendored default config must be injected when project has none");
  assert.match(cfgArg ?? "", /betterleaks\.default\.toml$/);
});

test("osv-scanner wrapper invokes `scan source` with --format=sarif (online default)", async () => {
  const sarif = fakeSarif("osv-scanner", "GHSA-xyz");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const wrapper = createOsvScannerWrapper(deps);
  const out = await wrapper.run(ctx);
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "osv-scanner");
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "scan");
  assert.equal(args[1], "source");
  assert.ok(args.includes("--format=sarif"));
  assert.ok(args.includes("--recursive"));
  // Offline-by-default removed: it required a pre-synced DB and otherwise
  // produced a confusing exit-127 "ran but errored" signal on fresh repos.
  assert.ok(!args.includes("--offline-vulnerabilities"), "must not force offline mode by default");
});

test("osv-scanner wrapper does NOT warn on exit 1 (vulnerabilities found)", async () => {
  const sarif = fakeSarif("osv-scanner", "GHSA-xyz");
  const warnings: string[] = [];
  const { deps } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif), exitCode: 1 }));
  const wrapper = createOsvScannerWrapper(deps);
  await wrapper.run({ ...ctx, onWarn: (m) => warnings.push(m) });
  // Exit 1 = packages found + vulns present. That's the scan working as
  // intended, not a failure — no advisory should fire.
  assert.equal(warnings.length, 0, `expected no warnings on exit 1, got: ${warnings.join(" | ")}`);
});

test("osv-scanner wrapper warns on exit 127 (general error) with an offline-DB hint", async () => {
  const warnings: string[] = [];
  const { deps } = makeFakeDeps(() => ({
    stdout: "",
    stderr: "failed to load offline database",
    exitCode: 127,
  }));
  const wrapper = createOsvScannerWrapper(deps);
  await wrapper.run({ ...ctx, onWarn: (m) => warnings.push(m) });
  // stdout was empty → parseSarifOrEmpty warns, plus the exit-127 advisory.
  const combined = warnings.join(" | ");
  assert.ok(
    combined.includes("general error"),
    `expected general-error advisory, got: ${combined}`,
  );
  assert.ok(combined.includes("db-sync"), "exit-127 advisory should hint at codehub db-sync");
});

test("osv-scanner wrapper reports exit 128 as 'no packages discovered'", async () => {
  const warnings: string[] = [];
  const sarif = fakeSarif("osv-scanner", "GHSA-xyz");
  const { deps } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif), exitCode: 128 }));
  const wrapper = createOsvScannerWrapper(deps);
  await wrapper.run({ ...ctx, onWarn: (m) => warnings.push(m) });
  assert.ok(
    warnings.some((w) => w.includes("no packages discovered")),
    `expected a 'no packages discovered' note, got: ${warnings.join(" | ")}`,
  );
});

test("bandit wrapper passes -f sarif and recurses via -r <projectPath>", async () => {
  const sarif = fakeSarif("bandit", "B101");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const wrapper = createBanditWrapper(deps);
  await wrapper.run(ctx);
  assert.equal(calls[0]?.cmd, "bandit");
  // argv should be: -r, <projectPath>, -f, sarif, --quiet
  assert.deepEqual([...(calls[0]?.args ?? [])], ["-r", ctx.projectPath, "-f", "sarif", "--quiet"]);
});

test("bandit wrapper emits a SARIF-formatter advisory on exit 2 + usage banner", async () => {
  const warnings: string[] = [];
  const { deps } = makeFakeDeps(() => ({
    stdout: "",
    stderr:
      "usage: bandit [-h] [-r] [-a {file,vuln}] [-n CONTEXT_LINES] ...\nbandit: error: argument -f/--format: invalid choice: 'sarif'",
    exitCode: 2,
  }));
  const wrapper = createBanditWrapper(deps);
  const out = await wrapper.run({ ...ctx, onWarn: (m) => warnings.push(m) });
  const combined = warnings.join(" | ");
  assert.ok(combined.includes("SARIF formatter is not"), `got: ${combined}`);
  assert.ok(combined.includes("bandit[sarif]"), "advisory should point at the bandit[sarif] extra");
  // No misleading "stdout was not valid JSON" note on this path.
  assert.ok(!combined.includes("not valid JSON"), "should suppress the generic JSON note");
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
});

test("bandit wrapper does NOT warn on exit 1 (issues found)", async () => {
  const sarif = fakeSarif("bandit", "B101");
  const warnings: string[] = [];
  const { deps } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif), exitCode: 1 }));
  const wrapper = createBanditWrapper(deps);
  const out = await wrapper.run({ ...ctx, onWarn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 0, `expected no warnings on exit 1, got: ${warnings.join(" | ")}`);
  assert.equal(out.sarif.runs[0]?.results?.[0]?.ruleId, "B101");
});

test("biome wrapper prefers global binary when available", async () => {
  const sarif = fakeSarif("biome", "suspicious/noExplicitAny");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const wrapper = createBiomeWrapper(deps);
  const out = await wrapper.run(ctx);
  assert.equal(out.sarif.runs[0]?.tool.driver.name, "biome");
  assert.equal(calls[0]?.cmd, "biome");
  assert.ok(calls[0]?.args.includes("--reporter=sarif"));
});

test("biome wrapper falls back to `pnpm exec biome` when global is missing", async () => {
  const sarif = fakeSarif("biome", "lint/noUnusedVariables");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }), {
    missing: ["biome"],
  });
  const wrapper = createBiomeWrapper(deps);
  await wrapper.run(ctx);
  assert.equal(calls[0]?.cmd, "pnpm");
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "exec");
  assert.equal(args[1], "biome");
  assert.ok(args.includes("--reporter=sarif"));
});

test("biome wrapper emits empty SARIF when neither biome nor pnpm present", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["biome", "pnpm"] });
  const wrapper = createBiomeWrapper(deps);
  const out = await wrapper.run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("neither 'biome' nor 'pnpm'"));
});

test("wrappers emit empty SARIF when stdout is malformed", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "not json at all", exitCode: 1 }));
  const wrapper = createSemgrepWrapper(deps);
  const out = await wrapper.run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
});
