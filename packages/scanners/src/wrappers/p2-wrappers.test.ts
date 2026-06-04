/**
 * Tests for the Priority-2 scanner wrappers (P2 + pip-audit + npm-audit).
 *
 * All tests use dependency-injected `which` / `runBinary` — no real
 * binary is ever spawned, and no network is touched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SarifLog } from "@opencodehub/sarif";
import type { RunBinaryResult } from "../exec.js";
import type { ScannerRunContext } from "../spec.js";
import { createCheckovWrapper } from "./checkov.js";
import { createHadolintWrapper } from "./hadolint.js";
import { createNpmAuditWrapper } from "./npm-audit.js";
import { createPipAuditWrapper } from "./pip-audit.js";
import type { WrapperDeps } from "./shared.js";
import { createSpectralWrapper } from "./spectral.js";
import { createTflintWrapper } from "./tflint.js";
import { createTrivyWrapper } from "./trivy.js";

function makeFakeDeps(
  handler: (
    cmd: string,
    args: readonly string[],
  ) => { stdout: string; stderr?: string; exitCode?: number },
  opts: {
    readonly missing?: readonly string[];
    /** Absolute paths the fake `fileExists` should report as present. */
    readonly existing?: readonly string[];
  } = {},
): {
  deps: WrapperDeps;
  calls: Array<{ cmd: string; args: readonly string[] }>;
} {
  const missing = new Set(opts.missing ?? []);
  const existing = new Set(opts.existing ?? []);
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  // The wrappers build paths with `path.join`, which emits backslashes on
  // Windows, while the fixtures + assertions in this file use POSIX `/`. The
  // tests only care about logical path identity, not the platform separator,
  // so normalize `\` → `/` at the harness boundary (both the existence matcher
  // and the recorded call args) to keep the suite OS-agnostic.
  const toPosix = (p: string): string => p.replace(/\\/g, "/");
  const deps: WrapperDeps = {
    which: async (binary: string) => ({ found: !missing.has(binary) }),
    runBinary: async (cmd, args): Promise<RunBinaryResult> => {
      calls.push({ cmd, args: args.map(toPosix) });
      const out = handler(cmd, args);
      return {
        stdout: out.stdout,
        stderr: out.stderr ?? "",
        exitCode: out.exitCode ?? 0,
      };
    },
    fileExists: async (path: string) => existing.has(toPosix(path)),
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
                  artifactLocation: { uri: "infra/foo.tf" },
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

// ---------- Trivy ---------------------------------------------------------

test("trivy wrapper invokes `trivy fs --format sarif` with severity + offline", async () => {
  const sarif = fakeSarif("trivy", "AVD-AWS-0001");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const wrapper = createTrivyWrapper(deps);
  const out = await wrapper.run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.[0]?.ruleId, "AVD-AWS-0001");
  assert.equal(calls[0]?.cmd, "trivy");
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "fs");
  assert.ok(args.includes("--format"));
  assert.ok(args.includes("sarif"));
  assert.ok(args.includes("--severity"));
  assert.ok(args.includes("HIGH,CRITICAL"));
  assert.ok(args.includes("--ignore-unfixed"));
  assert.ok(args.includes("--skip-db-update"));
  assert.ok(args.includes("--offline-scan"));
  // projectPath comes last.
  assert.equal(args[args.length - 1], ctx.projectPath);
});

test("trivy wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["trivy"] });
  const out = await createTrivyWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

// ---------- Checkov -------------------------------------------------------

test("checkov wrapper emits framework flag from iacTypes", async () => {
  const sarif = fakeSarif("checkov", "CKV_AWS_20");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const wrapper = createCheckovWrapper(deps, {
    frameworks: ["terraform", "kubernetes"],
  });
  await wrapper.run(ctx);
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "-d");
  assert.equal(args[1], ctx.projectPath);
  const idx = args.indexOf("--framework");
  assert.ok(idx >= 0, "must pass --framework");
  const frameworks = (args[idx + 1] ?? "").split(",").sort();
  assert.deepEqual(frameworks, ["kubernetes", "terraform"]);
  assert.ok(args.includes("-o"));
  assert.ok(args.includes("sarif"));
  assert.ok(args.includes("--soft-fail"));
});

test("checkov wrapper falls back to --framework all when no iacTypes", async () => {
  const { deps, calls } = makeFakeDeps(() => ({
    stdout: JSON.stringify(fakeSarif("checkov", "CKV_K8S_1")),
  }));
  await createCheckovWrapper(deps, { frameworks: [] }).run(ctx);
  const args = calls[0]?.args ?? [];
  const idx = args.indexOf("--framework");
  assert.equal(args[idx + 1], "all");
});

test("checkov wrapper maps docker-compose to dockerfile framework", async () => {
  const { deps, calls } = makeFakeDeps(() => ({
    stdout: JSON.stringify(fakeSarif("checkov", "CKV_DOCKER_1")),
  }));
  await createCheckovWrapper(deps, { frameworks: ["docker-compose"] }).run(ctx);
  const args = calls[0]?.args ?? [];
  const idx = args.indexOf("--framework");
  assert.equal(args[idx + 1], "dockerfile");
});

// ---------- Hadolint ------------------------------------------------------

test("hadolint wrapper passes --format sarif and list of Dockerfiles", async () => {
  const sarif = fakeSarif("hadolint", "DL3000");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  const wrapper = createHadolintWrapper(deps, {
    dockerfiles: ["app/Dockerfile", "svc/Dockerfile"],
  });
  await wrapper.run(ctx);
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "--format");
  assert.equal(args[1], "sarif");
  assert.ok(args.includes("--no-fail"));
  // The final positional arguments should be the Dockerfile paths after `--`.
  const dashIdx = args.indexOf("--");
  assert.ok(dashIdx > 0);
  assert.deepEqual([...args.slice(dashIdx + 1)], ["app/Dockerfile", "svc/Dockerfile"]);
});

test("hadolint wrapper defaults to 'Dockerfile' when no list provided", async () => {
  const { deps, calls } = makeFakeDeps(() => ({
    stdout: JSON.stringify(fakeSarif("hadolint", "DL3000")),
  }));
  await createHadolintWrapper(deps).run(ctx);
  const args = calls[0]?.args ?? [];
  assert.equal(args[args.length - 1], "Dockerfile");
});

test("hadolint wrapper emits empty SARIF + skipped when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["hadolint"] });
  const out = await createHadolintWrapper(deps, {
    dockerfiles: ["Dockerfile"],
  }).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

// ---------- Tflint --------------------------------------------------------

test("tflint wrapper invokes `tflint --format sarif --chdir=<path>`", async () => {
  const sarif = fakeSarif("tflint", "terraform_naming");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  await createTflintWrapper(deps).run(ctx);
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "--format");
  assert.equal(args[1], "sarif");
  assert.ok(args.includes(`--chdir=${ctx.projectPath}`));
  assert.ok(args.includes("--force"));
});

test("tflint wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["tflint"] });
  const out = await createTflintWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

// ---------- Spectral ------------------------------------------------------

test("spectral wrapper invokes `spectral lint --format sarif` with contract files", async () => {
  const sarif = fakeSarif("spectral", "openapi-tags");
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(sarif) }));
  await createSpectralWrapper(deps, {
    contractFiles: ["openapi.yaml", "swagger.yaml"],
  }).run(ctx);
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "lint");
  assert.ok(args.includes("--format"));
  assert.ok(args.includes("sarif"));
  assert.ok(args.includes("--fail-severity"));
  assert.ok(args.includes("off"));
  // Trailing file list.
  assert.equal(args[args.length - 2], "openapi.yaml");
  assert.equal(args[args.length - 1], "swagger.yaml");
});

test("spectral wrapper short-circuits when no contract files", async () => {
  const { deps, calls } = makeFakeDeps(() => ({ stdout: "" }));
  const out = await createSpectralWrapper(deps, { contractFiles: [] }).run(ctx);
  assert.equal(calls.length, 0, "no child process spawned");
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("no API contract files"));
});

// ---------- pip-audit -----------------------------------------------------

test("pip-audit wrapper runs with --format json and converts to SARIF", async () => {
  const pipJson = {
    dependencies: [
      {
        name: "requests",
        version: "2.18.0",
        vulns: [
          {
            id: "PYSEC-2021-59",
            description: "Requests is vulnerable to session fixation.",
            aliases: ["CVE-2018-18074"],
            fix_versions: ["2.20.0"],
          },
        ],
      },
    ],
  };
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify(pipJson), exitCode: 1 }), {
    existing: [`${ctx.projectPath}/requirements.txt`],
  });
  const out = await createPipAuditWrapper(deps).run(ctx);
  const args = calls[0]?.args ?? [];
  assert.equal(calls[0]?.cmd, "pip-audit");
  assert.ok(args.includes("-r"));
  assert.ok(args.includes("requirements.txt"));
  assert.ok(args.includes("--format"));
  assert.ok(args.includes("json"));
  assert.equal(out.sarif.version, "2.1.0");
  const result = out.sarif.runs[0]?.results?.[0];
  assert.equal(result?.ruleId, "PYSEC-2021-59");
  assert.equal(result?.level, "error");
  assert.equal(result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri, "requirements.txt");
  const ocProps = (result?.properties as { opencodehub?: Record<string, unknown> } | undefined)
    ?.opencodehub;
  assert.equal(ocProps?.["dependency"], "requests@2.18.0");
  assert.deepEqual(ocProps?.["aliases"], ["CVE-2018-18074"]);
  assert.deepEqual(ocProps?.["fixVersions"], ["2.20.0"]);
});

test("pip-audit wrapper honours custom requirementsPath when it exists", async () => {
  const { deps, calls } = makeFakeDeps(() => ({ stdout: JSON.stringify({ dependencies: [] }) }), {
    existing: [`${ctx.projectPath}/requirements-dev.txt`],
  });
  await createPipAuditWrapper(deps, {
    requirementsPath: "requirements-dev.txt",
  }).run(ctx);
  const args = calls[0]?.args ?? [];
  const idx = args.indexOf("-r");
  assert.equal(args[idx + 1], "requirements-dev.txt");
});

// pyproject.toml (no requirements.txt) → uv export bridge, then audit the
// export but label findings against pyproject.toml.
test("pip-audit wrapper bridges pyproject.toml via uv export", async () => {
  const pipJson = {
    dependencies: [{ name: "jinja2", version: "3.1.0", vulns: [{ id: "GHSA-h5c8-rqwp-cp95" }] }],
  };
  const { deps, calls } = makeFakeDeps(
    (cmd) => {
      // uv export writes the file (exit 0, no stdout); pip-audit returns JSON.
      if (cmd === "uv") return { stdout: "", exitCode: 0 };
      return { stdout: JSON.stringify(pipJson), exitCode: 1 };
    },
    { existing: [`${ctx.projectPath}/pyproject.toml`] },
  );
  const out = await createPipAuditWrapper(deps, { exportDir: "/tmp/fake-repo/.codehub" }).run(ctx);

  // First call exports via uv; second audits the exported file.
  assert.equal(calls[0]?.cmd, "uv");
  assert.ok(calls[0]?.args.includes("export"));
  assert.ok(calls[0]?.args.includes("--format"));
  assert.ok(calls[0]?.args.includes("requirements-txt"));
  const exportIdx = calls[0]?.args.indexOf("-o") ?? -1;
  assert.equal(
    calls[0]?.args[exportIdx + 1],
    "/tmp/fake-repo/.codehub/.pip-audit-requirements.txt",
  );

  assert.equal(calls[1]?.cmd, "pip-audit");
  const auditIdx = calls[1]?.args.indexOf("-r") ?? -1;
  assert.equal(calls[1]?.args[auditIdx + 1], "/tmp/fake-repo/.codehub/.pip-audit-requirements.txt");

  // Finding is labelled against pyproject.toml, NOT the transient export.
  const result = out.sarif.runs[0]?.results?.[0];
  assert.equal(result?.ruleId, "GHSA-h5c8-rqwp-cp95");
  assert.equal(result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri, "pyproject.toml");
});

test("pip-audit wrapper warns when pyproject.toml present but uv missing", async () => {
  const warnings: string[] = [];
  const { deps, calls } = makeFakeDeps(() => ({ stdout: "" }), {
    missing: ["uv"],
    existing: [`${ctx.projectPath}/pyproject.toml`],
  });
  const out = await createPipAuditWrapper(deps).run({ ...ctx, onWarn: (m) => warnings.push(m) });
  // pip-audit is never invoked — only the which("uv") probe runs, no runBinary.
  assert.equal(calls.length, 0);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(warnings.join(" | ").includes("uv"), `expected a uv advisory; got: ${warnings}`);
});

test("pip-audit wrapper warns when uv export fails", async () => {
  const warnings: string[] = [];
  const { deps } = makeFakeDeps(
    (cmd) => {
      if (cmd === "uv") return { stdout: "", stderr: "no lockfile", exitCode: 2 };
      return { stdout: JSON.stringify({ dependencies: [] }) };
    },
    { existing: [`${ctx.projectPath}/pyproject.toml`] },
  );
  const out = await createPipAuditWrapper(deps).run({ ...ctx, onWarn: (m) => warnings.push(m) });
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(warnings.join(" | ").includes("uv export"), `got: ${warnings}`);
});

test("pip-audit wrapper warns when neither requirements.txt nor pyproject.toml exists", async () => {
  const warnings: string[] = [];
  const { deps, calls } = makeFakeDeps(() => ({ stdout: "" }), { existing: [] });
  const out = await createPipAuditWrapper(deps).run({ ...ctx, onWarn: (m) => warnings.push(m) });
  assert.equal(calls.length, 0);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(
    warnings.join(" | ").includes("no requirements.txt or pyproject.toml"),
    `got: ${warnings}`,
  );
});

test("pip-audit wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["pip-audit"] });
  const out = await createPipAuditWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});

test("pip-audit wrapper emits empty SARIF when stdout is garbage", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "not json at all", exitCode: 2 }), {
    existing: [`${ctx.projectPath}/requirements.txt`],
  });
  const out = await createPipAuditWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
});

// ---------- npm audit -----------------------------------------------------

test("npm-audit wrapper runs `npm audit --json` and converts findings", async () => {
  const npmJson = {
    vulnerabilities: {
      lodash: {
        name: "lodash",
        severity: "high",
        range: "<4.17.21",
        via: [
          {
            source: 1094,
            name: "lodash",
            url: "https://github.com/advisories/GHSA-35jh",
            title: "Prototype Pollution in lodash",
            severity: "high",
            range: "<4.17.21",
          },
        ],
      },
    },
  };
  const { deps, calls } = makeFakeDeps(() => ({
    stdout: JSON.stringify(npmJson),
    exitCode: 1,
  }));
  const out = await createNpmAuditWrapper(deps).run(ctx);
  assert.equal(calls[0]?.cmd, "npm");
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "audit");
  assert.ok(args.includes("--json"));
  const r = out.sarif.runs[0]?.results?.[0];
  assert.equal(r?.ruleId, "npm-advisory-1094");
  assert.equal(r?.level, "error");
  assert.equal(r?.locations?.[0]?.physicalLocation?.artifactLocation?.uri, "package.json");
  const ocProps = (r?.properties as { opencodehub?: Record<string, unknown> } | undefined)
    ?.opencodehub;
  assert.equal(ocProps?.["dependency"], "lodash@<4.17.21");
  assert.equal(ocProps?.["severity"], "high");
  assert.equal(ocProps?.["advisoryUrl"], "https://github.com/advisories/GHSA-35jh");
});

test("npm-audit wrapper skips string-only via entries (transitive hops)", async () => {
  const npmJson = {
    vulnerabilities: {
      a: {
        name: "a",
        severity: "moderate",
        range: "*",
        via: ["b"], // transitive only, no advisory → no SARIF result
      },
    },
  };
  const { deps } = makeFakeDeps(() => ({ stdout: JSON.stringify(npmJson) }));
  const out = await createNpmAuditWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
});

test("npm-audit wrapper emits empty SARIF when binary missing", async () => {
  const { deps } = makeFakeDeps(() => ({ stdout: "" }), { missing: ["npm"] });
  const out = await createNpmAuditWrapper(deps).run(ctx);
  assert.equal(out.sarif.runs[0]?.results?.length, 0);
  assert.ok(out.skipped?.includes("not found on PATH"));
});
