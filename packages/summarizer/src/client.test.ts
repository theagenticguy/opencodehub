/**
 * Unit tests for the ReAct retry loop in `summarizeSymbol`.
 *
 * Bedrock is replaced by a fake client whose `send` returns queued Converse
 * responses, so we drive the loop deterministically: success on the first
 * attempt, recovery after a validation failure, recovery after the model
 * skips the tool, the empty-response path, and exhaustion into a
 * `SummarizerError` carrying the right attempt/usage/failure bookkeeping.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BedrockRuntimeClient, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { DEFAULT_MAX_ATTEMPTS, SummarizerError, summarizeSymbol, TOOL_NAME } from "./client.js";
import type { SymbolSummaryT } from "./schema.js";

const INPUT = {
  source: "def normalize(p):\n    return os.path.abspath(p)\n",
  filePath: "src/paths.py",
  lineStart: 10,
  lineEnd: 16,
  docstring: null,
  enclosingClass: null,
} as const;

/** A summary that passes both the Zod schema and the citation-bounds pass. */
function validSummaryInput(): SymbolSummaryT {
  return {
    purpose: "Normalize a filesystem path into a canonical absolute form for cache keys.",
    inputs: [{ name: "p", type: "str", description: "the raw path string to normalize" }],
    returns: {
      type: "str",
      type_summary: "the canonical absolute path",
      details: "An absolute, symlink-resolved path string with no trailing slash.",
    },
    side_effects: ["reads the current working directory to resolve relative paths"],
    invariants: ["the result is always an absolute path"],
    citations: [
      { field_name: "purpose", line_start: 10, line_end: 12 },
      { field_name: "inputs", line_start: 10, line_end: 10 },
      { field_name: "returns", line_start: 14, line_end: 16 },
      { field_name: "side_effects", line_start: 13, line_end: 13 },
      { field_name: "invariants", line_start: 16, line_end: 16 },
    ],
  };
}

/** A Converse response whose message calls the tool with the given input. */
function toolUseResponse(input: unknown, toolUseId = "tu-1"): ConverseCommandOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: "assistant",
        content: [{ toolUse: { toolUseId, name: TOOL_NAME, input } }],
      },
    },
    stopReason: "tool_use",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
  } as ConverseCommandOutput;
}

/** A Converse response with text only — the model declined to call the tool. */
function textOnlyResponse(text: string): ConverseCommandOutput {
  return {
    $metadata: {},
    output: { message: { role: "assistant", content: [{ text }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 80, outputTokens: 20, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
  } as ConverseCommandOutput;
}

/** A Converse response with no output at all. */
function emptyResponse(): ConverseCommandOutput {
  return {
    $metadata: {},
    usage: { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
  } as ConverseCommandOutput;
}

/**
 * Fake Bedrock client that dequeues one response per `send` call and records
 * how many times it was invoked.
 */
function fakeClient(responses: ConverseCommandOutput[]): {
  client: BedrockRuntimeClient;
  sendCount: () => number;
} {
  let i = 0;
  const client = {
    send: async () => {
      const r = responses[i];
      i += 1;
      if (r === undefined) {
        throw new Error("fake client exhausted: more sends than queued responses");
      }
      return r;
    },
  } as unknown as BedrockRuntimeClient;
  return { client, sendCount: () => i };
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test("summarizeSymbol: returns the validated summary on the first attempt", async () => {
  const { client, sendCount } = fakeClient([toolUseResponse(validSummaryInput())]);
  const result = await summarizeSymbol(client, INPUT);
  assert.equal(sendCount(), 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.validationFailures.length, 0);
  assert.equal(result.usageByAttempt.length, 1);
  assert.equal(result.summary.purpose, validSummaryInput().purpose);
  assert.ok(result.wallClockMs >= 0);
});

test("summarizeSymbol: recovers on attempt 2 after a schema-validation failure", async () => {
  const bad = {
    ...validSummaryInput(),
    purpose: "This function normalizes a path for cache keys.",
  };
  const { client, sendCount } = fakeClient([
    toolUseResponse(bad),
    toolUseResponse(validSummaryInput()),
  ]);
  const result = await summarizeSymbol(client, INPUT);
  assert.equal(sendCount(), 2);
  assert.equal(result.attempts, 2);
  // One failure recorded; the validated attempt is not in the list.
  assert.equal(result.validationFailures.length, 1);
  assert.match(result.validationFailures[0] as string, /attempt 1:/);
  assert.match(result.validationFailures[0] as string, /describe the behavior directly/);
});

test("summarizeSymbol: recovers after the model fails to call the tool", async () => {
  const { client, sendCount } = fakeClient([
    textOnlyResponse("Here is a prose summary instead of a tool call."),
    toolUseResponse(validSummaryInput()),
  ]);
  const result = await summarizeSymbol(client, INPUT);
  assert.equal(sendCount(), 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.validationFailures.length, 1);
  assert.match(result.validationFailures[0] as string, /did not call the tool/);
});

test("summarizeSymbol: recovers after an empty response output", async () => {
  const { client } = fakeClient([emptyResponse(), toolUseResponse(validSummaryInput())]);
  const result = await summarizeSymbol(client, INPUT);
  assert.equal(result.attempts, 2);
  assert.equal(result.validationFailures.length, 1);
  assert.match(result.validationFailures[0] as string, /empty response output/);
});

test("summarizeSymbol: recovers after a citation-bounds failure that the schema cannot catch", async () => {
  const outOfBounds = validSummaryInput();
  // line_end 99 is inside Zod's range but outside the [10, 16] source span.
  const bad = {
    ...outOfBounds,
    citations: [
      { field_name: "purpose" as const, line_start: 10, line_end: 99 },
      ...outOfBounds.citations.slice(1),
    ],
  };
  const { client } = fakeClient([toolUseResponse(bad), toolUseResponse(validSummaryInput())]);
  const result = await summarizeSymbol(client, INPUT);
  assert.equal(result.attempts, 2);
  assert.match(result.validationFailures[0] as string, /falls outside source span \[10, 16\]/);
});

// ---------------------------------------------------------------------------
// Exhaustion
// ---------------------------------------------------------------------------

test("summarizeSymbol: throws SummarizerError after exhausting attempts, with full bookkeeping", async () => {
  const bad = { ...validSummaryInput(), purpose: "too short" };
  const { client, sendCount } = fakeClient([
    toolUseResponse(bad),
    toolUseResponse(bad),
    toolUseResponse(bad),
  ]);
  await assert.rejects(
    () => summarizeSymbol(client, INPUT),
    (err: unknown) => {
      assert.ok(err instanceof SummarizerError);
      assert.equal(err.attemptsUsed, DEFAULT_MAX_ATTEMPTS);
      assert.equal(err.usageByAttempt.length, DEFAULT_MAX_ATTEMPTS);
      assert.equal(err.validationFailures.length, DEFAULT_MAX_ATTEMPTS);
      assert.equal(err.name, "SummarizerError");
      return true;
    },
  );
  assert.equal(sendCount(), DEFAULT_MAX_ATTEMPTS);
});

test("summarizeSymbol: honours a custom maxAttempts ceiling", async () => {
  const bad = { ...validSummaryInput(), purpose: "too short" };
  const { client, sendCount } = fakeClient([toolUseResponse(bad), toolUseResponse(bad)]);
  await assert.rejects(
    () => summarizeSymbol(client, INPUT, { maxAttempts: 2 }),
    (err: unknown) => err instanceof SummarizerError && err.attemptsUsed === 2,
  );
  assert.equal(sendCount(), 2);
});
