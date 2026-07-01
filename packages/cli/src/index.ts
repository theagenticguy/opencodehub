#!/usr/bin/env node
/**
 * `codehub` CLI entrypoint.
 *
 * Every subcommand is loaded lazily via `await import(...)` so that
 * `codehub --help` (and `codehub <command> --help`) stays fast: no native storage engine
 * native binding, no pipeline, no MCP SDK unless we are actually going to
 * run that subcommand.
 */

import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Type-only import — erased at compile time, so it does not pull the
// `@opencodehub/pack` barrel into the CLI's `--help` startup path (the whole
// file loads subcommands lazily to keep startup cheap). The runtime channel
// list is duplicated in `parseCacheChannelFlag` below and kept in sync with
// `CACHE_CHANNELS` in `@opencodehub/pack/cache.ts`.
import type { CacheChannel } from "@opencodehub/pack";
// Silence the one-shot node:sqlite ExperimentalWarning before any subcommand
// lazily loads the storage layer. This module is dependency-free (no native
// binding), so importing it eagerly does not regress `--help` startup cost.
import { installSqliteRuntimeGuard } from "@opencodehub/storage/sqlite-runtime";
import { Command } from "commander";

installSqliteRuntimeGuard();

// Read the CLI's own version from its package.json. The bin entry is always
// emitted at <pkg-root>/dist/index.js in every layout (the tsup collapse keeps
// `index` at the dist root), so package.json is exactly one level up. This
// single `..` is layout-stable precisely because index.js never moves; the
// asset resolvers that DID move use the walk-up probe in ./asset-resolver.ts.
const pkgJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const pkgVersion = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version as string;

// `OCH_NATIVE_PARSER` was removed in 0.4.0 with the WASM-only parser
// migration. If a stale shell or .envrc still sets it, emit a one-shot
// advisory and clear it so it doesn't leak into spawned worker processes
// (some of which may still inspect `process.env`).
if (process.env["OCH_NATIVE_PARSER"] !== undefined) {
  process.stderr.write(
    "[codehub] OCH_NATIVE_PARSER was removed in 0.4.0; WASM is the only parser runtime. Unset to silence this warning.\n",
  );
  delete process.env["OCH_NATIVE_PARSER"];
}

/**
 * Valid `--cache-channel` values (Move 4). Kept in sync with `CACHE_CHANNELS`
 * in `@opencodehub/pack/cache.ts` — duplicated here as bare strings so the
 * commander layer can validate the flag without eagerly importing the pack
 * barrel (which would regress `--help` startup cost). The `code-pack` action
 * forwards the narrowed value; `runCodePack`/`runVarianceProbe` re-default it.
 */
const CACHE_CHANNEL_VALUES = [
  "bedrock",
  "vertex",
  "anthropic",
  "claude-on-aws",
  "foundry",
  "auto",
] as const;

/**
 * Validate the `--cache-channel` flag value once, before either the pack or
 * variance-probe path runs. Commander applies the `"auto"` default, so a
 * non-string here means the option was cleared — fall back to `auto`. An
 * unrecognized channel exits with a clear error instead of silently
 * mis-routing cache-marker emission.
 */
function parseCacheChannelFlag(value: unknown): CacheChannel {
  if (typeof value !== "string" || value.length === 0) return "auto";
  if ((CACHE_CHANNEL_VALUES as readonly string[]).includes(value)) {
    return value as CacheChannel;
  }
  process.stderr.write(
    `[codehub] --cache-channel: unknown channel '${value}'. ` +
      `Valid: ${CACHE_CHANNEL_VALUES.join(", ")}.\n`,
  );
  process.exit(2);
}

const program = new Command()
  .name("codehub")
  .version(pkgVersion)
  .description("OpenCodeHub — code-graph indexer and MCP server for coding agents");

program
  .command("analyze [path]")
  .description("Index a repository at [path] (default: current directory)")
  .option("--force", "Ignore registry cache and re-run the pipeline")
  .option("--embeddings", "Embed symbols and populate the embeddings table in store.sqlite")
  .option("--embeddings-int8", "Use the int8 embedder variant (~81 MB) instead of fp32 (~321 MB)")
  .option(
    "--granularity <csv>",
    "Hierarchical embedding tiers to emit, comma-separated. Values: symbol, file, community. Default: symbol. Example: --granularity symbol,file,community",
  )
  .option(
    "--embeddings-workers <n|auto>",
    'Parallel ONNX embedder workers (each ~300 MB RSS on fp32). "auto" = os.cpus().length - 1, min 1. Default: "auto" when --embeddings is on (was 1 until 2026-04-27; single-threaded ONNX inference on a 100k-node repo took ~45 min, so CLI now opts into parallel by default). Pass --embeddings-workers 1 for the legacy in-process path.',
  )
  .option(
    "--embeddings-batch-size <n>",
    "Chunks per embedBatch() call. Default 32. Set to 1 to restore the legacy one-node-per-call pattern.",
  )
  .option("--offline", "Assert no network access during analyze")
  .option("--verbose", "Emit per-phase pipeline progress")
  .option("--skip-agents-md", "Do not write the AGENTS.md / CLAUDE.md stanza")
  .option(
    "--sbom",
    "Emit .codehub/sbom.cyclonedx.json + .codehub/sbom.spdx.json from Dependency nodes. Default ON — use --no-sbom to suppress.",
  )
  .option("--no-sbom", "Suppress SBOM emission. Equivalent to omitting `sbom: true`.")
  .option(
    "--coverage",
    "Force the coverage overlay phase on and warn when no report is found. Default AUTO — `codehub analyze` auto-detects lcov/cobertura/jacoco/coverage.py reports and silently skips when none exist.",
  )
  .option("--no-coverage", "Force the coverage overlay phase off even when a report is present.")
  .option(
    "--scan",
    "Run Priority-1 scanners after analyze, write .codehub/scan.sarif, and ingest findings into the graph. Default ON — use --no-scan to suppress.",
  )
  .option(
    "--no-scan",
    "Skip the post-analyze scan step. The graph pipeline runs unchanged; `codehub verdict` / `list_findings` work against the last SARIF on disk.",
  )
  .option(
    "--summaries",
    "Opt into the summarize phase (structured Bedrock summaries per callable). Default OFF — `codehub analyze` is fast, local, deterministic by default. Also enabled by CODEHUB_BEDROCK_SUMMARIES=1.",
  )
  .option(
    "--no-summaries",
    "Explicitly disable the summarize phase (equivalent to CODEHUB_BEDROCK_DISABLED=1). Only meaningful when combined with CODEHUB_BEDROCK_SUMMARIES=1.",
  )
  .option(
    "--max-summaries <n|auto>",
    'Cap on Bedrock summarize calls per run. "auto" (default) scales the cap to 10% of the SCIP-confirmed callable count (max 500).',
    "auto",
  )
  .option(
    "--summary-model <id>",
    "Override the Bedrock model id used by the summarize phase (defaults to DEFAULT_MODEL_ID).",
  )
  .option(
    "--skills",
    "After analyze, emit one SKILL.md per Community (symbolCount >= 5) under .codehub/skills/",
  )
  .option(
    "--strict-detectors",
    "Drop heuristic-only matches from the route / ORM detectors — emit edges only when the receiver's module origin was confirmed (DET-O-001)",
  )
  .option(
    "--allow-build-scripts <list>",
    "Comma-separated opt-ins that enable build-script-driven indexers. Current value: `proleap` (JVM COBOL deep-parse). Unset → regex hot path only.",
  )
  .action(async (path: string | undefined, opts: Record<string, unknown>) => {
    const mod = await import("./commands/analyze.js");
    // Pass the raw flag straight through to `runAnalyze`. The env
    // kill-switch (`CODEHUB_BEDROCK_DISABLED=1`) and the env opt-in
    // (`CODEHUB_BEDROCK_SUMMARIES=1`) are re-checked inside `runAnalyze`
    // via `resolveSummariesEnabled` so tests that call `runAnalyze`
    // directly honor the same truth table. Summaries are OFF by default
    // — the fast, local, deterministic analyze path. Pass `--summaries`
    // or set `CODEHUB_BEDROCK_SUMMARIES=1` to opt in.
    let summaries: boolean | undefined;
    if (opts["summaries"] === true) summaries = true;
    else if (opts["summaries"] === false) summaries = false;
    else summaries = undefined;

    // --max-summaries accepts either a positive integer or the literal
    // string "auto". Unknown strings fall back to "auto" so the CLI never
    // refuses a run over flag syntax.
    const rawMax = opts["maxSummaries"];
    let maxSummariesPerRun: number | "auto";
    if (rawMax === "auto" || rawMax === undefined) {
      maxSummariesPerRun = "auto";
    } else if (typeof rawMax === "number" && Number.isFinite(rawMax)) {
      maxSummariesPerRun = Math.max(0, Math.floor(rawMax));
    } else if (typeof rawMax === "string") {
      const parsed = Number.parseInt(rawMax, 10);
      maxSummariesPerRun = Number.isFinite(parsed) ? Math.max(0, parsed) : "auto";
    } else {
      maxSummariesPerRun = "auto";
    }

    const granularity = parseGranularityCsv(opts["granularity"]);
    const allowBuildScripts = parseAllowBuildScripts(opts["allowBuildScripts"]);
    // When --embeddings is on and the user didn't pick a worker count, default
    // to "auto" — single-threaded ONNX inference on 100k+ nodes takes ~45 min
    // vs ~6–8 min with all cores busy. Power users can still pass
    // `--embeddings-workers 1` for the legacy path.
    const workersRaw =
      opts["embeddings"] === true && opts["embeddingsWorkers"] === undefined
        ? "auto"
        : opts["embeddingsWorkers"];
    const embeddingsWorkers = parseWorkerCount(workersRaw);
    const embeddingsBatchSize = parsePositiveInt(opts["embeddingsBatchSize"]);

    const analyzeSummary = await mod.runAnalyze(path ?? process.cwd(), {
      force: opts["force"] === true,
      embeddings: opts["embeddings"] === true,
      embeddingsVariant: opts["embeddingsInt8"] === true ? "int8" : "fp32",
      ...(granularity !== undefined ? { embeddingsGranularity: granularity } : {}),
      ...(embeddingsWorkers !== undefined ? { embeddingsWorkers } : {}),
      ...(embeddingsBatchSize !== undefined ? { embeddingsBatchSize } : {}),
      offline: opts["offline"] === true,
      verbose: opts["verbose"] === true,
      skipAgentsMd: opts["skipAgentsMd"] === true,
      // `sbom`, `coverage`, `scan` are three-state (true / false / auto).
      // commander encodes `--no-sbom` as `opts.sbom === false`, `--sbom` as
      // `true`, and omitted as `undefined`. Forward all three verbatim —
      // `runAnalyze` reads the resolvers (resolveSbomEnabled / resolveScan-
      // Enabled / resolveCoverageEnabled) to pick the effective value.
      ...(opts["sbom"] === false ? { sbom: false as const } : {}),
      ...(opts["sbom"] === true ? { sbom: true as const } : {}),
      ...(opts["coverage"] === false ? { coverage: false as const } : {}),
      ...(opts["coverage"] === true ? { coverage: true as const } : {}),
      ...(opts["scan"] === false ? { scan: false as const } : {}),
      ...(opts["scan"] === true ? { scan: true as const } : {}),
      ...(summaries !== undefined ? { summaries } : {}),
      maxSummariesPerRun,
      ...(typeof opts["summaryModel"] === "string" ? { summaryModel: opts["summaryModel"] } : {}),
      skills: opts["skills"] === true,
      strictDetectors: opts["strictDetectors"] === true,
      ...(allowBuildScripts !== undefined ? { allowBuildScripts } : {}),
    });
    // Advisory exit code 3: analyze built a graph but extracted zero code
    // symbols (likely a broken parser). Distinct from the generic failure
    // exit 1 so CI can detect a silent-skeleton run without parsing logs.
    if (analyzeSummary.zeroSymbolGuard === true) process.exitCode = 3;
  });

program
  .command("index [paths...]")
  .description(
    "Register an existing .codehub/ folder into the registry (no re-analysis). " +
      "With no [paths], registers the current directory.",
  )
  .option("--force", "Stamp a minimal meta.json stub when .codehub/meta.json is missing")
  .option("--allow-non-git", "Allow registering folders that are not git repositories")
  .action(async (paths: string[] | undefined, opts: Record<string, boolean | undefined>) => {
    const mod = await import("./commands/index-repo.js");
    await mod.runIndexRepo(paths ?? [], {
      force: opts["force"] === true,
      allowNonGit: opts["allowNonGit"] === true,
    });
  });

program
  .command("init [path]")
  .description(
    "Bootstrap a repo for OpenCodeHub — copies the Claude Code plugin assets into .claude/ (project-scope), writes .mcp.json, appends .codehub/ to .gitignore, seeds opencodehub.policy.yaml",
  )
  .option("--force", "Overwrite conflicting files under .claude/")
  .option("--skip-mcp", "Skip writing .mcp.json")
  .option("--skip-policy", "Skip seeding opencodehub.policy.yaml")
  .action(async (path: string | undefined, opts: Record<string, boolean | undefined>) => {
    const mod = await import("./commands/init.js");
    const result = await mod.runInit({
      ...(path !== undefined ? { repo: path } : {}),
      force: opts["force"] === true,
      skipMcp: opts["skipMcp"] === true,
      skipPolicy: opts["skipPolicy"] === true,
    });
    // One-line recap so the user knows what changed.
    const bits: string[] = [`${result.filesCopied} file(s) into .claude/`];
    if (result.mcpResult) bits.push(`.mcp.json (${result.mcpResult.action})`);
    if (result.gitignoreUpdated) bits.push(".gitignore updated");
    if (result.policySeeded) bits.push("opencodehub.policy.yaml seeded");
    console.warn(`codehub init: ${bits.join(" · ")}`);
    console.warn("Next: run 'codehub analyze' to build the graph, then restart Claude Code.");
  });

program
  .command("setup")
  .description(
    "Write MCP config entries for supported editors, download embedder weights, or install SCIP adapter binaries",
  )
  .option(
    "--editors <list>",
    "Comma-separated editor ids (claude-code,cursor,codex,windsurf,opencode). Default: all",
  )
  .option("--force", "Overwrite an existing codehub entry without prompting; re-download weights")
  .option("--undo", "Restore the most recent .bak next to each config")
  .option("--embeddings", "Download F2LLM-v2-80M ONNX weights (SHA256-pinned)")
  .option("--int8", "Use the int8 weight variant (~92 MB) instead of fp32 (~332 MB)")
  .option("--model-dir <path>", "Override the target directory for embedder weights")
  .option("--plugin", "Install the Claude Code plugin to ~/.claude/plugins/opencodehub/")
  .option(
    "--scip <tool>",
    "Install an external SCIP adapter binary (clang|ruby|dotnet|kotlin) or 'all'. SHA256-pinned; dotnet requires .NET SDK 8+ on PATH",
  )
  .option(
    "--cobol-proleap",
    "Build the uwol/cobol-parser library from source (git clone + mvn install) and compile the bridge wrapper. Requires git, mvn, JDK 17+ on PATH. Installs under ~/.codehub/vendor/proleap/",
  )
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const mod = await import("./commands/setup.js");
    if (opts["plugin"] === true) {
      await mod.runSetupPlugin({});
      return;
    }
    if (opts["cobolProleap"] === true) {
      await mod.runSetupCobolProleap({
        force: opts["force"] === true,
      });
      return;
    }
    if (typeof opts["scip"] === "string") {
      const tool = mod.parseScipFlag(opts["scip"]);
      await mod.runSetupScip({
        tool,
        force: opts["force"] === true,
      });
      return;
    }
    if (opts["embeddings"] === true) {
      const modelDir = typeof opts["modelDir"] === "string" ? opts["modelDir"] : undefined;
      await mod.runSetupEmbeddings({
        variant: opts["int8"] === true ? "int8" : "fp32",
        ...(modelDir !== undefined ? { modelDir } : {}),
        force: opts["force"] === true,
      });
      return;
    }
    const editors = typeof opts["editors"] === "string" ? parseEditors(opts["editors"]) : undefined;
    await mod.runSetup({
      ...(editors !== undefined ? { editors } : {}),
      force: opts["force"] === true,
      undo: opts["undo"] === true,
    });
  });

program
  .command("mcp")
  .description("Launch the codehub stdio MCP server")
  .action(async () => {
    const mod = await import("./commands/mcp.js");
    await mod.runMcp();
  });

program
  .command("list")
  .description("List all repos indexed on this machine")
  .action(async () => {
    const mod = await import("./commands/list.js");
    await mod.runList();
  });

program
  .command("status [path]")
  .description("Show index metadata for [path] (default: current directory)")
  .action(async (path: string | undefined) => {
    const mod = await import("./commands/status.js");
    await mod.runStatus(path ?? process.cwd());
  });

program
  .command("clean [path]")
  .description("Delete the index at [path]. --all deletes every registered index.")
  .option("--all", "Delete every registered index")
  .action(async (path: string | undefined, opts: Record<string, boolean>) => {
    const mod = await import("./commands/clean.js");
    await mod.runClean(path ?? process.cwd(), { all: opts["all"] === true });
  });

program
  .command("pack [path]")
  .description("Produce a single-file LLM-ready snapshot of the repo via repomix (AST-compressed).")
  .option("--style <style>", "Output style: xml|markdown|json|plain", "xml")
  .option("--no-compress", "Disable tree-sitter AST compression (keeps full source)")
  .option("--remove-comments", "Strip comments from the packed output")
  .option("--out <path>", "Custom output path (default: <repo>/.codehub/pack/repo.<ext>)")
  .action(async (path: string | undefined, opts: Record<string, unknown>) => {
    const mod = await import("./commands/pack.js");
    const style = opts["style"] as "xml" | "markdown" | "json" | "plain" | undefined;
    const result = await mod.runPack(path ?? process.cwd(), {
      ...(style !== undefined ? { style } : {}),
      compress: opts["compress"] !== false,
      removeComments: opts["removeComments"] === true,
      ...(typeof opts["out"] === "string" ? { outputPath: opts["out"] as string } : {}),
    });
    console.warn(
      `codehub pack: wrote ${result.bytes} bytes to ${result.outputPath} in ${result.durationMs}ms`,
    );
  });

program
  .command("code-pack [path]")
  .description(
    "Produce the deterministic 9-item code-pack BOM (manifest + skeleton + file-tree + deps + " +
      "ast-chunks + xrefs + findings + licenses + context-bom) plus a readme at " +
      "<repo>/.codehub/packs/<packHash>/. Default engine is the new @opencodehub/pack BOM; " +
      "--engine repomix opts into the legacy single-file snapshot (drop deferred to M7).",
  )
  .option("--budget <n>", "AST-chunker token budget (default 100000)", (v) =>
    Number.parseInt(v, 10),
  )
  .option(
    "--tokenizer <id>",
    'Tokenizer pin "<vendor>:<name>@<pin>" (default openai:o200k_base@tiktoken-0.8.0)',
  )
  .option(
    "--out-dir <dir>",
    "Override the .codehub/packs/<packHash>/ default output directory (the directory still " +
      "contains the manifest + BOM bodies; supplying this flag lets you put the artifacts " +
      "under a non-standard path, e.g. /tmp/my-pack)",
  )
  .option(
    "--engine <engine>",
    "Engine: pack (default — 9-item BOM via @opencodehub/pack) or repomix (legacy single-file)",
    "pack",
  )
  .option(
    "--cache-channel <channel>",
    "Channel-aware cache-prefix enforcement (Move 4): bedrock | vertex | anthropic | " +
      "claude-on-aws | foundry | auto (default). Emits cache-breakpoint markers + a " +
      "deterministic prefix boundary only on the opt-in channels (bedrock, vertex); the " +
      "automatic channels and the auto default emit no markers (byte-identical output).",
    "auto",
  )
  .option(
    "--explain-context",
    "After packing, print a summary of the context read-receipt (files indexed, lines, " +
      "hash coverage, per-language breakdown) read from the pack's context-bom.json",
  )
  .option(
    "--prove",
    "After packing, emit an in-toto context attestation (attestation.intoto.json) whose " +
      "subject is the pack's packHash and whose predicate records the context provenance " +
      "(what was packed). Composable beneath the SLSA build provenance CI attests; unsigned " +
      "(signing stays a CI concern). Pack engine only.",
  )
  .option("--json", "With --explain-context or --variance-probe, emit the result as JSON on stdout")
  .option(
    "--variance-probe <task-file>",
    "Measure the run-to-run answer variance an OCH pack removes from a coding agent " +
      "(spec 010 / Move 2). Loads the task file, generates the pack, runs the agent N times " +
      "with vs. without the pack, and reports the dispersion delta + token overhead. Agents run " +
      "on Amazon Bedrock. On-demand only — costs real agent minutes + Bedrock spend, never a CI gate.",
  )
  .option("--runs <n>", "With --variance-probe: runs per arm (default 10)", (v) =>
    Number.parseInt(v, 10),
  )
  .option(
    "--harness <harness>",
    "With --variance-probe: restrict to one agent — claude or codex (default: both)",
  )
  .option(
    "--aws-region <region>",
    "With --variance-probe: AWS region for Bedrock inference (default: inherited AWS_REGION)",
  )
  .option(
    "--model-claude <id>",
    "With --variance-probe: Claude Code Bedrock model / inference-profile id " +
      "(us.-prefixed; default us.anthropic.claude-sonnet-4-6)",
  )
  .option(
    "--model-codex <id>",
    "With --variance-probe: Codex Bedrock model id (default openai.gpt-5.5)",
  )
  .option(
    "--pack-tokenizer <id>",
    "With --variance-probe: tokenizer-provenance lane the with-pack arm packs under " +
      '"<vendor>:<name>@<pin>" (default openai:o200k_base@tiktoken-0.8.0). Use ' +
      "anthropic:claude-sonnet-5@2026-06-30 to author the pack for Sonnet 5's heavier tokenizer. " +
      "Recorded in the variance report so results attribute to a lane (Finding 0001 v2).",
  )
  .action(async (path: string | undefined, opts: Record<string, unknown>) => {
    // Channel-aware cache-prefix enforcement (Move 4). Validated once here so
    // an unknown channel errors clearly before either path runs. Commander
    // camelCases the flag to opts["cacheChannel"]; the default is "auto".
    const cacheChannel = parseCacheChannelFlag(opts["cacheChannel"]);
    // --variance-probe short-circuits the normal pack path: it loads a task,
    // generates the pack itself, and runs the with/without experiment.
    if (typeof opts["varianceProbe"] === "string") {
      const probeMod = await import("./commands/variance-probe.js");
      const harness = parseHarness(opts["harness"]);
      const runs =
        typeof opts["runs"] === "number" && Number.isFinite(opts["runs"])
          ? opts["runs"]
          : undefined;
      // Per-harness model overrides — Claude and Codex take different Bedrock
      // ids, so they are separate flags rather than one global --model.
      const models: Record<string, string> = {};
      if (typeof opts["modelClaude"] === "string") models["claude"] = opts["modelClaude"];
      if (typeof opts["modelCodex"] === "string") models["codex"] = opts["modelCodex"];
      const report = await probeMod.runVarianceProbe({
        taskFile: opts["varianceProbe"],
        ...(runs !== undefined ? { runs } : {}),
        ...(harness !== undefined ? { harness } : {}),
        ...(typeof opts["awsRegion"] === "string" ? { awsRegion: opts["awsRegion"] } : {}),
        ...(Object.keys(models).length > 0 ? { models } : {}),
        ...(typeof opts["packTokenizer"] === "string"
          ? { packTokenizer: opts["packTokenizer"] }
          : {}),
        cacheChannel,
      });
      probeMod.printVarianceReport(report, opts["json"] === true);
      return;
    }
    const mod = await import("./commands/code-pack.js");
    const rawEngine = typeof opts["engine"] === "string" ? opts["engine"] : "pack";
    const engine: "pack" | "repomix" =
      rawEngine === "repomix" ? "repomix" : rawEngine === "pack" ? "pack" : "pack";
    if (rawEngine !== engine && rawEngine !== "pack") {
      throw new Error(`Unknown --engine value: "${rawEngine}". Expected one of: pack, repomix`);
    }
    const budget =
      typeof opts["budget"] === "number" && Number.isFinite(opts["budget"])
        ? opts["budget"]
        : undefined;
    const result = await mod.runCodePack({
      ...(path !== undefined ? { repo: path } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(typeof opts["tokenizer"] === "string" ? { tokenizer: opts["tokenizer"] } : {}),
      ...(typeof opts["outDir"] === "string" ? { outDir: opts["outDir"] } : {}),
      engine,
      cacheChannel,
    });
    if (result.engine === "pack") {
      console.warn(
        `codehub code-pack: wrote ${result.bomItemCount} BOM items to ${result.outDir} ` +
          `(packHash=${result.packHash.slice(0, 12)})`,
      );
      if (opts["explainContext"] === true) {
        const summary = await mod.explainContextBom(result.outDir);
        mod.printContextSummary(summary, opts["json"] === true);
      }
      if (opts["prove"] === true && result.manifest !== null) {
        const attestationPath = await mod.writeContextAttestation(result.outDir, result.manifest);
        console.warn(`codehub code-pack: wrote context attestation to ${attestationPath}`);
      }
    } else {
      console.warn(
        `codehub code-pack: wrote repomix snapshot to ${result.repomixOutputPath ?? result.outDir} ` +
          `(packHash=${result.packHash.slice(0, 12)})`,
      );
    }
  });

program
  .command("replay")
  .description(
    "Assert two code-packs are decision-equivalent (spec 011 / ADR 0020): same files + byte " +
      "ranges selected under the same budget, regardless of incidental drift (tokenCount, pins, " +
      "chunk text). packHash equality is the cheap witness; a decisionHash projection is the " +
      "contract. Verdict: EQUIVALENT / DIVERGED / BUDGET_MISMATCH / CORRUPT. On-demand, never a CI gate.",
  )
  .requiredOption(
    "--compare <packs...>",
    "Two pack directories (.codehub/packs/<packHash>/) to compare for decision-equivalence",
  )
  .option(
    "--json",
    "Emit the full replay record (verdict + decisionHashes + diff) as JSON on stdout",
  )
  .option(
    "--budget-strict",
    "Treat a BUDGET_MISMATCH (different --budget between the packs) as a failure exit",
  )
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/replay.js");
    const packs = Array.isArray(opts["compare"]) ? (opts["compare"] as string[]) : [];
    if (packs.length !== 2) {
      throw new Error(
        `codehub replay --compare expects exactly two pack directories, got ${packs.length}.`,
      );
    }
    const budgetStrict = opts["budgetStrict"] === true;
    const [packA, packB] = packs as [string, string];
    const result = await mod.runReplayCompare(packA, packB);
    mod.printReplayResult(result, opts["json"] === true, budgetStrict);
    const { exitCode } = mod.replayVerdictLine(result, budgetStrict);
    if (exitCode !== 0) process.exitCode = exitCode;
  });

program
  .command("query <text>")
  .description("Direct hybrid search against a repo's graph")
  .option("--limit <n>", "Max results", (v) => Number.parseInt(v, 10), 10)
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout")
  .option("--content", "Attach full symbol source to each hit (capped at 2000 chars)")
  .option(
    "--context <text>",
    "What you are working on — prefixed to the query text to steer ranking",
  )
  .option("--goal <text>", "What you want to find — prefixed alongside --context to steer ranking")
  .option("--max-symbols <n>", "Max symbols in process-grouped output (default 50)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--bm25-only", "Skip the embedder probe and run BM25 search only")
  .option("--rerank-top-k <n>", "RRF top-k passed to hybrid fusion (default 50)", (v) =>
    Number.parseInt(v, 10),
  )
  .option(
    "--zoom",
    "Enable coarse-to-fine retrieval (file tier → symbol tier). Requires an embedder and a hierarchical index (see `analyze --granularity symbol,file,community`).",
  )
  .option("--fanout <n>", "Files to shortlist at the coarse step when --zoom is on", (v) =>
    Number.parseInt(v, 10),
  )
  .option(
    "--granularity <tier>",
    "Restrict ANN to one hierarchical tier: symbol (default), file, or community",
  )
  .option(
    "--force-backend-mismatch",
    "Bypass the embedder fingerprint check. Lets a query run when the persisted embedder model_id differs from the current one. Vectors may be stale.",
  )
  .action(async (text: string, opts: Record<string, unknown>) => {
    const mod = await import("./commands/query.js");
    const granularity = parseQueryGranularity(opts["granularity"]);
    await mod.runQuery(text, {
      limit: typeof opts["limit"] === "number" ? opts["limit"] : 10,
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      json: opts["json"] === true,
      content: opts["content"] === true,
      ...(typeof opts["context"] === "string" ? { context: opts["context"] } : {}),
      ...(typeof opts["goal"] === "string" ? { goal: opts["goal"] } : {}),
      ...(typeof opts["maxSymbols"] === "number" ? { maxSymbols: opts["maxSymbols"] } : {}),
      bm25Only: opts["bm25Only"] === true,
      ...(typeof opts["rerankTopK"] === "number" ? { rerankTopK: opts["rerankTopK"] } : {}),
      zoom: opts["zoom"] === true,
      ...(typeof opts["fanout"] === "number" ? { fanout: opts["fanout"] } : {}),
      ...(granularity !== undefined ? { granularity } : {}),
      forceBackendMismatch: opts["forceBackendMismatch"] === true,
    });
  });

program
  .command("context <symbol>")
  .description("360° view of a symbol (callers, callees, flows)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout")
  .option(
    "--target-uid <id>",
    "Exact node id from a prior result; bypasses name-based disambiguation",
  )
  .option("--file-path <hint>", "File path (or suffix) to disambiguate same-named symbols")
  .option("--kind <kind>", "Kind filter (Function, Method, Class, Interface, …)")
  .action(async (symbol: string, opts: Record<string, unknown>) => {
    const mod = await import("./commands/context.js");
    await mod.runContext(symbol, {
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      json: opts["json"] === true,
      ...(typeof opts["targetUid"] === "string" ? { targetUid: opts["targetUid"] } : {}),
      ...(typeof opts["filePath"] === "string" ? { filePath: opts["filePath"] } : {}),
      ...(typeof opts["kind"] === "string" ? { kind: opts["kind"] } : {}),
    });
  });

program
  .command("impact <symbol>")
  .description("Blast-radius analysis for a symbol")
  .option("--depth <n>", "Max traversal depth", (v) => Number.parseInt(v, 10), 3)
  .option("--direction <dir>", "up | down | both", "both")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout")
  .option(
    "--target-uid <id>",
    "Exact node id from a prior result; bypasses name-based disambiguation",
  )
  .option("--file-path <hint>", "File path (or suffix) to disambiguate same-named symbols")
  .option("--kind <kind>", "Kind filter (Function, Method, Class, Interface, …)")
  .action(async (symbol: string, opts: Record<string, unknown>) => {
    const mod = await import("./commands/impact.js");
    const directionRaw = typeof opts["direction"] === "string" ? opts["direction"] : "both";
    const direction: "up" | "down" | "both" =
      directionRaw === "up" || directionRaw === "down" ? directionRaw : "both";
    await mod.runImpact(symbol, {
      depth: typeof opts["depth"] === "number" ? opts["depth"] : 3,
      direction,
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      json: opts["json"] === true,
      ...(typeof opts["targetUid"] === "string" ? { targetUid: opts["targetUid"] } : {}),
      ...(typeof opts["filePath"] === "string" ? { filePath: opts["filePath"] } : {}),
      ...(typeof opts["kind"] === "string" ? { kind: opts["kind"] } : {}),
    });
  });

program
  .command("detect-changes")
  .description(
    "Map an uncommitted or committed diff onto affected graph symbols + processes. Useful in CI without launching the MCP server.",
  )
  .option(
    "--scope <scope>",
    "unstaged | staged | all | compare  (default: all = working tree + index)",
    "all",
  )
  .option(
    "--compare-ref <ref>",
    "Git ref to compare against (required when --scope=compare, e.g. origin/main)",
  )
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout")
  .option("--strict", "Exit 1 on MEDIUM+ risk (default: exit 1 only on HIGH / CRITICAL)")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/detect-changes.js");
    const rawScope = typeof opts["scope"] === "string" ? opts["scope"] : "all";
    const scope: "unstaged" | "staged" | "all" | "compare" =
      rawScope === "unstaged" || rawScope === "staged" || rawScope === "compare" ? rawScope : "all";
    if (rawScope !== scope && rawScope !== "all") {
      throw new Error(
        `Unknown --scope value: "${rawScope}". Expected one of: unstaged, staged, all, compare`,
      );
    }
    await mod.runDetectChangesCmd({
      scope,
      ...(typeof opts["compareRef"] === "string" ? { compareRef: opts["compareRef"] } : {}),
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      json: opts["json"] === true,
      strict: opts["strict"] === true,
    });
  });

program
  .command("verdict")
  .description("5-tier PR verdict (auto_merge|single_review|dual_review|expert_review|block)")
  .option("--base <ref>", "Base git ref", "main")
  .option("--head <ref>", "Head git ref", "HEAD")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout instead of the default text summary")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/verdict.js");
    await mod.runVerdict({
      base: typeof opts["base"] === "string" ? opts["base"] : "main",
      head: typeof opts["head"] === "string" ? opts["head"] : "HEAD",
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("change-pack")
  .description(
    "Diff-scoped change-pack: impacted subgraph + verdict + affected tests + cost estimate (CLI sibling of the change_pack MCP tool)",
  )
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--base <ref>", "Base git ref (default: main)")
  .option("--head <ref>", "Head git ref (default: HEAD)")
  .option("--depth <n>", "Upstream traversal depth (default: 4)", (v) => Number.parseInt(v, 10))
  .option("--min-confidence <f>", "Traversal confidence floor 0-1 (default: 0.7)", (v) =>
    Number.parseFloat(v),
  )
  .option("--budget <n>", "Context budget in heuristic tokens (default: 100000)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--include-tests-in-subgraph", "Retain test nodes in the impacted subgraph")
  .option("--json", "Emit JSON on stdout")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/change-pack.js");
    await mod.runChangePackCmd({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(typeof opts["base"] === "string" ? { base: opts["base"] } : {}),
      ...(typeof opts["head"] === "string" ? { head: opts["head"] } : {}),
      ...(typeof opts["depth"] === "number" ? { depth: opts["depth"] } : {}),
      ...(typeof opts["minConfidence"] === "number"
        ? { minConfidence: opts["minConfidence"] }
        : {}),
      ...(typeof opts["budget"] === "number" ? { budget: opts["budget"] } : {}),
      ...(opts["includeTestsInSubgraph"] === true ? { includeTestsInSubgraph: true } : {}),
      json: opts["json"] === true,
    });
  });

// `codehub group ...` — cross-repo groups. We register placeholder
// subcommands so `commander` routes the invocation correctly, and load the
// real handler lazily on .action(). This keeps `codehub --help` snappy.
{
  const group = program.command("group").description("Manage named cross-repo groups");
  group
    .command("create <name> <repos...>")
    .description("Create a group from registered repo names")
    .option("--description <text>", "Short human-readable description")
    .action(async (name: string, repos: string[], opts: Record<string, unknown>) => {
      const mod = await import("./commands/group.js");
      await mod.runGroupCreate(name, repos, {
        ...(typeof opts["description"] === "string" ? { description: opts["description"] } : {}),
      });
    });
  group
    .command("list")
    .description("List all groups")
    .action(async () => {
      const mod = await import("./commands/group.js");
      await mod.runGroupList();
    });
  group
    .command("delete <name>")
    .description("Delete a group")
    .action(async (name: string) => {
      const mod = await import("./commands/group.js");
      await mod.runGroupDelete(name);
    });
  group
    .command("status <name>")
    .description("Per-repo index freshness within a group")
    .action(async (name: string) => {
      const mod = await import("./commands/group.js");
      await mod.runGroupStatus(name);
    });
  group
    .command("query <name> <text>")
    .description("BM25 over every repo in the group, fused with RRF")
    .option("--limit <n>", "Max results (default 20)", (v) => Number.parseInt(v, 10), 20)
    .option("--json", "Emit JSON on stdout")
    .action(async (name: string, text: string, opts: Record<string, unknown>) => {
      const mod = await import("./commands/group.js");
      await mod.runGroupQuery(name, text, {
        limit: typeof opts["limit"] === "number" ? opts["limit"] : 20,
        json: opts["json"] === true,
      });
    });
  group
    .command("sync <name>")
    .description(
      "Extract cross-repo HTTP / gRPC / topic contracts and write ~/.codehub/groups/<name>/contracts.json",
    )
    .option("--json", "Emit the written registry on stdout")
    .action(async (name: string, opts: Record<string, unknown>) => {
      const mod = await import("./commands/group.js");
      await mod.runGroupSyncCmd(name, {
        json: opts["json"] === true,
      });
    });
}

program
  .command("ingest-sarif <sarifFile>")
  .description("Ingest a SARIF 2.1.0 log into the graph as Finding nodes + FOUND_IN edges")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .action(async (sarifFile: string, opts: Record<string, unknown>) => {
    const mod = await import("./commands/ingest-sarif.js");
    await mod.runIngestSarif(sarifFile, {
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
    });
  });

program
  .command("scan [path]")
  .description("Run Priority-1 scanners and ingest findings into the graph")
  .option("--scanners <list>", "Comma-separated scanner ids (overrides profile gating)")
  .option("--with <list>", "Additional scanner ids to include (comma-separated)")
  .option("--output <file>", "SARIF output path (default: <repo>/.codehub/scan.sarif)")
  .option("--severity <list>", "Severity levels that fail the run (default: HIGH,CRITICAL)")
  .option("--repo <name>", "Registered repo name (default: [path] or current directory)")
  .option("--concurrency <n>", "Max parallel scanners", (v) => Number.parseInt(v, 10))
  .option("--timeout <ms>", "Per-scanner timeout in ms", (v) => Number.parseInt(v, 10))
  .action(async (path: string | undefined, opts: Record<string, unknown>) => {
    const mod = await import("./commands/scan.js");
    const scanners = typeof opts["scanners"] === "string" ? splitList(opts["scanners"]) : undefined;
    const withScanners = typeof opts["with"] === "string" ? splitList(opts["with"]) : undefined;
    const severity = typeof opts["severity"] === "string" ? splitList(opts["severity"]) : undefined;
    const summary = await mod.runScan(path ?? process.cwd(), {
      ...(scanners !== undefined ? { scanners } : {}),
      ...(withScanners !== undefined ? { withScanners } : {}),
      ...(severity !== undefined ? { severity } : {}),
      ...(typeof opts["output"] === "string" ? { output: opts["output"] } : {}),
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(typeof opts["concurrency"] === "number" ? { concurrency: opts["concurrency"] } : {}),
      ...(typeof opts["timeout"] === "number" ? { timeoutMs: opts["timeout"] } : {}),
    });
    if (summary.exitCode !== 0) {
      process.exitCode = summary.exitCode;
    }
  });

program
  .command("doctor")
  .description(
    "Probe the local environment (node/pnpm/native bindings/vendored grammars/scip indexers/scanners/registry) and print actionable hints",
  )
  .option(
    "--skip-native",
    "Skip checks that require native bindings (no longer any; retained for compat)",
  )
  .option(
    "--strict",
    "Treat a missing SCIP indexer as a failure (exit 2), not a warning — for release/CI gates",
  )
  .option(
    "--repoRoot <path>",
    "Override the workspace root used as a fallback for native-binding resolution",
  )
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const mod = await import("./commands/doctor.js");
    await mod.runDoctor({
      skipNative: opts["skipNative"] === true,
      strict: opts["strict"] === true,
      ...(typeof opts["repoRoot"] === "string" && opts["repoRoot"].length > 0
        ? { repoRoot: opts["repoRoot"] }
        : {}),
    });
  });

program
  .command("bench")
  .description(
    "Run the acceptance gate suite (scripts/acceptance.sh) and render a pass/fail dashboard",
  )
  .option("--acceptance <path>", "Override the path to scripts/acceptance.sh")
  .option("--silent", "Suppress the listr2 progress renderer (useful in CI)")
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const mod = await import("./commands/bench.js");
    await mod.runBench({
      ...(typeof opts["acceptance"] === "string" ? { acceptanceScript: opts["acceptance"] } : {}),
      silent: opts["silent"] === true,
    });
  });

program
  .command("wiki")
  .description(
    "Emit a Markdown wiki under --output (deterministic by default; --llm for LLM prose)",
  )
  .requiredOption("--output <dir>", "Target directory for rendered pages")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit a JSON summary on stdout")
  .option("--offline", "Assert no network access (incompatible with --llm)")
  .option("--llm", "Route top-ranked modules through @opencodehub/summarizer for narrative prose")
  .option(
    "--max-llm-calls <n>",
    "Cap on Bedrock summarizer calls when --llm is set. 0 (default) runs in dry-run mode",
    (v) => Number.parseInt(v, 10),
    0,
  )
  .option("--llm-model <id>", "Override the Bedrock model id passed to the summarizer")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/wiki.js");
    const output = typeof opts["output"] === "string" ? opts["output"] : "";
    if (output.length === 0) {
      throw new Error("--output <dir> is required");
    }
    const maxLlmCallsRaw = opts["maxLlmCalls"];
    const maxLlmCalls =
      typeof maxLlmCallsRaw === "number" && Number.isFinite(maxLlmCallsRaw)
        ? Math.max(0, Math.floor(maxLlmCallsRaw))
        : 0;
    await mod.runWiki({
      output,
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      json: opts["json"] === true,
      offline: opts["offline"] === true,
      llm: opts["llm"] === true,
      maxLlmCalls,
      ...(typeof opts["llmModel"] === "string" ? { llmModel: opts["llmModel"] } : {}),
    });
  });

program
  .command("ci-init")
  .description("Emit opinionated CI workflow files for GitHub Actions and/or GitLab CI")
  .option("--platform <p>", "Target platform: github | gitlab | both (default: auto-detect)")
  .option("--main-branch <b>", "Name of the main branch", "main")
  .option("--repo <path>", "Repo root (default: current directory)")
  .option("--force", "Overwrite existing workflow files")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/ci-init.js");
    const rawPlatform = typeof opts["platform"] === "string" ? opts["platform"] : undefined;
    const platform: "github" | "gitlab" | "both" | undefined =
      rawPlatform === "github" || rawPlatform === "gitlab" || rawPlatform === "both"
        ? rawPlatform
        : undefined;
    if (rawPlatform !== undefined && platform === undefined) {
      throw new Error(
        `Unknown --platform value: ${rawPlatform}. Expected one of: github, gitlab, both.`,
      );
    }
    await mod.runCiInit({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(platform !== undefined ? { platform } : {}),
      ...(typeof opts["mainBranch"] === "string" ? { mainBranch: opts["mainBranch"] } : {}),
      force: opts["force"] === true,
    });
  });

program
  .command("augment <pattern>")
  .description(
    "Fast-path BM25 enrichment for editor PreToolUse hooks — writes a compact context block to stderr",
  )
  .option("--limit <n>", "Max hits to enrich (default 5)", (v) => Number.parseInt(v, 10), 5)
  .action(async (pattern: string, opts: Record<string, unknown>) => {
    const mod = await import("./commands/augment.js");
    await mod.runAugment(pattern, {
      limit: typeof opts["limit"] === "number" ? opts["limit"] : 5,
    });
  });

program
  .command("sql <query>")
  .description(
    "Run a read-only SQL query against the temporal store (cochanges + symbol_summaries); the node/edge graph is queried via the typed tools or Cypher",
  )
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--timeout <ms>", "Per-query timeout in ms", (v) => Number.parseInt(v, 10), 5_000)
  .option("--json", "Emit JSON on stdout")
  .action(async (query: string, opts: Record<string, unknown>) => {
    const mod = await import("./commands/sql.js");
    await mod.runSql(query, {
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      timeoutMs: typeof opts["timeout"] === "number" ? opts["timeout"] : 5_000,
      json: opts["json"] === true,
    });
  });

// --- read-only graph capabilities (CLI siblings of the MCP tools) ----------
// Each reuses the same underlying logic as its MCP tool (a shared
// `@opencodehub/analysis` fn or an IGraphStore/ITemporalStore reader),
// following the `verdict` CLI↔MCP shared-function pattern.

program
  .command("findings")
  .description("List SARIF Finding nodes (sibling of the MCP list_findings tool)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--severity <level>", "Restrict to one SARIF severity: error | warning | note | none")
  .option("--scanner <id>", "Restrict to a single scanner id (e.g. 'semgrep')")
  .option("--rule-id <id>", "Restrict to a single rule id")
  .option("--file-path <hint>", "Substring filter on the finding's file path")
  .option("--limit <n>", "Maximum findings to return", (v) => Number.parseInt(v, 10), 500)
  .option("--json", "Emit JSON on stdout")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/findings.js");
    const sev = opts["severity"];
    await mod.runFindings({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(sev === "error" || sev === "warning" || sev === "note" || sev === "none"
        ? { severity: sev }
        : {}),
      ...(typeof opts["scanner"] === "string" ? { scanner: opts["scanner"] } : {}),
      ...(typeof opts["ruleId"] === "string" ? { ruleId: opts["ruleId"] } : {}),
      ...(typeof opts["filePath"] === "string" ? { filePath: opts["filePath"] } : {}),
      ...(typeof opts["limit"] === "number" ? { limit: opts["limit"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("dead-code")
  .description("List dead and unreachable-export symbols (sibling of MCP list_dead_code)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--file-path-pattern <hint>", "Substring filter on each symbol's file path")
  .option("--include-unreachable-exports", "Also include exported-but-unreferenced symbols")
  .option("--limit <n>", "Maximum symbols to return", (v) => Number.parseInt(v, 10), 100)
  .option("--json", "Emit JSON on stdout")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/dead-code.js");
    await mod.runDeadCode({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(typeof opts["filePathPattern"] === "string"
        ? { filePathPattern: opts["filePathPattern"] }
        : {}),
      includeUnreachableExports: opts["includeUnreachableExports"] === true,
      ...(typeof opts["limit"] === "number" ? { limit: opts["limit"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("license-audit")
  .description("Classify Dependency nodes by license risk tier (sibling of MCP license_audit)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/license-audit.js");
    await mod.runLicenseAudit({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("project-profile")
  .description("Show the detected project profile (sibling of MCP project_profile)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/project-profile.js");
    await mod.runProjectProfile({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("risk-trends")
  .description("Per-community risk trend + 30-day projection (sibling of MCP risk_trends)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/risk-trends.js");
    await mod.runRiskTrends({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(typeof opts["home"] === "string" ? { home: opts["home"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("owners <target>")
  .description("List ranked OWNED_BY contributors for a node (sibling of MCP owners)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--limit <n>", "Maximum contributors to return", (v) => Number.parseInt(v, 10), 20)
  .option("--json", "Emit JSON on stdout")
  .action(async (target: string, opts: Record<string, unknown>) => {
    const mod = await import("./commands/owners.js");
    await mod.runOwners(target, {
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(typeof opts["limit"] === "number" ? { limit: opts["limit"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("route-map")
  .description("Map HTTP routes to handlers and consumers (sibling of MCP route_map)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--route <hint>", "Substring match against Route.url (e.g. '/api/users')")
  .option("--method <verb>", "Exact match against Route.method (e.g. 'GET')")
  .option("--json", "Emit JSON on stdout")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/route-map.js");
    await mod.runRouteMap({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(typeof opts["route"] === "string" ? { route: opts["route"] } : {}),
      ...(typeof opts["method"] === "string" ? { method: opts["method"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("api-impact")
  .description("Score the blast radius of changing a Route's contract (sibling of MCP api_impact)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--route <hint>", "Substring match against Route.url")
  .option("--file <hint>", "Substring match against Route.filePath")
  .option("--json", "Emit JSON on stdout")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/api-impact.js");
    await mod.runApiImpact({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(typeof opts["route"] === "string" ? { route: opts["route"] } : {}),
      ...(typeof opts["file"] === "string" ? { file: opts["file"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("dependencies")
  .description("List external dependencies (sibling of MCP dependencies)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--ecosystem <id>", "Restrict to one ecosystem: npm | pypi | go | cargo | maven | nuget")
  .option("--file-path <hint>", "Substring filter on the manifest/lockfile path")
  .option("--limit <n>", "Maximum dependencies to return", (v) => Number.parseInt(v, 10), 500)
  .option("--json", "Emit JSON on stdout")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/dependencies.js");
    const eco = opts["ecosystem"];
    await mod.runDependencies({
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      ...(eco === "npm" ||
      eco === "pypi" ||
      eco === "go" ||
      eco === "cargo" ||
      eco === "maven" ||
      eco === "nuget"
        ? { ecosystem: eco }
        : {}),
      ...(typeof opts["filePath"] === "string" ? { filePath: opts["filePath"] } : {}),
      ...(typeof opts["limit"] === "number" ? { limit: opts["limit"] } : {}),
      json: opts["json"] === true,
    });
  });

function splitList(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse the single-value `--granularity` flag used by `codehub query`.
 * Accepts exactly one tier (symbol/file/community); rejects CSV lists.
 */
function parseQueryGranularity(raw: unknown): "symbol" | "file" | "community" | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "symbol" || trimmed === "file" || trimmed === "community") return trimmed;
  throw new Error(
    `Unknown --granularity value: "${trimmed}". Expected one of: symbol, file, community`,
  );
}

/**
 * Parse a `--harness` value into the narrow agent set the variance probe
 * accepts. Returns `undefined` when the flag was not supplied (the probe then
 * runs the task's configured set — both agents by default). An unknown token
 * throws so the user sees the typo rather than a silent fallback.
 */
function parseHarness(raw: unknown): "claude" | "codex" | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "claude" || trimmed === "codex") return trimmed;
  throw new Error(`Unknown --harness value: "${trimmed}". Expected one of: claude, codex`);
}

/**
 * Parse a comma-separated `--granularity` value into the narrow set of
 * hierarchical embedding tiers the ingestion phase accepts. Returns
 * `undefined` when the flag was not supplied so callers can preserve the
 * upstream default (`["symbol"]`). Unknown tokens throw so users see the
 * typo rather than a silent fallback.
 */
function parseGranularityCsv(
  raw: unknown,
): readonly ("symbol" | "file" | "community")[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const valid = new Set(["symbol", "file", "community"] as const);
  const out: ("symbol" | "file" | "community")[] = [];
  const seen = new Set<string>();
  for (const token of splitList(raw)) {
    if (!valid.has(token as "symbol")) {
      throw new Error(
        `Unknown granularity tier: "${token}". Expected one of: ${[...valid].join(", ")}`,
      );
    }
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token as "symbol");
  }
  return out;
}

/**
 * Parse the `--allow-build-scripts` CSV flag for `codehub analyze`. Today
 * the only recognized token is `proleap` (JVM COBOL deep-parse); unknown
 * tokens throw so a typo surfaces immediately instead of silently leaving
 * the build-script path disabled.
 *
 * Returns `undefined` when the flag is not supplied so the analyze pipeline
 * preserves its own default ("regex hot path only, no JVM").
 */
function parseAllowBuildScripts(raw: unknown): readonly "proleap"[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const valid = new Set(["proleap"] as const);
  const out: "proleap"[] = [];
  const seen = new Set<string>();
  for (const token of splitList(raw)) {
    if (!valid.has(token as "proleap")) {
      throw new Error(
        `Unknown --allow-build-scripts value: "${token}". Expected one of: ${[...valid].join(", ")}`,
      );
    }
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token as "proleap");
  }
  return out;
}

/**
 * Parse `--embeddings-workers`. Accepts a positive integer or the literal
 * "auto" (resolves to `os.cpus().length - 1`, floor 1). Returns undefined
 * when the flag wasn't supplied so the pipeline picks its own default.
 */
function parseWorkerCount(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === "auto") {
    return Math.max(1, cpus().length - 1);
  }
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      `--embeddings-workers must be a positive integer or "auto"; got "${String(raw)}"`,
    );
  }
  return Math.floor(parsed);
}

/** Parse a positive integer CLI flag, returning undefined when omitted. */
function parsePositiveInt(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`expected a positive integer; got "${String(raw)}"`);
  }
  return Math.floor(parsed);
}

function parseEditors(
  raw: string,
): readonly ("claude-code" | "cursor" | "codex" | "windsurf" | "opencode")[] {
  const valid = new Set(["claude-code", "cursor", "codex", "windsurf", "opencode"] as const);
  const out: ("claude-code" | "cursor" | "codex" | "windsurf" | "opencode")[] = [];
  for (const token of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (valid.has(token as "claude-code")) {
      out.push(token as "claude-code");
    } else {
      throw new Error(`Unknown editor id: ${token}. Expected one of: ${[...valid].join(", ")}`);
    }
  }
  return out;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`codehub: ${message}`);
  process.exitCode = 1;
});
