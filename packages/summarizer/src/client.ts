/**
 * Converse-API summarizer client with ReAct retry.
 *
 * One public entry point, `summarizeSymbol`, drives a Bedrock `ConverseCommand`
 * against Haiku 4.5 using `tool_use` as the structured-output primitive.
 * The Zod schema exported from `./schema` becomes the tool's `inputSchema`,
 * so the model can only respond by filling that schema. Validation failures
 * are fed back through `toolResult(status: "error")` content blocks so Claude
 * sees its prior (broken) tool call and the validator's feedback — the ReAct
 * pattern, wire-level.
 *
 * Two cachePoint blocks engage prompt caching:
 *   - after the system prompt (the ~5k-token rubric + three worked examples)
 *   - after the tool spec inside `toolConfig.tools`
 * Haiku 4.5 on Bedrock requires ≥4,096 cacheable tokens per checkpoint; the
 * system prompt is sized to clear that floor.
 *
 * NOT included in this client:
 *   - batch orchestration (the ingestion pipeline owns concurrency + backoff)
 *   - embedding of the emitted summary (that lives downstream)
 *   - caching of summaries to disk (the ingest layer hashes source and
 *     re-uses prior summaries when the AST structural hash matches)
 */

import {
  type BedrockRuntimeClient,
  type ContentBlock,
  ConverseCommand,
  type ConverseCommandInput,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { buildUserText, SYSTEM_PROMPT } from "./prompt.js";
import {
  buildToolInputSchema,
  formatZodError,
  SymbolSummary,
  type SymbolSummaryT,
  validateCitationLines,
} from "./schema.js";

export const TOOL_NAME = "emit_symbol_summary";
/**
 * Default model id — global inference profile for Haiku 4.5 on Bedrock.
 * Callers can override via `SummarizeOptions.modelId` when running against
 * a region-specific profile.
 */
export const DEFAULT_MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface AttemptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface SummarizerResult {
  readonly summary: SymbolSummaryT;
  readonly attempts: number;
  readonly usageByAttempt: readonly AttemptUsage[];
  readonly wallClockMs: number;
  /**
   * One entry per attempt that failed validation. The validated attempt is
   * NOT included here; length therefore equals `attempts - 1` on success.
   */
  readonly validationFailures: readonly string[];
}

export interface SummarizeInput {
  readonly source: string;
  readonly filePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly docstring: string | null;
  readonly enclosingClass: string | null;
}

export interface SummarizeOptions {
  readonly modelId?: string;
  readonly maxAttempts?: number;
  readonly maxTokens?: number;
}

function usageFromResponse(u: Record<string, number | undefined> | undefined): AttemptUsage {
  return {
    inputTokens: u?.["inputTokens"] ?? 0,
    outputTokens: u?.["outputTokens"] ?? 0,
    cacheRead: u?.["cacheReadInputTokens"] ?? 0,
    cacheWrite: u?.["cacheWriteInputTokens"] ?? 0,
  };
}

export class SummarizerError extends Error {
  constructor(
    message: string,
    public readonly attemptsUsed: number,
    public readonly usageByAttempt: readonly AttemptUsage[],
    public readonly validationFailures: readonly string[],
  ) {
    super(message);
    this.name = "SummarizerError";
  }
}

export async function summarizeSymbol(
  client: BedrockRuntimeClient,
  input: SummarizeInput,
  options: SummarizeOptions = {},
): Promise<SummarizerResult> {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxTokens = options.maxTokens ?? 2048;

  const system: SystemContentBlock[] = [
    { text: SYSTEM_PROMPT } as SystemContentBlock.TextMember,
    { cachePoint: { type: "default" } } as SystemContentBlock.CachePointMember,
  ];

  const tools: Tool[] = [
    {
      toolSpec: {
        name: TOOL_NAME,
        description:
          "Emit the structured summary for the supplied callable symbol. " +
          "Every field is validated strictly; schema violations will be returned for retry.",
        inputSchema: { json: buildToolInputSchema() },
      },
    } as Tool.ToolSpecMember,
    { cachePoint: { type: "default" } } as Tool.CachePointMember,
  ];

  const toolConfig: ToolConfiguration = {
    tools,
    toolChoice: { tool: { name: TOOL_NAME } },
  };

  const messages: Message[] = [{ role: "user", content: [{ text: buildUserText(input) }] }];

  const usageByAttempt: AttemptUsage[] = [];
  const validationFailures: string[] = [];
  let lastError: string | null = null;
  const t0 = performance.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const request: ConverseCommandInput = {
      modelId,
      messages,
      system,
      inferenceConfig: { temperature: 0, maxTokens },
      toolConfig,
    };

    const response = await client.send(new ConverseCommand(request));

    usageByAttempt.push(
      usageFromResponse(response.usage as Record<string, number | undefined> | undefined),
    );

    const output = response.output;
    if (!output || output.message === undefined) {
      const failure = `attempt ${attempt}: empty response output`;
      validationFailures.push(failure);
      lastError = failure;
      continue;
    }

    const contentBlocks: ContentBlock[] = (output.message as Message).content ?? [];
    const stopReason = response.stopReason;

    let toolUseInput: unknown;
    let toolUseId: string | undefined;
    for (const block of contentBlocks) {
      if ("toolUse" in block && block.toolUse !== undefined) {
        toolUseInput = block.toolUse.input;
        toolUseId = block.toolUse.toolUseId;
        break;
      }
    }

    if (toolUseInput === undefined || toolUseId === undefined) {
      const failure = `attempt ${attempt}: model did not call the tool (stopReason=${stopReason ?? "?"})`;
      validationFailures.push(failure);
      lastError = failure;
      messages.push({ role: "assistant", content: contentBlocks });
      messages.push({
        role: "user",
        content: [
          {
            text:
              "You did not call the emit_symbol_summary tool. " +
              "Call it now with a valid structured summary.",
          },
        ],
      });
      continue;
    }

    const parsed = SymbolSummary.safeParse(toolUseInput);
    const lineErrors = parsed.success
      ? validateCitationLines(parsed.data, input.lineStart, input.lineEnd)
      : [];

    if (parsed.success && lineErrors.length === 0) {
      return {
        summary: parsed.data,
        attempts: attempt,
        usageByAttempt,
        wallClockMs: performance.now() - t0,
        validationFailures,
      };
    }

    let errText: string;
    if (!parsed.success) {
      errText = formatZodError(parsed.error);
      if (lineErrors.length > 0) {
        errText += `\n${lineErrors.map((e) => `- ${e}`).join("\n")}`;
      }
    } else {
      errText = lineErrors.map((e) => `- ${e}`).join("\n");
    }

    lastError = errText;
    validationFailures.push(`attempt ${attempt}:\n${errText}`);

    messages.push({ role: "assistant", content: contentBlocks });
    messages.push({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId,
            content: [
              {
                text:
                  "Validation failed:\n" +
                  `${errText}\n` +
                  "Fix and call emit_symbol_summary again.",
              },
            ],
            status: "error",
          },
        },
      ],
    });
  }

  throw new SummarizerError(
    `summarizeSymbol failed after ${maxAttempts} attempts. Last error:\n${lastError ?? "<unknown>"}`,
    maxAttempts,
    usageByAttempt,
    validationFailures,
  );
}
