/**
 * Direct-CLI runner (spec 010 §4, §4a) — v1's {@link AgentRunner}.
 *
 * Shells out to `claude -p` (Claude Code) and `codex exec` (Codex) in headless
 * mode, with **inference routed through Amazon Bedrock** for both. The Bedrock
 * env/flag wiring is grounded against current docs (code.claude.com,
 * developers.openai.com/codex), not recalled:
 *
 *   Claude Code → Bedrock:
 *     env  CLAUDE_CODE_USE_BEDROCK=1, AWS_REGION, ANTHROPIC_MODEL=<us.-profile>
 *     cmd  claude -p "<prompt>" --output-format json --model <profile>
 *     out  one JSON object: .result, .usage.{input,output}_tokens, .total_cost_usd
 *
 *   Codex → Bedrock (first-party `amazon-bedrock` provider):
 *     env  AWS_REGION (+ AWS_BEARER_TOKEN_BEDROCK or AWS SDK creds)
 *     cmd  codex exec --json -c model_provider=amazon-bedrock -m <model>
 *            --skip-git-repo-check "<prompt>"
 *     out  JSONL; final = last item.completed type "agent_message"; tokens =
 *          last turn.completed.usage (no total — sum input+output)
 *
 * The pure pieces (env construction, prompt composition, output parsing) are
 * exported and unit-tested; the spawn itself is integration-only (needs the
 * CLIs + AWS creds, which CI sandboxes lack) and is exercised via the
 * `_spawn` seam in tests.
 */

import { spawn } from "node:child_process";
import type { AgentRunner, Harness, RunOutcome, RunRequest, RunTokens } from "./runner.js";

/** Default Claude Code Bedrock inference profile (us.-prefixed, §4a). */
export const DEFAULT_CLAUDE_MODEL = "us.anthropic.claude-sonnet-4-6";
/** Default Codex Bedrock model id (§4a). */
export const DEFAULT_CODEX_MODEL = "openai.gpt-5.5";

export interface CliRunnerConfig {
  readonly harness: Harness;
  /**
   * Bedrock model id / inference profile. Defaults per harness
   * ({@link DEFAULT_CLAUDE_MODEL} / {@link DEFAULT_CODEX_MODEL}).
   */
  readonly model?: string;
  /**
   * AWS region for Bedrock. Falls back to the inherited `AWS_REGION` /
   * `AWS_DEFAULT_REGION`; an explicit value here overrides it.
   */
  readonly awsRegion?: string;
  /**
   * Test seam — inject a spawn function so unit tests don't shell out to the
   * real CLIs. Production leaves this unset.
   */
  readonly _spawn?: SpawnFn;
  /**
   * Test seam — inject the base environment (defaults to `process.env`) so
   * tests can assert the Bedrock vars are layered on without depending on the
   * host env.
   */
  readonly _baseEnv?: NodeJS.ProcessEnv;
}

/** Minimal spawn result the runner consumes. */
export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Process exit code; null on signal termination. */
  readonly code: number | null;
}

/** Spawn function shape (the `_spawn` seam). */
export type SpawnFn = (args: {
  readonly command: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: string;
}) => Promise<SpawnResult>;

/**
 * Build the child-process environment for a harness, layering the Bedrock
 * wiring (§4a) over the inherited base env. Pure + exported for tests.
 */
export function buildAgentEnv(config: CliRunnerConfig): NodeJS.ProcessEnv {
  const base = config._baseEnv ?? process.env;
  const region = config.awsRegion ?? base["AWS_REGION"] ?? base["AWS_DEFAULT_REGION"];
  const env: NodeJS.ProcessEnv = { ...base };
  if (region !== undefined) env["AWS_REGION"] = region;

  if (config.harness === "claude") {
    // Claude Code → Bedrock. Credentials resolve via the default AWS SDK chain
    // already present in `base` (env keys / AWS_PROFILE / SSO / bearer token);
    // we only assert the toggle + model.
    env["CLAUDE_CODE_USE_BEDROCK"] = "1";
    env["ANTHROPIC_MODEL"] = config.model ?? DEFAULT_CLAUDE_MODEL;
  }
  // Codex selects Bedrock via `-c model_provider=amazon-bedrock` on the
  // argv (see buildArgv), not via env; its AWS auth is inherited from base.
  return env;
}

/**
 * Compose the prompt handed to the agent. The with-pack arm prepends the OCH
 * pack context; the without-pack arm is the bare instruction. Pure + exported.
 */
export function composePrompt(request: RunRequest): string {
  if (request.withPack && request.packContext !== undefined && request.packContext.length > 0) {
    return `${request.packContext}\n\n---\n\n${request.task.instruction}`;
  }
  return request.task.instruction;
}

/** Build the argv for a harness invocation. Pure + exported for tests. */
export function buildArgv(
  config: CliRunnerConfig,
  prompt: string,
): { command: string; argv: string[] } {
  if (config.harness === "claude") {
    return {
      command: "claude",
      argv: [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--model",
        config.model ?? DEFAULT_CLAUDE_MODEL,
      ],
    };
  }
  // Codex: route to the first-party Bedrock provider via -c, pin the model,
  // emit JSONL with --json, and skip the git-repo guard so the probe can run
  // the agent against an arbitrary checkout.
  return {
    command: "codex",
    argv: [
      "exec",
      "--json",
      "-c",
      "model_provider=amazon-bedrock",
      "-m",
      config.model ?? DEFAULT_CODEX_MODEL,
      "--skip-git-repo-check",
      prompt,
    ],
  };
}

/**
 * Parse Claude Code's `--output-format json` single result object into a
 * {@link RunOutcome} (minus checkout/errored, filled by the runner). Pure +
 * exported. Throws on unparseable output so a malformed run is a hard error,
 * not a silent zero-token success.
 */
export function parseClaudeOutput(stdout: string): { finalText: string; tokens: RunTokens } {
  const doc = JSON.parse(stdout) as {
    result?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
    total_cost_usd?: unknown;
  };
  const finalText = typeof doc.result === "string" ? doc.result : "";
  const inputTokens = num(doc.usage?.input_tokens);
  const outputTokens = num(doc.usage?.output_tokens);
  const costUsd = typeof doc.total_cost_usd === "number" ? doc.total_cost_usd : null;
  return { finalText, tokens: { inputTokens, outputTokens, costUsd } };
}

/**
 * Parse Codex's `--json` JSONL stream. Final answer = the last
 * `item.completed` whose item type is `agent_message`; tokens = the last
 * `turn.completed.usage` (Codex reports no total — we sum input+output). Pure +
 * exported. Tolerates interleaved non-JSON lines (progress noise) by skipping
 * them.
 */
export function parseCodexOutput(stdout: string): { finalText: string; tokens: RunTokens } {
  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue; // progress / non-JSON line — skip
    }
    if (typeof evt !== "object" || evt === null) continue;
    const e = evt as {
      type?: unknown;
      item?: { type?: unknown; text?: unknown };
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    if (e.type === "item.completed" && e.item?.type === "agent_message") {
      if (typeof e.item.text === "string") finalText = e.item.text;
    } else if (e.type === "turn.completed" && e.usage !== undefined) {
      inputTokens = num(e.usage.input_tokens);
      outputTokens = num(e.usage.output_tokens);
    }
  }
  // Codex does not surface a per-invocation USD cost on the public event
  // schema, so cost is null (the report tolerates a null-cost arm).
  return { finalText, tokens: { inputTokens, outputTokens, costUsd: null } };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Default production spawn — real `node:child_process.spawn`, buffered. */
const defaultSpawn: SpawnFn = ({ command, argv, env, cwd, stdin }) =>
  new Promise<SpawnResult>((resolve) => {
    const child = spawn(command, [...argv], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      // Binary missing / not executable — surface as a non-zero result rather
      // than rejecting, so the runner can wrap it in an actionable error.
      resolve({ stdout, stderr: `${stderr}${String(err)}`, code: 127 });
    });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    if (stdin.length > 0) child.stdin.write(stdin);
    child.stdin.end();
  });

/**
 * The direct-CLI runner. Each `run` spawns a fresh agent process (a fresh
 * session, per §3), composes the arm-appropriate prompt, parses the harness's
 * structured output, and returns a {@link RunOutcome}. A spawn/exit failure is
 * captured as an `errored` outcome rather than throwing, so one crashed run
 * doesn't abort the experiment — a pack that reduces crashes is lower variance.
 */
export class CliAgentRunner implements AgentRunner {
  readonly name: string;
  private readonly config: CliRunnerConfig;
  private readonly spawnFn: SpawnFn;

  constructor(config: CliRunnerConfig) {
    this.config = config;
    this.name = `cli:${config.harness}`;
    this.spawnFn = config._spawn ?? defaultSpawn;
  }

  async run(request: RunRequest): Promise<RunOutcome> {
    const prompt = composePrompt(request);
    const { command, argv } = buildArgv(this.config, prompt);
    const env = buildAgentEnv(this.config);
    // The checkout the agent works in. v1 runs the agent against the task's
    // repo path directly; a future iteration can clone per-run for isolation.
    const cwd = request.task.repo;

    let result: SpawnResult;
    try {
      result = await this.spawnFn({ command, argv, env, cwd, stdin: "" });
    } catch (err) {
      return erroredOutcome(cwd, `spawn failed: ${String(err)}`);
    }

    if (result.code !== 0) {
      return erroredOutcome(cwd, result.stderr || `${command} exited ${String(result.code)}`);
    }

    try {
      const parsed =
        this.config.harness === "claude"
          ? parseClaudeOutput(result.stdout)
          : parseCodexOutput(result.stdout);
      return {
        finalText: parsed.finalText,
        diff: "", // neither CLI surfaces a structured diff in headless JSON; left empty
        tokens: parsed.tokens,
        checkoutPath: cwd,
        errored: false,
      };
    } catch (err) {
      return erroredOutcome(cwd, `failed to parse ${command} output: ${String(err)}`);
    }
  }
}

function erroredOutcome(checkoutPath: string, finalText: string): RunOutcome {
  return {
    finalText,
    diff: "",
    tokens: { inputTokens: 0, outputTokens: 0, costUsd: null },
    checkoutPath,
    errored: true,
  };
}
