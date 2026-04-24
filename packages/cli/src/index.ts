#!/usr/bin/env node
/**
 * `codehub` CLI entrypoint.
 *
 * Every subcommand is loaded lazily via `await import(...)` so that
 * `codehub --help` (and `codehub <command> --help`) stays fast: no DuckDB
 * native binding, no pipeline, no MCP SDK unless we are actually going to
 * run that subcommand.
 */

import { Command } from "commander";

const program = new Command()
  .name("codehub")
  .version("0.0.0")
  .description("OpenCodeHub — code-graph indexer and MCP server for coding agents");

program
  .command("analyze [path]")
  .description("Index a repository at [path] (default: current directory)")
  .option("--force", "Ignore registry cache and re-run the pipeline")
  .option("--embeddings", "Embed symbols and populate the DuckDB embeddings table")
  .option("--embeddings-int8", "Use the int8 embedder variant (~23 MB) instead of fp32")
  .option("--offline", "Assert no network access during analyze")
  .option("--verbose", "Emit per-phase pipeline progress")
  .option("--skip-agents-md", "Do not write the AGENTS.md / CLAUDE.md stanza")
  .option(
    "--sbom",
    "Emit .codehub/sbom.cyclonedx.json + .codehub/sbom.spdx.json from Dependency nodes",
  )
  .option("--coverage", "Overlay lcov/cobertura/jacoco/coverage.py report onto File nodes")
  .option(
    "--summaries",
    "Enable the summarize phase (default ON: structured Bedrock summaries per callable). Use --no-summaries to disable.",
  )
  .option(
    "--no-summaries",
    "Disable the summarize phase entirely (equivalent to CODEHUB_BEDROCK_DISABLED=1).",
  )
  .option(
    "--max-summaries <n|auto>",
    'Cap on Bedrock summarize calls per run. "auto" (default) scales the cap to 10% of the LSP-confirmed callable count (max 500).',
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
  .action(async (path: string | undefined, opts: Record<string, unknown>) => {
    const mod = await import("./commands/analyze.js");
    // Pass the raw flag straight through to `runAnalyze`. The env
    // kill-switch (`CODEHUB_BEDROCK_DISABLED=1`) is re-checked inside
    // `runAnalyze` via `resolveSummariesEnabled` so tests that call
    // `runAnalyze` directly honor the same truth table.
    const summaries = opts["summaries"] === false ? false : undefined;

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

    await mod.runAnalyze(path ?? process.cwd(), {
      force: opts["force"] === true,
      embeddings: opts["embeddings"] === true,
      embeddingsVariant: opts["embeddingsInt8"] === true ? "int8" : "fp32",
      offline: opts["offline"] === true,
      verbose: opts["verbose"] === true,
      skipAgentsMd: opts["skipAgentsMd"] === true,
      sbom: opts["sbom"] === true,
      coverage: opts["coverage"] === true,
      ...(summaries === false ? { summaries } : {}),
      maxSummariesPerRun,
      ...(typeof opts["summaryModel"] === "string"
        ? { summaryModel: opts["summaryModel"] }
        : {}),
      skills: opts["skills"] === true,
    });
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
  .command("setup")
  .description("Write MCP config entries for supported editors, or download embedder weights")
  .option(
    "--editors <list>",
    "Comma-separated editor ids (claude-code,cursor,codex,windsurf,opencode). Default: all",
  )
  .option("--force", "Overwrite an existing codehub entry without prompting; re-download weights")
  .option("--undo", "Restore the most recent .bak next to each config")
  .option("--embeddings", "Download Arctic Embed XS ONNX weights (SHA256-pinned)")
  .option("--int8", "Use the int8 weight variant (~23 MB) instead of fp32 (~90 MB)")
  .option("--model-dir <path>", "Override the target directory for embedder weights")
  .option("--plugin", "Install the Claude Code plugin to ~/.claude/plugins/opencodehub/")
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const mod = await import("./commands/setup.js");
    if (opts["plugin"] === true) {
      await mod.runSetupPlugin({});
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
  .option(
    "--rerank-top-k <n>",
    "RRF top-k passed to hybrid fusion (default 50)",
    (v) => Number.parseInt(v, 10),
  )
  .action(async (text: string, opts: Record<string, unknown>) => {
    const mod = await import("./commands/query.js");
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
    });
  });

program
  .command("context <symbol>")
  .description("360° view of a symbol (callers, callees, flows)")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout")
  .action(async (symbol: string, opts: Record<string, unknown>) => {
    const mod = await import("./commands/context.js");
    await mod.runContext(symbol, {
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
      json: opts["json"] === true,
    });
  });

program
  .command("impact <symbol>")
  .description("Blast-radius analysis for a symbol")
  .option("--depth <n>", "Max traversal depth", (v) => Number.parseInt(v, 10), 3)
  .option("--direction <dir>", "up | down | both", "both")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout")
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
    });
  });

program
  .command("verdict")
  .description("5-tier PR verdict (auto_merge|single_review|dual_review|expert_review|block)")
  .option("--base <ref>", "Base git ref", "main")
  .option("--head <ref>", "Head git ref", "HEAD")
  .option("--repo <name>", "Registered repo name (default: current directory)")
  .option("--json", "Emit JSON on stdout instead of Markdown")
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/verdict.js");
    await mod.runVerdict({
      base: typeof opts["base"] === "string" ? opts["base"] : "main",
      head: typeof opts["head"] === "string" ? opts["head"] : "HEAD",
      ...(typeof opts["repo"] === "string" ? { repo: opts["repo"] } : {}),
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
    "Probe the local environment (node/pnpm/native bindings/scanners/registry) and print actionable hints",
  )
  .option("--skip-native", "Skip checks that require native bindings (duckdb / tree-sitter)")
  .option(
    "--repoRoot <path>",
    "Override the workspace root used as a fallback for native-binding resolution",
  )
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const mod = await import("./commands/doctor.js");
    await mod.runDoctor({
      skipNative: opts["skipNative"] === true,
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
  .command("eval-server")
  .description(
    "Persistent loopback HTTP daemon (127.0.0.1) wrapping MCP tool handlers " +
      "with text-formatted output plus next-step hints. Designed for SWE-bench-style " +
      "agent loops that need a warm graph between tool calls.",
  )
  .option("--port <n>", "Port to listen on (default 4848)", (v) => Number.parseInt(v, 10), 4848)
  .option(
    "--idle-timeout <s>",
    "Auto-shutdown after N seconds of inactivity (default 900)",
    (v) => Number.parseInt(v, 10),
    900,
  )
  .action(async (opts: Record<string, unknown>) => {
    const mod = await import("./commands/eval-server.js");
    await mod.runEvalServer({
      port: typeof opts["port"] === "number" ? opts["port"] : 4848,
      idleTimeoutSec: typeof opts["idleTimeout"] === "number" ? opts["idleTimeout"] : 900,
    });
  });

program
  .command("sql <query>")
  .description("Run a read-only SQL query against the graph store")
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

function splitList(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
