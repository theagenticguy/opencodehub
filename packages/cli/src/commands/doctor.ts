/**
 * `codehub doctor` — environment probe.
 *
 * Runs every `Check` registered in `CHECKS`, prints a table, and exits
 * with a status code that maps to the worst result seen:
 *
 *   0  all ok
 *   1  at least one warn (non-blocking)
 *   2  at least one fail (blocking — something is broken)
 *
 * Checks are strictly diagnostic — they never auto-heal. Each one returns
 * a `hint` string the user can copy-paste when things are off.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { access, open as fsOpen, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeSarif } from "@opencodehub/sarif";
import { BANDIT_SPEC } from "@opencodehub/scanners";
import { hostedScipBinDirs } from "@opencodehub/scip-ingest";
import Table from "cli-table3";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  readonly status: CheckStatus;
  readonly message: string;
  readonly hint?: string;
}

export interface Check {
  readonly name: string;
  run(): Promise<CheckResult>;
}

export interface DoctorOptions {
  /** Override HOME so tests can point at a fake dotdir. */
  readonly home?: string;
  /** Skip checks that rely on native bindings (e.g. in CI sandboxes). */
  readonly skipNative?: boolean;
  /** Override the repo root when resolving workspace packages. */
  readonly repoRoot?: string;
  /**
   * Escalate "soft" absences to hard failures. By default a missing SCIP
   * indexer is `warn` (the analyze pipeline skips that language gracefully —
   * a Python-only box doesn't need scip-go), matching the lenient runtime
   * behavior. Under `--strict`, every absent indexer becomes `fail` (exit 2)
   * so release/CI gates can assert the full toolchain is present. Vendored
   * WASM grammars are `fail` in BOTH modes — a shipped artifact being absent
   * or corrupt is always broken, never a soft skip.
   */
  readonly strict?: boolean;
  /**
   * Injectable command runner so tests can stub external binaries (bandit,
   * pnpm, scip indexers) without depending on what is installed on the host.
   * Defaults to the real {@link runCommand}. Same signature.
   */
  readonly runCommand?: RunCommandFn;
  /**
   * Injectable loader for the `onnxruntime-node` binding probe. The real
   * loader is a dynamic `import("onnxruntime-node")` — an OPTIONAL dependency
   * that ships prebuilds for only a handful of targets, so the binding may be
   * absent on this platform. Tests inject a double to exercise both the
   * load-OK and load-failure branches without depending on the host's prebuild
   * coverage. Defaults to {@link loadOnnxBinding}.
   */
  readonly loadOnnxBinding?: () => Promise<unknown>;
}

/** Signature of the injectable command runner (see {@link runCommand}). */
export type RunCommandFn = (
  cmd: string,
  args: readonly string[],
) => Promise<{ status: number; stdout: string; stderr: string }>;

export interface DoctorReport {
  readonly rows: readonly { readonly name: string; readonly result: CheckResult }[];
  readonly exitCode: 0 | 1 | 2;
}

/**
 * Entry point invoked by `codehub doctor`. Prints the table and sets
 * `process.exitCode`. Also returns the structured report so tests and
 * acceptance scripts can assert the outcome without parsing stdout.
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks = buildChecks(opts);
  const rows: Array<{ name: string; result: CheckResult }> = [];
  for (const check of checks) {
    const result = await check.run().catch(
      (err: unknown): CheckResult => ({
        status: "fail",
        message: `check threw: ${err instanceof Error ? err.message : String(err)}`,
        hint: "report a bug against @opencodehub/cli — checks should never throw",
      }),
    );
    rows.push({ name: check.name, result });
  }
  printTable(rows);

  let exitCode: 0 | 1 | 2 = 0;
  for (const { result } of rows) {
    if (result.status === "fail") {
      exitCode = 2;
      break;
    }
    if (result.status === "warn" && exitCode === 0) {
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
  return { rows, exitCode };
}

/**
 * Ordered list of environment probes. Order matters only for the output
 * table — runs are independent, but we surface foundational checks first
 * (Node, pnpm, native bindings) so the user can fix a broken foundation
 * before worrying about downstream extras.
 */
export function buildChecks(opts: DoctorOptions = {}): readonly Check[] {
  const home = opts.home ?? homedir();
  const repoRoot = opts.repoRoot ?? guessRepoRoot();
  const strict = opts.strict === true;
  const run = opts.runCommand ?? runCommand;
  const list: Check[] = [nodeVersionCheck(), pnpmInstalledCheck(run)];
  if (opts.skipNative !== true) {
    // node:sqlite is the mandatory single-file store. It is a Node builtin, so
    // it has no resolve seam (it can't be "absent" the way a node_modules
    // package can) — the check just imports it and exercises a WAL round-trip.
    list.push(nodeSqliteCheck());
  }
  // Vendored parse grammars: a shipped artifact, so absence/corruption is
  // always a hard fail. One row covering all 16 blobs + the manifest pin.
  list.push(vendoredWasmsCheck(repoRoot));
  // SCIP indexers: one row per language. Soft `warn` by default (analyze
  // skips an absent language), `fail` under --strict.
  for (const indexer of SCIP_INDEXERS) {
    list.push(scipIndexerCheck(indexer, home, strict, run));
  }
  list.push(
    binaryOnPathCheck(
      "semgrep",
      "P1 scanner — install semgrep via `brew install semgrep` or `uv tool install semgrep`",
      run,
    ),
  );
  list.push(
    binaryOnPathCheck(
      "osv-scanner",
      "P1 scanner — install from https://github.com/google/osv-scanner",
      run,
    ),
  );
  list.push(banditSarifCheck(run));
  list.push(binaryOnPathCheck("ruff", "P1 scanner — install with `uv tool install ruff`", run));
  list.push(
    binaryOnPathCheck(
      "grype",
      "P1 scanner — install with `brew install anchore/grype/grype` or from https://github.com/anchore/grype",
      run,
    ),
  );
  list.push(
    binaryOnPathCheck("vulture", "P1 scanner — install with `uv tool install vulture`", run),
  );
  list.push(
    binaryOnPathCheck("pip-audit", "P1 scanner — install with `uv tool install pip-audit`", run),
  );
  list.push(binaryOnPathCheck("radon", "P2 scanner — install with `uv tool install radon`", run));
  list.push(
    binaryOnPathCheck("ty", "P2 scanner (beta) — install with `uv tool install ty` (Astral)", run),
  );
  list.push(embedderWeightsCheck(home));
  if (opts.skipNative !== true) {
    list.push(
      opts.loadOnnxBinding !== undefined
        ? embedderBindingCheck(opts.loadOnnxBinding)
        : embedderBindingCheck(),
    );
  }
  list.push(registryPathCheck(home));
  list.push(sarifSchemaCheck(repoRoot));
  return list;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function nodeVersionCheck(): Check {
  return {
    name: "node >= 20",
    async run() {
      const v = process.versions.node;
      const major = Number.parseInt(v.split(".")[0] ?? "0", 10);
      if (!Number.isFinite(major) || major < 20) {
        return {
          status: "fail",
          message: `node v${v} — minimum is v20.10`,
          hint: "install node 20+ with `mise use node@20` or `nvm install 20`",
        };
      }
      return { status: "ok", message: `node v${v}` };
    },
  };
}

function pnpmInstalledCheck(run: RunCommandFn): Check {
  return {
    name: "pnpm installed",
    async run() {
      const res = await run("pnpm", ["--version"]);
      if (res.status !== 0) {
        return {
          status: "fail",
          message: "pnpm not on PATH",
          hint: "install pnpm via `npm install -g pnpm` or `corepack enable`",
        };
      }
      return { status: "ok", message: `pnpm ${res.stdout.trim()}` };
    },
  };
}

/**
 * The single-file SQLite store ({@link SqliteStore}) is the mandatory storage
 * backend: there is no selector env var, no probe, and no fallback — every
 * graph/temporal operation opens one `node:sqlite` database in WAL mode. So a
 * non-importable `node:sqlite` is a hard `fail` here, exactly like a missing
 * shipped artifact (see {@link vendoredWasmsCheck}) — never a soft `warn`.
 *
 * There is nothing to resolve from `node_modules`: `node:sqlite` is a Node
 * builtin (stable on Node >= 24.15, our engines floor), so the probe is a
 * plain `import("node:sqlite")` with no `resolve` injection.
 * We still exercise the real load-and-use cycle — confirm `DatabaseSync` is a
 * function, open an in-memory db, request WAL, and run a CREATE/INSERT/SELECT
 * round-trip — so a builtin that loaded but is unusable still fails loudly.
 */
function nodeSqliteCheck(): Check {
  return {
    name: "node:sqlite built-in",
    async run() {
      try {
        // `node:sqlite` is a builtin; a bare static-string specifier resolves
        // it without touching `node_modules`. Older Node (< 24.15, below our
        // engines floor) lacks the module entirely → the import throws.
        const mod = (await import("node:sqlite")) as {
          DatabaseSync?: new (
            path: string,
          ) => {
            exec(sql: string): void;
            prepare(sql: string): { get(): unknown; run(): unknown };
            close(): void;
          };
        };
        const DatabaseSync = mod.DatabaseSync;
        if (typeof DatabaseSync !== "function") {
          return {
            status: "fail",
            message: "node:sqlite imported but exports no DatabaseSync constructor",
            hint: nodeSqliteFailureHint(),
          };
        }
        // In-memory database: never touches disk, never lingers. We request
        // WAL (the mode the real SqliteStore opens with) and run a trivial
        // round-trip to prove the binding is usable, not merely importable.
        const db = new DatabaseSync(":memory:");
        try {
          db.exec("PRAGMA journal_mode=WAL");
          db.exec("CREATE TABLE doctor_probe (n INTEGER)");
          db.prepare("INSERT INTO doctor_probe (n) VALUES (1)").run();
          const row = db.prepare("SELECT n FROM doctor_probe").get() as
            | { n?: number }
            | undefined;
          if (row?.n !== 1) {
            return {
              status: "fail",
              message: "node:sqlite round-trip returned an unexpected value",
              hint: nodeSqliteFailureHint(),
            };
          }
        } finally {
          db.close();
        }
        return { status: "ok", message: "node:sqlite (built-in) load + WAL OK" };
      } catch (err) {
        return {
          status: "fail",
          message: `node:sqlite failed to load: ${err instanceof Error ? err.message : String(err)}`,
          hint: nodeSqliteFailureHint(),
        };
      }
    },
  };
}

/**
 * Hint for every `node:sqlite` failure path. The module is a Node builtin, so
 * there is nothing to install or reinstall — the only realistic cause is a Node
 * older than our engines floor, where the builtin either does not exist or is
 * behind an unsupported experimental gate. Point the user at the Node version.
 */
function nodeSqliteFailureHint(): string {
  return "node:sqlite is a built-in on Node >= 24.15 (our engines floor); upgrade Node with `mise use node@24` or `nvm install 24`";
}

/**
 * Vendored parse grammars. `@opencodehub/ingestion` ships 16 WASM blobs
 * (15 grammars + the web-tree-sitter runtime) under `vendor/wasms/`, plus a
 * `manifest.json` pinning their versions. The parse pipeline loads these at
 * runtime with no install-time build, so a missing/empty/corrupt blob means
 * parsing is silently broken for that language. This is ALWAYS a hard fail —
 * a shipped artifact being absent is not a soft skip.
 *
 * Mirrors the prepublish gate `packages/ingestion/scripts/verify-vendor-wasms.mjs`
 * (same EXPECTED list, same `\0asm` magic check) but runs against the
 * installed package so `codehub doctor` validates a real deployment.
 */
const EXPECTED_WASMS: readonly string[] = [
  "web-tree-sitter.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm",
  "tree-sitter-java.wasm",
  "tree-sitter-c_sharp.wasm",
  "tree-sitter-c.wasm",
  "tree-sitter-cpp.wasm",
  "tree-sitter-ruby.wasm",
  "tree-sitter-php_only.wasm",
  "tree-sitter-kotlin.wasm",
  "tree-sitter-swift.wasm",
  "tree-sitter-dart.wasm",
];

// WASM binary magic bytes: \0 a s m.
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

function vendoredWasmsCheck(repoRoot: string): Check {
  return {
    name: "vendored wasm grammars",
    async run() {
      const vendorDir = resolveVendorWasmsDir(repoRoot);
      if (vendorDir === null) {
        return {
          status: "fail",
          message: "@opencodehub/ingestion vendor/wasms/ not found",
          hint: "reinstall @opencodehub/cli; vendored grammars ship inside @opencodehub/ingestion",
        };
      }
      const missing: string[] = [];
      const corrupt: string[] = [];
      for (const name of EXPECTED_WASMS) {
        const file = join(vendorDir, name);
        // Single open()+read of the first 4 bytes: covers existence, empty,
        // and bad-magic in one syscall pair (no existsSync→statSync TOCTOU).
        let fh: import("node:fs/promises").FileHandle | undefined;
        try {
          fh = await fsOpen(file, "r");
          const buf = Buffer.alloc(4);
          const { bytesRead } = await fh.read(buf, 0, 4, 0);
          if (bytesRead < 4 || !buf.subarray(0, 4).equals(WASM_MAGIC)) {
            corrupt.push(name);
          }
        } catch {
          missing.push(name);
        } finally {
          await fh?.close();
        }
      }
      if (missing.length > 0 || corrupt.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`${missing.length} missing`);
        if (corrupt.length > 0) parts.push(`${corrupt.length} corrupt`);
        const first = [...missing, ...corrupt][0];
        return {
          status: "fail",
          message: `vendored grammars broken (${parts.join(", ")}; e.g. ${first})`,
          hint: "reinstall @opencodehub/cli, or re-vendor with `bash scripts/build-vendor-wasms.sh` in a source checkout",
        };
      }
      return { status: "ok", message: `all ${EXPECTED_WASMS.length} grammars present` };
    },
  };
}

/**
 * SCIP indexer registry, one entry per language the ingestion pipeline can
 * compiler-index. `binName` is the executable/JAR the runner shells out to
 * (see `packages/scip-ingest/src/runners/index.ts`); `setupFlag` is the
 * `codehub setup --scip=<flag>` value that installs it (undefined when the
 * indexer is a system toolchain the user supplies themselves, e.g. go/rust/
 * java SDKs). `jar: true` indexers resolve under `~/.codehub/` rather than
 * by a `--version`-capable binary on PATH.
 */
interface ScipIndexerSpec {
  readonly language: string;
  readonly binName: string;
  readonly setupFlag?: string;
  /** True when the indexer is a JAR/asset under ~/.codehub, not a PATH binary. */
  readonly jar?: boolean;
  /**
   * The npm package this indexer ships from when it is a HARD dependency of
   * `@opencodehub/scip-ingest` (the pure-JS Sourcegraph indexers). When set,
   * the check resolves the bundled package via `createRequire` rather than
   * requiring it on PATH or under `~/.codehub/bin` — these always ship with
   * the CLI, so a clean install must report `ok` out-of-the-box.
   */
  readonly bundledPkg?: string;
}

const SCIP_INDEXERS: readonly ScipIndexerSpec[] = [
  {
    language: "typescript",
    binName: "scip-typescript",
    bundledPkg: "@sourcegraph/scip-typescript",
  },
  { language: "python", binName: "scip-python", bundledPkg: "@sourcegraph/scip-python" },
  { language: "go", binName: "scip-go", setupFlag: "go" },
  { language: "rust", binName: "rust-analyzer" },
  { language: "java", binName: "scip-java" },
  { language: "ruby", binName: "scip-ruby", setupFlag: "ruby" },
  { language: "c/c++", binName: "scip-clang", setupFlag: "clang" },
  { language: "c#", binName: "scip-dotnet", setupFlag: "dotnet" },
  { language: "kotlin", binName: "semanticdb-kotlinc-0.6.0.jar", setupFlag: "kotlin", jar: true },
  { language: "cobol", binName: "proleap-cobol-parser.jar", setupFlag: "cobol-proleap", jar: true },
];

function scipIndexerCheck(
  spec: ScipIndexerSpec,
  home: string,
  strict: boolean,
  run: RunCommandFn,
): Check {
  const missingStatus: CheckStatus = strict ? "fail" : "warn";
  const installHint = spec.bundledPkg
    ? `bundled with @opencodehub/cli (${spec.bundledPkg}); reinstall the CLI to restore it`
    : spec.setupFlag
      ? `install with \`codehub setup --scip=${spec.setupFlag}\``
      : `${spec.binName} is a system toolchain — install it via your package manager / language SDK`;
  return {
    name: `scip indexer: ${spec.language}`,
    async run() {
      if (spec.bundledPkg !== undefined) {
        // Hard dependency of @opencodehub/scip-ingest (ships with the CLI).
        // Authoritative check: does the indexer's bin shim resolve into a
        // directory that the analyze-time spawn PATH actually includes? That
        // is exactly what `hostedScipBinDirs()` (the same resolver
        // `withCodehubBinOnPath` uses) returns, so a match here guarantees the
        // runner will find the indexer by bare name — even though the nested
        // `node_modules/.bin` is NOT on the user's interactive PATH (so a bare
        // `<bin> --version` probe would false-FAIL).
        const onHostedPath = hostedScipBinDirs().some((d: string) =>
          existsSyncSafe(join(d, spec.binName)),
        );
        if (onHostedPath) {
          return { status: "ok", message: `${spec.binName} bundled (${spec.bundledPkg})` };
        }
        // Fall back to an explicit on-PATH install (e.g. a global
        // `npm i -g @sourcegraph/scip-typescript`).
        const res = await run(spec.binName, ["--version"]);
        if (res.status === 0) {
          return { status: "ok", message: `${spec.binName}: ${firstLine(res.stdout)}` };
        }
        return {
          status: missingStatus,
          message: `${spec.binName} not resolvable (bundled dep ${spec.bundledPkg} missing)`,
          hint: installHint,
        };
      }
      if (spec.jar === true) {
        // JAR/asset indexers aren't `--version`-able binaries: check the
        // file exists under ~/.codehub (setup downloads them there).
        const candidates =
          spec.language === "cobol"
            ? [join(home, ".codehub", "vendor", "proleap", spec.binName)]
            : [join(home, ".codehub", "bin", spec.binName)];
        for (const c of candidates) {
          if (await fileExists(c)) {
            return { status: "ok", message: `${spec.binName} present` };
          }
        }
        return {
          status: missingStatus,
          message: `${spec.binName} not installed`,
          hint: installHint,
        };
      }
      // PATH binary: try `<bin> --version`. Also check ~/.codehub/bin, where
      // `codehub setup --scip` installs the Sourcegraph indexers.
      const res = await run(spec.binName, ["--version"]);
      if (res.status === 0) {
        return { status: "ok", message: `${spec.binName}: ${firstLine(res.stdout)}` };
      }
      const localBin = join(home, ".codehub", "bin", spec.binName);
      if (await fileExists(localBin)) {
        return { status: "ok", message: `${spec.binName} present (~/.codehub/bin)` };
      }
      return {
        status: missingStatus,
        message: `${spec.binName} not on PATH`,
        hint: installHint,
      };
    },
  };
}

function binaryOnPathCheck(bin: string, hint: string, run: RunCommandFn): Check {
  return {
    name: `${bin} binary`,
    async run() {
      const res = await run(bin, ["--version"]);
      if (res.status !== 0) {
        return {
          status: "warn",
          message: `${bin} not on PATH`,
          hint,
        };
      }
      return { status: "ok", message: `${bin}: ${firstLine(res.stdout)}` };
    },
  };
}

/**
 * bandit needs the `[sarif]` extra (`bandit-sarif-formatter`) for `codehub
 * scan` to work — without it, `bandit -f sarif` is argparse-rejected (exit 2
 * + a `usage: bandit` banner) and the scan silently contributes zero findings.
 * A plain `bandit --version` reports "ok" while the formatter is missing, so
 * this check probes the formatter directly.
 *
 * The probe runs `bandit -f sarif` against an empty temp dir. argparse
 * validates the `--format` choice list BEFORE walking any target, so a missing
 * formatter still fails fast (~0.1s) without scanning the repo. The fail
 * branch gates on the STRUCTURAL signature (exit 2 + `usage: bandit` banner),
 * not on advisory prose, so it can't silently regress to "ok".
 */
function banditSarifCheck(run: RunCommandFn): Check {
  // Reuse the catalog spec's pinned install command (single source of truth)
  // so doctor's hint never drifts from the scanner wrapper advisory
  // (`packages/scanners/src/wrappers/bandit.ts`), which also derives from
  // `BANDIT_SPEC.installCmd`.
  const installHint = `P1 scanner — install with \`${BANDIT_SPEC.installCmd}\``;
  return {
    name: "bandit binary",
    async run() {
      const version = await run("bandit", ["--version"]);
      if (version.status !== 0) {
        return { status: "warn", message: "bandit not on PATH", hint: installHint };
      }
      const probeDir = await mkdtemp(join(tmpdir(), "codehub-bandit-probe-"));
      try {
        const res = await run("bandit", ["-f", "sarif", "--quiet", "-r", probeDir]);
        // argparse rejects an unknown --format choice with exit 2 + a usage
        // banner. That means the SARIF formatter extra is absent.
        const formatterMissing = res.status === 2 && /\busage:\s*bandit\b/i.test(res.stderr);
        if (formatterMissing) {
          return {
            status: "fail",
            message:
              "bandit present but the [sarif] formatter is missing — scan would emit 0 findings",
            hint: installHint,
          };
        }
        return { status: "ok", message: `bandit: ${firstLine(version.stdout)} (sarif ok)` };
      } finally {
        await rm(probeDir, { recursive: true, force: true });
      }
    },
  };
}

function embedderWeightsCheck(home: string): Check {
  return {
    name: "embedder weights",
    async run() {
      // Filename convention matches `embedder/src/paths.ts:modelFileName` —
      // fp32 uses `model.onnx`, int8 uses `model_int8.onnx` (underscore,
      // NOT hyphen). A historical hyphenated path name lingered here and
      // caused false-negative `warn`s for users who had int8 weights on
      // disk.
      const base = join(home, ".codehub", "models", "gte-modernbert-base");
      const fp32 = join(base, "fp32", "model.onnx");
      const int8 = join(base, "int8", "model_int8.onnx");
      const fp32Ok = await fileExists(fp32);
      const int8Ok = await fileExists(int8);
      if (!fp32Ok && !int8Ok) {
        return {
          status: "warn",
          message: "no embedder weights found",
          hint: "run `codehub setup --embeddings` (fp32) or `codehub setup --embeddings --int8`",
        };
      }
      const variant = fp32Ok ? "fp32" : "int8";
      return { status: "ok", message: `embedder weights present (${variant})` };
    },
  };
}

/**
 * Default loader for the `onnxruntime-web` runtime. The CLI lazy-imports it
 * only when embeddings are enabled (see `embedder/src/onnx-embedder.ts`), so
 * this probe mirrors that exact dynamic import. `onnxruntime-web` is an
 * OPTIONAL dependency — production resolves it from the CLI's own
 * `node_modules`. Unlike the old `onnxruntime-node`, it is prebuilt WebAssembly
 * with NO native binding and NO platform matrix: if it imports, it runs
 * everywhere Node ≥24 does.
 */
function loadOnnxBinding(): Promise<unknown> {
  // A template-string specifier keeps tsup/esbuild from statically resolving
  // (and force-bundling) the optional module at build time — it must resolve
  // from `node_modules` at runtime, exactly like the embedder's own lazy
  // `import("onnxruntime-web")`.
  const specifier = "onnxruntime-web";
  return import(specifier);
}

/**
 * Probe the OPTIONAL `onnxruntime-web` runtime the same way the embedder does —
 * a lazy dynamic import. Deliberately NON-FATAL: the embedder is an optional
 * capability and the real failure mode is a SILENT degrade to BM25-only
 * retrieval (the embedder open path catches the load error and falls back). So
 * an absent runtime is a `warn`, never a `fail`. Because onnxruntime-web is
 * prebuilt WASM with no platform matrix, there is no platform-specific gap to
 * name — if the import fails the package simply isn't installed.
 *
 * `load` is injectable so tests can drive both branches without depending on
 * whether the optional package is present on the host.
 */
function embedderBindingCheck(load: () => Promise<unknown> = loadOnnxBinding): Check {
  return {
    name: "embedder runtime (onnxruntime-web, WASM)",
    async run() {
      try {
        const mod = (await load()) as Record<string, unknown> | undefined;
        const ctor =
          mod?.["InferenceSession"] ??
          (mod?.["default"] as Record<string, unknown> | undefined)?.["InferenceSession"];
        if (typeof ctor !== "function") {
          return {
            status: "warn",
            message:
              "onnxruntime-web loaded but exports no InferenceSession — retrieval will use BM25 only",
            hint: "the local embedder is unavailable; configure a remote embedder (CODEHUB_EMBEDDING_URL / CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT) or reinstall onnxruntime-web.",
          };
        }
        return { status: "ok", message: "onnxruntime-web (WASM) load OK" };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          status: "warn",
          message: `embedder runtime not installed → retrieval will use BM25 only (${detail})`,
          hint: "the local WASM embedder is optional; configure a remote embedder (CODEHUB_EMBEDDING_URL / CODEHUB_EMBEDDING_SAGEMAKER_ENDPOINT) to embed off-box.",
        };
      }
    },
  };
}

function registryPathCheck(home: string): Check {
  return {
    name: "registry path",
    async run() {
      const regPath = join(home, ".codehub", "registry.json");
      // Single attempt: branch on `ENOENT` for the missing-file case so
      // the existence check and the read share one syscall — closes the
      // TOCTOU gap flagged by js/file-system-race.
      let raw: string;
      try {
        raw = await readFile(regPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return {
            status: "warn",
            message: `~/.codehub/registry.json missing`,
            hint: "run `codehub analyze` in any git repo to create the registry",
          };
        }
        return {
          status: "fail",
          message: `registry read failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: "delete ~/.codehub/registry.json and re-run `codehub analyze`",
        };
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return {
            status: "fail",
            message: "registry.json is not an object",
            hint: "back up the file and run `codehub analyze` again",
          };
        }
        const count = Object.keys(parsed).length;
        return {
          status: "ok",
          message: `registry readable (${count} repo${count === 1 ? "" : "s"})`,
        };
      } catch (err) {
        return {
          status: "fail",
          message: `registry parse failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: "delete ~/.codehub/registry.json and re-run `codehub analyze`",
        };
      }
    },
  };
}

function sarifSchemaCheck(_repoRoot: string): Check {
  return {
    name: "@opencodehub/sarif build",
    async run() {
      // `@opencodehub/sarif` is bundled into this CLI (workspace libs are
      // inlined at build time — see `packages/cli/tsup.config.ts`). The check
      // is now a liveness probe on the bundled code: a statically-imported,
      // callable export proves the SARIF surface shipped. There is no separate
      // package to resolve or build, so the old `import.meta.resolve` /
      // `pnpm -r build` paths no longer apply.
      if (typeof mergeSarif === "function") {
        return { status: "ok", message: "@opencodehub/sarif bundled" };
      }
      return {
        status: "fail",
        message: "@opencodehub/sarif surface missing from the CLI bundle",
        hint: "reinstall @opencodehub/cli; the SARIF code ships inside the CLI",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printTable(
  rows: readonly { readonly name: string; readonly result: CheckResult }[],
): void {
  const table = new Table({
    head: ["CHECK", "STATUS", "DETAIL", "HINT"],
    style: { head: [], border: [] },
    colWidths: [32, 8, 48, 48],
    wordWrap: true,
  });
  for (const { name, result } of rows) {
    const glyph = result.status === "ok" ? "OK" : result.status === "warn" ? "WARN" : "FAIL";
    table.push([name, glyph, result.message, result.hint ?? ""]);
  }
  console.log(table.toString());
}

async function runCommand(
  cmd: string,
  args: readonly string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  return await new Promise((resolveProm) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", () => {
      resolveProm({ status: 127, stdout, stderr });
    });
    child.on("close", (code: number | null) => {
      resolveProm({ status: code ?? 0, stdout, stderr });
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx < 0 ? s.trim() : s.slice(0, idx).trim();
}

function guessRepoRoot(): string {
  // `codehub` ships from packages/cli/dist/commands — walking four levels
  // up lands at the monorepo root where `packages/` and `node_modules/`
  // live.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

/**
 * Resolve an npm package for the native-binding checks. We try two
 * environments in order, so doctor returns `OK` in every realistic install
 * shape — monorepo checkout, global `pnpm i -g`, tarball, symlinked bin:
 *
 *   1. The CLI package's own `node_modules` — `createRequire` off
 *      `import.meta.url` walks outward through the same resolution chain
 *      Node would use for a real `await import(pkg)` from inside the CLI,
 *      so this is the authoritative answer for "can the CLI load this?".
 *   2. The supplied `repoRoot` — legacy fallback for the in-monorepo case
 *      where the CLI is running from `packages/cli/dist/` and dependencies
 *      hoist to the workspace root.
 *
 * We stop at the first hit. Returning `null` preserves the existing
 * semantics of the caller (`warn` result with a reinstall hint).
 */
/**
 * Locate `@opencodehub/ingestion`'s `vendor/wasms/` directory in the running
 * deployment. The package's `exports` map does not expose `package.json`
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`), so we resolve a known exported entry
 * and walk up to the package root, then check `vendor/wasms`. Falls back to
 * the monorepo layout (`packages/ingestion/vendor/wasms`) for source checkouts
 * where the CLI runs from `packages/cli/dist`. Returns null if neither hits.
 */
function resolveVendorWasmsDir(repoRoot: string): string | null {
  // 1. Bundled deployment (the published-CLI case): `@opencodehub/ingestion`
  //    is inlined into this CLI's bundle and its `vendor/wasms/` tree is copied
  //    into the CLI's own `dist/` (see `packages/cli/tsup.config.ts` onSuccess).
  //    Walk up from this module's location looking for `vendor/wasms/manifest.json`.
  //    This is the same directory the runtime parser loads from, so doctor
  //    validates the real deployment.
  {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "vendor", "wasms");
      if (existsSyncSafe(join(candidate, "manifest.json"))) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // 2. Monorepo / source-checkout fallback: the CLI runs from
  //    `packages/cli/dist` while `@opencodehub/ingestion` lives as a sibling
  //    workspace package with its vendored grammars under its own tree.
  const monorepo = join(repoRoot, "packages", "ingestion", "vendor", "wasms");
  if (existsSyncSafe(join(monorepo, "manifest.json"))) return monorepo;
  return null;
}

/** Cheap synchronous existence probe used only during path resolution. */
function existsSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

