import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildAgentEnv,
  buildArgv,
  CliAgentRunner,
  composePrompt,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  parseClaudeOutput,
  parseCodexOutput,
  type SpawnFn,
} from "./cli-runner.js";
import type { RunRequest } from "./runner.js";
import type { Task } from "./task.js";

const TASK: Task = {
  id: "t",
  repo: "/tmp/repo",
  commit: "deadbeef",
  instruction: "Add a --json flag.",
  oracle: { type: "output_hash", field: "final_text" },
};

describe("buildAgentEnv — Bedrock wiring (§4a)", () => {
  it("sets CLAUDE_CODE_USE_BEDROCK and a us.-profile model for claude", () => {
    const env = buildAgentEnv({ harness: "claude", awsRegion: "us-east-1", _baseEnv: {} });
    assert.equal(env["CLAUDE_CODE_USE_BEDROCK"], "1");
    assert.equal(env["ANTHROPIC_MODEL"], DEFAULT_CLAUDE_MODEL);
    assert.ok(env["ANTHROPIC_MODEL"]?.startsWith("us."), "inference profile is us.-prefixed");
    assert.equal(env["AWS_REGION"], "us-east-1");
  });

  it("honors an explicit model override for claude", () => {
    const env = buildAgentEnv({
      harness: "claude",
      model: "us.anthropic.claude-opus-4-8",
      _baseEnv: {},
    });
    assert.equal(env["ANTHROPIC_MODEL"], "us.anthropic.claude-opus-4-8");
  });

  it("does NOT set Claude Bedrock vars for the codex harness (codex uses argv -c)", () => {
    const env = buildAgentEnv({ harness: "codex", awsRegion: "us-west-2", _baseEnv: {} });
    assert.equal(env["CLAUDE_CODE_USE_BEDROCK"], undefined);
    assert.equal(env["ANTHROPIC_MODEL"], undefined);
    assert.equal(env["AWS_REGION"], "us-west-2");
  });

  it("falls back to the inherited AWS_REGION / AWS_DEFAULT_REGION", () => {
    const env = buildAgentEnv({ harness: "claude", _baseEnv: { AWS_DEFAULT_REGION: "eu-west-1" } });
    assert.equal(env["AWS_REGION"], "eu-west-1");
  });

  it("preserves inherited credentials (does not strip AWS_PROFILE / keys)", () => {
    const env = buildAgentEnv({
      harness: "claude",
      _baseEnv: { AWS_PROFILE: "bedrock-dev", AWS_REGION: "us-east-1" },
    });
    assert.equal(env["AWS_PROFILE"], "bedrock-dev");
  });
});

describe("buildArgv", () => {
  it("builds the headless claude command with stream-json output + verbose + model", () => {
    const { command, argv } = buildArgv({ harness: "claude" }, "PROMPT");
    assert.equal(command, "claude");
    // stream-json (not json) captures the tool-call trajectory; --verbose is
    // mandatory with stream-json in -p mode (Claude Code refuses otherwise).
    assert.deepEqual(argv, [
      "-p",
      "PROMPT",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      DEFAULT_CLAUDE_MODEL,
    ]);
  });

  it("builds the codex exec command routed to the amazon-bedrock provider", () => {
    const { command, argv } = buildArgv({ harness: "codex" }, "PROMPT");
    assert.equal(command, "codex");
    assert.deepEqual(argv, [
      "exec",
      "--json",
      "-c",
      "model_provider=amazon-bedrock",
      "-m",
      DEFAULT_CODEX_MODEL,
      "--skip-git-repo-check",
      "PROMPT",
    ]);
  });

  it("honors a per-harness model override (Bug-2 fix: codex gets a codex model)", () => {
    // The bug was that one global --model handed Claude's id to Codex. Each
    // harness must carry its own model into the argv.
    const claude = buildArgv({ harness: "claude", model: "us.anthropic.claude-opus-4-8" }, "P");
    assert.equal(claude.argv[claude.argv.indexOf("--model") + 1], "us.anthropic.claude-opus-4-8");
    const codex = buildArgv({ harness: "codex", model: "openai.gpt-5.4" }, "P");
    assert.equal(codex.argv[codex.argv.indexOf("-m") + 1], "openai.gpt-5.4");
  });
});

describe("composePrompt", () => {
  it("returns the bare instruction in the without-pack arm", () => {
    const req: RunRequest = { task: TASK, harness: "claude", withPack: false };
    assert.equal(composePrompt(req), TASK.instruction);
  });
  it("prepends the pack context in the with-pack arm", () => {
    const req: RunRequest = {
      task: TASK,
      harness: "claude",
      withPack: true,
      packContext: "PACK BODY",
    };
    const prompt = composePrompt(req);
    assert.ok(prompt.startsWith("PACK BODY"));
    assert.ok(prompt.endsWith(TASK.instruction));
  });
  it("ignores an empty pack context (falls back to bare instruction)", () => {
    const req: RunRequest = { task: TASK, harness: "claude", withPack: true, packContext: "" };
    assert.equal(composePrompt(req), TASK.instruction);
  });
});

describe("parseClaudeOutput (stream-json)", () => {
  // A representative stream: two assistant events (a tool_use + text) and the
  // final result event carrying usage + cost.
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: "foo" } },
          { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/a.ts" } },
        ],
      },
    }),
    "  ", // blank/whitespace line — tolerated
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Done." }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Done — added the flag.",
      usage: {
        input_tokens: 1234,
        output_tokens: 56,
        cache_creation_input_tokens: 27406,
        cache_read_input_tokens: 100,
      },
      total_cost_usd: 0.0123,
    }),
  ].join("\n");

  it("extracts result text + usage + cache + cost from the final result event", () => {
    const { finalText, tokens } = parseClaudeOutput(stream);
    assert.equal(finalText, "Done — added the flag.");
    assert.equal(tokens.inputTokens, 1234);
    assert.equal(tokens.outputTokens, 56);
    // cache = creation 27406 + read 100 (the Bug-1 fix — was silently dropped).
    assert.equal(tokens.cacheTokens, 27506);
    assert.equal(tokens.costUsd, 0.0123);
  });

  it("captures the normalized trajectory from assistant tool_use blocks", () => {
    const { trajectory } = parseClaudeOutput(stream);
    // Grep→search, Read→file_read, text→reason.
    assert.deepEqual(trajectory, [
      { type: "search", query: "foo" },
      { type: "file_read", target: "/a.ts" },
      { type: "reason" },
    ]);
  });

  it("tolerates a missing usage block (zeros, null cost)", () => {
    const stdout = JSON.stringify({ type: "result", result: "x" });
    const { tokens, finalText } = parseClaudeOutput(stdout);
    assert.equal(finalText, "x");
    assert.equal(tokens.inputTokens, 0);
    assert.equal(tokens.cacheTokens, 0);
    assert.equal(tokens.costUsd, null);
  });

  it("throws when the stream carries no result event", () => {
    // Non-JSON, and a stream of only assistant events, both lack a result line.
    assert.throws(() => parseClaudeOutput("not json"));
    assert.throws(() =>
      parseClaudeOutput(
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      ),
    );
  });
});

describe("parseCodexOutput", () => {
  const jsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    JSON.stringify({ type: "turn.started" }),
    "some progress noise that is not json",
    JSON.stringify({
      type: "item.completed",
      item: { id: "i1", type: "command_execution", status: "completed" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "i2", type: "agent_message", text: "Repo summary here." },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 24763,
        cached_input_tokens: 24448,
        output_tokens: 122,
        reasoning_output_tokens: 0,
      },
    }),
  ].join("\n");

  it("extracts the final agent_message text and the last turn.completed usage", () => {
    const { finalText, tokens } = parseCodexOutput(jsonl);
    assert.equal(finalText, "Repo summary here.");
    assert.equal(tokens.inputTokens, 24763);
    assert.equal(tokens.outputTokens, 122);
    assert.equal(tokens.cacheTokens, 24448, "codex cached_input_tokens captured (Bug-1 fix)");
    assert.equal(tokens.costUsd, null, "codex exposes no per-invocation USD cost");
  });

  it("returns empty/zeros when no agent_message is present", () => {
    const { finalText, tokens } = parseCodexOutput(JSON.stringify({ type: "turn.started" }));
    assert.equal(finalText, "");
    assert.equal(tokens.inputTokens, 0);
  });
});

describe("CliAgentRunner.run (stubbed spawn)", () => {
  it("returns a successful outcome + trajectory from a claude run", async () => {
    const spawnFn: SpawnFn = async ({ command, argv }) => {
      assert.equal(command, "claude");
      assert.ok(argv.includes("--output-format"));
      const stdout = [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x.ts" } }],
          },
        }),
        JSON.stringify({
          type: "result",
          result: "ok",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      ].join("\n");
      return { stdout, stderr: "", code: 0 };
    };
    const runner = new CliAgentRunner({ harness: "claude", _spawn: spawnFn, _baseEnv: {} });
    const outcome = await runner.run({ task: TASK, harness: "claude", withPack: false });
    assert.equal(outcome.errored, false);
    assert.equal(outcome.finalText, "ok");
    assert.equal(outcome.tokens.inputTokens, 10);
    assert.equal(outcome.checkoutPath, TASK.repo);
    assert.deepEqual(outcome.trajectory, [{ type: "file_read", target: "/x.ts" }]);
    assert.equal(runner.name, "cli:claude");
  });

  it("marks the outcome errored on a non-zero exit (no throw)", async () => {
    const spawnFn: SpawnFn = async () => ({ stdout: "", stderr: "boom", code: 1 });
    const runner = new CliAgentRunner({ harness: "claude", _spawn: spawnFn, _baseEnv: {} });
    const outcome = await runner.run({ task: TASK, harness: "claude", withPack: false });
    assert.equal(outcome.errored, true);
    assert.equal(outcome.tokens.inputTokens, 0);
  });

  it("marks the outcome errored when stdout is unparseable", async () => {
    const spawnFn: SpawnFn = async () => ({ stdout: "garbage", stderr: "", code: 0 });
    const runner = new CliAgentRunner({ harness: "claude", _spawn: spawnFn, _baseEnv: {} });
    const outcome = await runner.run({ task: TASK, harness: "claude", withPack: false });
    assert.equal(outcome.errored, true);
  });

  it("injects the pack context into the prompt on the with-pack arm", async () => {
    let seenPrompt = "";
    const spawnFn: SpawnFn = async ({ argv }) => {
      // claude argv: ["-p", PROMPT, ...]
      seenPrompt = argv[1] ?? "";
      return {
        stdout: JSON.stringify({
          type: "result",
          result: "ok",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        stderr: "",
        code: 0,
      };
    };
    const runner = new CliAgentRunner({ harness: "claude", _spawn: spawnFn, _baseEnv: {} });
    await runner.run({ task: TASK, harness: "claude", withPack: true, packContext: "THE PACK" });
    assert.ok(seenPrompt.startsWith("THE PACK"));
  });
});
