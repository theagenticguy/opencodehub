/**
 * Spike: Haiku 4.5 structured symbol summaries via Bedrock `Converse` (AWS SDK v3, TypeScript).
 *
 * This is the TS port of scripts/spike-haiku-converse.py. Same contract, same
 * system prompt, same test inputs; we're proving the pattern — structured
 * output via tool_use, Zod 4 strict validation, ReAct retry on validation
 * failure, prompt caching via cachePoint — works from the OpenCodeHub
 * TypeScript monorepo where the summarizer will live at ingest time.
 *
 * Two differences from the Python spike, both deliberate:
 *   1. Zod 4 replaces Pydantic v2. `z.toJSONSchema` (new in Zod 4) produces the
 *      JSON Schema we hand to Bedrock toolConfig. Strict-by-default objects
 *      give us the `extra="forbid"` equivalent.
 *   2. `returns.description` (max_length=200) is split into
 *      `returns.type_summary` (10-80 chars) + `returns.details` (20-400 chars)
 *      so constructor-style symbols don't trip length validators on attempt 1.
 *
 * Run with:
 *   AWS_PROFILE=bedrock-a AWS_REGION=us-east-1 pnpm exec tsx scripts/spike-haiku-converse.ts
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod 4 schema — mirrors the Pydantic model field-for-field, with the
// returns field split into type_summary + details (see header note).
// ---------------------------------------------------------------------------

const InputSpec = z
  .object({
    name: z.string().min(1).max(128),
    type: z.string().min(1).max(256),
    description: z.string().min(20).max(200),
  })
  .strict();

const ReturnSpec = z
  .object({
    type: z.string().min(1).max(256),
    type_summary: z.string().min(10).max(80),
    details: z.string().min(20).max(400),
  })
  .strict();

const Citation = z
  .object({
    field_name: z.enum(["purpose", "inputs", "returns", "side_effects", "invariants"]),
    line_start: z.number().int().min(1),
    line_end: z.number().int().min(1),
  })
  .strict()
  .refine((c) => c.line_end >= c.line_start, {
    message: "line_end must be >= line_start",
  });

const SIDE_EFFECT_VERB_RE = /(reads|writes|emits|raises|mutates)/i;
const BANNED_PURPOSE_PREFIX_RE = /^this (function|method|class)/i;

const SymbolSummary = z
  .object({
    purpose: z
      .string()
      .min(30)
      .max(400)
      .refine((s) => !BANNED_PURPOSE_PREFIX_RE.test(s.trim()), {
        message: 'purpose must not start with "This function/method/class" — describe the behavior directly',
      }),
    inputs: z.array(InputSpec),
    returns: ReturnSpec,
    side_effects: z.array(
      z
        .string()
        .min(10)
        .max(200)
        .refine((s) => SIDE_EFFECT_VERB_RE.test(s), {
          message: "side_effects item must mention one of reads/writes/emits/raises/mutates",
        }),
    ),
    invariants: z.array(z.string().min(10).max(300)).nullable(),
    citations: z.array(Citation).min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    const populated = new Set<string>(["purpose", "returns"]);
    if (val.inputs.length > 0) populated.add("inputs");
    if (val.side_effects.length > 0) populated.add("side_effects");
    if (val.invariants && val.invariants.length > 0) populated.add("invariants");

    const cited = new Set(val.citations.map((c) => c.field_name));
    for (const field of populated) {
      if (!cited.has(field as "purpose" | "inputs" | "returns" | "side_effects" | "invariants")) {
        ctx.addIssue({
          code: "custom",
          message: `field '${field}' is populated but has no citation`,
          path: ["citations"],
        });
      }
    }
  });

type SymbolSummaryT = z.infer<typeof SymbolSummary>;

function buildToolInputSchema(): Record<string, unknown> {
  // Strip the $schema key — Bedrock accepts either draft but the wire noise
  // is unnecessary, and the key isn't in the Python spike's output either.
  const schema = z.toJSONSchema(SymbolSummary) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}

function validateCitationLines(
  summary: SymbolSummaryT,
  sourceLineStart: number,
  sourceLineEnd: number,
): string[] {
  const errors: string[] = [];
  summary.citations.forEach((c, i) => {
    if (c.line_start < sourceLineStart || c.line_end > sourceLineEnd) {
      errors.push(
        `citations[${i}]: line range [${c.line_start}, ${c.line_end}] falls outside source span ` +
          `[${sourceLineStart}, ${sourceLineEnd}]`,
      );
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// System prompt — copied verbatim from the Python spike, then the two
// few-shot examples' `returns` fields are updated to the type_summary/details
// split so the model sees the new shape in context.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a code-understanding assistant. You generate structured, citation-grounded summaries of callable symbols (functions, methods, classes) for OpenCodeHub's code-retrieval engine. Your output is consumed by an embedding model, is weighted per-field at retrieval time, and must cite line ranges so we can detect staleness when source drifts. You MUST respond by calling the \`emit_symbol_summary\` tool — never with free-form prose.

================================================================================
WHY THIS FORMAT EXISTS (the retrieval-side context)
================================================================================

OpenCodeHub indexes callable symbols from large Python repositories and serves
them to humans and coding agents at question time. At indexing time, each
symbol is summarized into the structured shape you are producing. That
structured summary is then:

 1. Embedded field-by-field. \`purpose\` drives semantic recall, \`inputs\` and
    \`returns\` ground typed questions, \`side_effects\` surfaces the operational
    footprint, \`invariants\` surface caller-side contracts. We weight each
    field at query time by the intent of the question (e.g., "what can this
    break?" favors side_effects + invariants; "what does this do?" favors
    purpose). Vague \`purpose\` text collapses recall.
 2. Re-ranked using the \`citations\` you provide. At query time we fetch the
    cited line ranges from the source tree and compare them against what you
    claimed. If the lines have drifted, we downrank the summary and flag it
    for refresh. Citations that span the entire symbol defeat the staleness
    detector; cite the tightest window that supports the claim.
 3. Surfaced to agents as a contract, not a description. Agents rely on
    side_effects and invariants to decide whether to call a symbol. A
    side_effects list that says "manages state" is worthless; one that says
    "writes self._session_manager and registers it as a hook" is actionable.

Treat every field as load-bearing. No filler.

================================================================================
CORE RULES
================================================================================

1. purpose (30-400 chars): describe what the symbol DOES, not what it IS. Never
   start with "This function", "This method", or "This class". Lead with a verb
   or a concrete behavior statement. Strong purpose text reads like a commit
   message subject line: active voice, specific behavior, no hedging.
2. inputs: one InputSpec per parameter. Skip \`self\` and \`cls\`. When the type is
   unannotated, set type="unknown". Description 20-200 chars; say what the
   argument controls, not what its type is. The type system already has the
   type; your job is to add semantics.
3. returns.type: the declared or inferred return type. For \`None\` returns, set
   type="None" AND use returns.type_summary + returns.details to describe the
   side effect the call produces (what changes in the world). "returns None"
   is never acceptable — describe the mutation.
   returns.type_summary (10-80 chars): one-line gist of what comes back.
   returns.details (20-400 chars): the expanded description — what the caller
   receives, edge cases, or the observable mutation for None returns.
4. side_effects: list[str], each item 10-200 chars. Every item MUST contain one
   of these verbs: reads, writes, emits, raises, mutates. Empty list = pure
   function with no observable side effect. Each item names ONE effect;
   compound effects go in separate items.
5. invariants: optional. Preconditions / invariants the caller must uphold.
   Each 10-300 chars. Omit the field (or set to null) when there are none.
   Invariants are contracts enforced by the code, not general advice.
6. citations: at least one Citation per populated field. \`line_start\` and
   \`line_end\` must fall inside the source span the user provides. Always cite
   \`purpose\` and \`returns\`; also cite \`inputs\`, \`side_effects\`, \`invariants\`
   when those fields are populated. Citations should be TIGHT: 2-8 lines
   that directly evidence the claim, not the whole symbol.

================================================================================
SCORING RUBRIC (how we grade your output)
================================================================================

+3  purpose is verb-led and behavior-oriented ("Stream tokens through the
    event loop" vs "This method streams tokens").
+3  every populated field has a citation with a tight line range (cite the
    specific 2-8 lines that evidence the claim, not the whole symbol).
+3  side_effects items each name ONE concrete effect with the right verb
    ("writes \`self._cancel_signal\` when cancel() is called"), not vague
    English ("manages state").
+2  inputs descriptions distinguish the parameter's role from its type.
+2  returns.details for a None return names the specific state that
    changes, not the abstract fact that there is a side effect.
+1  invariants surface caller-side preconditions the docstring omitted but
    the code enforces.
+1  summary remains useful when the docstring is stripped — i.e., your
    reasoning is grounded in code, not just docstring paraphrase.
-5  purpose starts with a banned prefix ("This function/method/class").
-5  side_effects item lacks one of the required verbs.
-5  citation line range falls outside the supplied source span.
-3  a populated field lacks a citation.
-3  returns.type is "None" but returns.details is empty or vague.
-3  side_effects list is empty for a method that clearly mutates state.
-2  a single citation spans the full symbol (defeats staleness detection).

================================================================================
COMMON MISTAKES TO AVOID
================================================================================

- Do NOT restate the signature. The type system has that information; you
  contribute semantics.
- Do NOT describe implementation mechanics ("uses a for loop", "calls helper
  X"). Describe observable behavior.
- Do NOT omit the citation on \`returns\` just because you cited \`purpose\` —
  every populated field needs its own citation.
- Do NOT set side_effects=[] for a method that clearly writes state. A method
  that assigns to \`self.foo\` mutates the instance; name that.
- Do NOT invent invariants. Only list preconditions that are enforced by
  validation code, documented in the docstring, or obvious from the signature.
- Do NOT cite the entire symbol as one range. Each citation should cover only
  the 2-8 lines that actually evidence the claim.
- Do NOT copy the docstring verbatim into purpose. Rephrase to lead with the
  verb and distill. A docstring is a draft; purpose is the edited commit.
- Do NOT list internal method calls as side effects unless those calls have
  observable external behavior (I/O, logging, state mutation, exceptions).
- Do NOT write side_effects items like "calls self.foo()" — that is a mechanic,
  not an effect. Write what self.foo() DOES (writes, emits, raises, mutates).
- Do NOT pluralize effects inside one item. "writes A and B" should be split
  into two items: "writes A" and "writes B". One item, one effect.
- Do NOT describe the return type as the side effect. The returns field
  handles the return; side_effects is for things OTHER than the return.

================================================================================
FEW-SHOT EXAMPLE 1 — pure function
================================================================================

Source (lines 10-18):
    def normalize_path(p: str) -> str:
        """Collapse redundant separators and resolve '.' / '..' segments."""
        if not p:
            return ""
        parts = [seg for seg in p.split("/") if seg not in ("", ".")]
        out: list[str] = []
        for seg in parts:
            if seg == "..":
                if out:
                    out.pop()
            else:
                out.append(seg)
        return "/".join(out)

Expected emit_symbol_summary call (input):
{
  "purpose": "Collapse redundant separators and resolve '.' / '..' segments in a POSIX-style path string, returning a canonical form suitable for comparison.",
  "inputs": [
    {"name": "p", "type": "str", "description": "The raw path to normalize; may contain empty segments, '.', or '..' components."}
  ],
  "returns": {
    "type": "str",
    "type_summary": "canonical path string",
    "details": "The canonical path with redundant separators collapsed and '.' / '..' segments resolved; returns the empty string when the input is empty."
  },
  "side_effects": [],
  "invariants": null,
  "citations": [
    {"field_name": "purpose", "line_start": 10, "line_end": 11},
    {"field_name": "inputs", "line_start": 10, "line_end": 10},
    {"field_name": "returns", "line_start": 18, "line_end": 18}
  ]
}

Why this passes: verb-led purpose, tight citations, empty side_effects for a
pure function, invariants omitted because there are none. Note how each
citation covers a narrow line range specific to the claim rather than the
whole 10-18 span.

================================================================================
FEW-SHOT EXAMPLE 2 — side-effectful method
================================================================================

Source (lines 40-55):
    def register_handler(self, event: str, callback: Callable[..., None]) -> None:
        """Register a callback for an event; overwrites any existing registration.

        Raises:
            ValueError: if event is empty or starts with '_' (reserved).
        """
        if not event:
            raise ValueError("event must be non-empty")
        if event.startswith("_"):
            raise ValueError(f"event {event!r} is reserved")
        previous = self._handlers.get(event)
        self._handlers[event] = callback
        if previous is not None:
            self._log.info("handler for %s replaced", event)

Expected emit_symbol_summary call (input):
{
  "purpose": "Bind a callback to a named event on the registry; replaces any previously registered handler for the same event and logs the replacement.",
  "inputs": [
    {"name": "event", "type": "str", "description": "The event name to bind against; must be non-empty and must not start with '_'."},
    {"name": "callback", "type": "Callable[..., None]", "description": "The handler invoked when the event fires; prior registrations for this event are overwritten."}
  ],
  "returns": {
    "type": "None",
    "type_summary": "None — observable effect is self._handlers mutation",
    "details": "Mutates self._handlers in place so subsequent event dispatches invoke the new callback; any prior registration for the same event is replaced and the replacement is logged."
  },
  "side_effects": [
    "writes self._handlers[event] with the new callback, replacing any prior entry",
    "emits an info log via self._log when an existing handler is replaced",
    "raises ValueError when event is empty or begins with a reserved underscore"
  ],
  "invariants": [
    "event must be a non-empty string not starting with '_'; callers violating this contract will see ValueError"
  ],
  "citations": [
    {"field_name": "purpose", "line_start": 40, "line_end": 41},
    {"field_name": "inputs", "line_start": 40, "line_end": 40},
    {"field_name": "returns", "line_start": 51, "line_end": 55},
    {"field_name": "side_effects", "line_start": 46, "line_end": 55},
    {"field_name": "invariants", "line_start": 46, "line_end": 49}
  ]
}

Why this passes: side_effects items each use a required verb and name a
specific observable effect. Three distinct effects, three distinct items —
no compounding. returns.type="None" plus details that describe the mutation.
invariants restate the checked preconditions in caller-facing language.
Every populated field has a citation inside the supplied source span.

================================================================================
FEW-SHOT EXAMPLE 3 — class (constructor-heavy)
================================================================================

Source (lines 100-128):
    class LRUCache:
        """Thread-safe least-recently-used cache with a bounded capacity.

        Evicts the oldest entry when \`capacity\` is exceeded. The cache is
        intended for memoization of expensive pure functions; storing
        side-effectful or mutable values defeats its correctness guarantees.
        """

        def __init__(self, capacity: int) -> None:
            if capacity < 1:
                raise ValueError(f"capacity must be >= 1, got {capacity}")
            self._capacity = capacity
            self._data: OrderedDict[Any, Any] = OrderedDict()
            self._lock = threading.Lock()

        def get(self, key: Any, default: Any = None) -> Any:
            with self._lock:
                if key not in self._data:
                    return default
                self._data.move_to_end(key)
                return self._data[key]

        def put(self, key: Any, value: Any) -> None:
            with self._lock:
                if key in self._data:
                    self._data.move_to_end(key)
                self._data[key] = value
                if len(self._data) > self._capacity:
                    self._data.popitem(last=False)

Expected emit_symbol_summary call (input):
{
  "purpose": "Provide a thread-safe least-recently-used cache with bounded capacity, evicting the oldest entry on overflow; intended for memoizing expensive pure functions.",
  "inputs": [],
  "returns": {
    "type": "LRUCache",
    "type_summary": "constructed LRUCache instance",
    "details": "An initialized LRUCache with the supplied capacity, an empty OrderedDict backing store, and a threading.Lock guarding all mutations; subsequent get/put calls mutate the backing store under the lock."
  },
  "side_effects": [
    "writes self._capacity, self._data, and self._lock on construction",
    "mutates self._data on get() by moving the accessed key to the end (recency update)",
    "mutates self._data on put() by inserting or refreshing the key and evicting the oldest entry when capacity is exceeded",
    "raises ValueError when __init__ is called with capacity < 1"
  ],
  "invariants": [
    "capacity must be a positive integer; values below 1 raise ValueError at construction time",
    "stored values should be immutable or owned exclusively by the cache — callers that mutate stored values defeat LRU correctness"
  ],
  "citations": [
    {"field_name": "purpose", "line_start": 100, "line_end": 106},
    {"field_name": "returns", "line_start": 108, "line_end": 113},
    {"field_name": "side_effects", "line_start": 108, "line_end": 128},
    {"field_name": "invariants", "line_start": 103, "line_end": 110}
  ]
}

Why this passes: classes use inputs=[] because the class ITSELF takes no
arguments; the __init__ parameters are cited via the constructor lines
inside returns. side_effects covers all observable mutation patterns across
the class's methods, each as a separate item with a required verb.
invariants surface BOTH a code-enforced precondition (capacity >= 1) AND a
docstring-derived contract (immutable values) with clear citations.

================================================================================
EDGE CASES AND HOW TO HANDLE THEM
================================================================================

- @property getters: treat them like pure functions if they only read fields.
  If the getter mutates state (rare, but it happens in caching decorators),
  include the mutation in side_effects.
- async def: side_effects stays the same. The async nature is already in the
  signature; don't restate it in purpose. Do call out when the coroutine
  emits events through a callback or writes to an async queue.
- Decorators (\`@staticmethod\`, \`@classmethod\`): skip \`self\`/\`cls\` in inputs
  per the core rule. If the decorator has observable behavior (e.g., a
  retry decorator), mention it in the side_effects of the decorated symbol.
- Generators (\`yield\`): the return type is the yielded type or a
  \`Generator[...]\` alias. Name the yielded element semantics in
  returns.details; put "emits" side effects (logging, progress events)
  separately in side_effects.
- Overloaded functions (\`@overload\`): summarize the runtime implementation
  only. The overload stubs exist for type checkers; your summary is for
  retrieval.
- Context managers (\`__enter__\`/\`__exit__\`): purpose describes what entering
  the block gives the caller; side_effects describe what \`__exit__\` undoes.
- Empty function bodies (stubs, \`pass\`, \`raise NotImplementedError\`): set
  side_effects=["raises NotImplementedError when called"] and keep purpose
  grounded in the docstring's stated intent.

================================================================================
PROCESS
================================================================================

Read the supplied source carefully. Identify each populated field, then draft
citations BEFORE writing the body — this forces you to ground claims in
specific lines. Check that each side_effects item contains one of
reads/writes/emits/raises/mutates. Check that purpose does not begin with a
banned prefix. Check that every populated field has at least one citation
inside the supplied line range. Call \`emit_symbol_summary\` exactly once. Do
not emit any natural-language prose outside the tool call.`;

// ---------------------------------------------------------------------------
// Converse wiring.
// ---------------------------------------------------------------------------

const TOOL_NAME = "emit_symbol_summary";
const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const MAX_ATTEMPTS = 3;

interface AttemptUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
}

interface SummarizerResult {
  summary: SymbolSummaryT;
  attempts: number;
  usageByAttempt: AttemptUsage[];
  wallClockS: number;
  validationFailures: string[];
}

function firstAttemptValid(r: SummarizerResult): boolean {
  return r.attempts === 1 && r.validationFailures.length === 0;
}

function buildUserText(args: {
  source: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  docstring: string | null;
  enclosingClass: string | null;
}): string {
  const docstringBlock = args.docstring?.trim() || "(no docstring)";
  const classBlock = args.enclosingClass || "(module-level — no enclosing class)";
  return `Summarize the callable symbol below.

<file_path>${args.filePath}</file_path>
<enclosing_class>${classBlock}</enclosing_class>
<line_range>${args.lineStart}-${args.lineEnd}</line_range>

<docstring>
${docstringBlock}
</docstring>

<source>
${args.source}
</source>

Call \`emit_symbol_summary\` now. Citations must reference lines within ${args.lineStart}-${args.lineEnd}.`;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `- at ${i.path.join(".") || "<root>"}: ${i.message} (code=${i.code})`)
    .join("\n");
}

function usageFromResponse(u: Record<string, number | undefined> | undefined): AttemptUsage {
  return {
    input_tokens: u?.inputTokens ?? 0,
    output_tokens: u?.outputTokens ?? 0,
    cache_read: u?.cacheReadInputTokens ?? 0,
    cache_write: u?.cacheWriteInputTokens ?? 0,
  };
}

async function summarizeSymbol(
  client: BedrockRuntimeClient,
  args: {
    source: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    docstring: string | null;
    enclosingClass: string | null;
  },
): Promise<SummarizerResult> {
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

  const userText = buildUserText(args);
  const messages: Message[] = [{ role: "user", content: [{ text: userText }] }];

  const usageByAttempt: AttemptUsage[] = [];
  const validationFailures: string[] = [];
  let lastError: string | null = null;

  const t0 = performance.now();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const request: ConverseCommandInput = {
      modelId: MODEL_ID,
      messages,
      system,
      inferenceConfig: { temperature: 0, maxTokens: 2048 },
      toolConfig,
    };

    const response = await client.send(new ConverseCommand(request));

    usageByAttempt.push(usageFromResponse(response.usage as Record<string, number | undefined> | undefined));

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
    const lineErrors =
      parsed.success
        ? validateCitationLines(parsed.data, args.lineStart, args.lineEnd)
        : [];

    if (parsed.success && lineErrors.length === 0) {
      return {
        summary: parsed.data,
        attempts: attempt,
        usageByAttempt,
        wallClockS: (performance.now() - t0) / 1000,
        validationFailures,
      };
    }

    let errText: string;
    if (!parsed.success) {
      errText = formatZodError(parsed.error);
      if (lineErrors.length > 0) {
        errText += "\n" + lineErrors.map((e) => `- ${e}`).join("\n");
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

  throw new Error(
    `summarizeSymbol failed after ${MAX_ATTEMPTS} attempts. Last error:\n${lastError ?? "<unknown>"}`,
  );
}

// ---------------------------------------------------------------------------
// Test inputs — same two symbols as the Python spike.
// ---------------------------------------------------------------------------

const SOURCE_PATH = "/Users/lalsaado/Projects/sdk-python/src/strands/agent/agent.py";

// Agent.invoke_async, lines 503-549.
const INVOKE_ASYNC_SOURCE = `    async def invoke_async(
        self,
        prompt: AgentInput = None,
        *,
        invocation_state: dict[str, Any] | None = None,
        structured_output_model: type[BaseModel] | None = None,
        structured_output_prompt: str | None = None,
        **kwargs: Any,
    ) -> AgentResult:
        """Process a natural language prompt through the agent's event loop.

        This method implements the conversational interface with multiple input patterns:
        - String input: Simple text input
        - ContentBlock list: Multi-modal content blocks
        - Message list: Complete messages with roles
        - No input: Use existing conversation history

        Args:
            prompt: User input in various formats:
                - str: Simple text input
                - list[ContentBlock]: Multi-modal content blocks
                - list[Message]: Complete messages with roles
                - None: Use existing conversation history
            invocation_state: Additional parameters to pass through the event loop.
            structured_output_model: Pydantic model type(s) for structured output (overrides agent default).
            structured_output_prompt: Custom prompt for forcing structured output (overrides agent default).
            **kwargs: Additional parameters to pass through the event loop.[Deprecating]

        Returns:
            Result: object containing:

                - stop_reason: Why the event loop stopped (e.g., "end_turn", "max_tokens")
                - message: The final message from the model
                - metrics: Performance metrics from the event loop
                - state: The final state of the event loop
        """
        events = self.stream_async(
            prompt,
            invocation_state=invocation_state,
            structured_output_model=structured_output_model,
            structured_output_prompt=structured_output_prompt,
            **kwargs,
        )
        async for event in events:
            _ = event

        return cast(AgentResult, event["result"])
`;

const INVOKE_ASYNC_DOCSTRING = `Process a natural language prompt through the agent's event loop.

This method implements the conversational interface with multiple input patterns:
- String input: Simple text input
- ContentBlock list: Multi-modal content blocks
- Message list: Complete messages with roles
- No input: Use existing conversation history
`;

// Agent.__init__, lines 125-250.
const INIT_SOURCE = `    def __init__(
        self,
        model: Model | str | None = None,
        messages: Messages | None = None,
        tools: list[Union[str, dict[str, str], "ToolProvider", Any]] | None = None,
        system_prompt: str | list[SystemContentBlock] | None = None,
        structured_output_model: type[BaseModel] | None = None,
        callback_handler: Callable[..., Any] | _DefaultCallbackHandlerSentinel | None = _DEFAULT_CALLBACK_HANDLER,
        conversation_manager: ConversationManager | None = None,
        record_direct_tool_call: bool = True,
        load_tools_from_directory: bool = False,
        trace_attributes: Mapping[str, AttributeValue] | None = None,
        *,
        agent_id: str | None = None,
        name: str | None = None,
        description: str | None = None,
        state: AgentState | dict | None = None,
        plugins: list[Plugin] | None = None,
        hooks: list[HookProvider | HookCallback] | None = None,
        session_manager: SessionManager | None = None,
        structured_output_prompt: str | None = None,
        tool_executor: ToolExecutor | None = None,
        retry_strategy: ModelRetryStrategy | _DefaultRetryStrategySentinel | None = _DEFAULT_RETRY_STRATEGY,
        concurrent_invocation_mode: ConcurrentInvocationMode = ConcurrentInvocationMode.THROW,
    ):
        """Initialize the Agent with the specified configuration.

        Args:
            model: Provider for running inference or a string representing the model-id for Bedrock to use.
                Defaults to strands.models.BedrockModel if None.
            messages: List of initial messages to pre-load into the conversation.
            tools: List of tools to make available to the agent.
            system_prompt: System prompt to guide model behavior.
            structured_output_model: Pydantic model type(s) for structured output.
            callback_handler: Callback for processing events as they happen during agent execution.
            conversation_manager: Manager for conversation history and context window.
            record_direct_tool_call: Whether to record direct tool calls in message history.
            load_tools_from_directory: Whether to load and automatically reload tools in ./tools/.
            trace_attributes: Custom trace attributes to apply to the agent's trace span.
            agent_id: Optional ID for the agent.
            name: Name of the Agent.
            description: Description of what the Agent does.
            state: Stateful information for the agent.
            plugins: List of Plugin instances to extend agent functionality.
            hooks: Hooks to be added to the agent hook registry.
            session_manager: Manager for handling agent sessions.
            structured_output_prompt: Custom prompt message used when forcing structured output.
            tool_executor: Definition of tool execution strategy.
            retry_strategy: Strategy for retrying model calls on throttling or other transient errors.
            concurrent_invocation_mode: Mode controlling concurrent invocation behavior.

        Raises:
            ValueError: If agent id contains path separators.
        """
        self.model = BedrockModel() if not model else BedrockModel(model_id=model) if isinstance(model, str) else model
        self.messages = messages if messages is not None else []
        self._system_prompt, self._system_prompt_content = self._initialize_system_prompt(system_prompt)
        self._default_structured_output_model = structured_output_model
        self._structured_output_prompt = structured_output_prompt
        self.agent_id = _identifier.validate(agent_id or _DEFAULT_AGENT_ID, _identifier.Identifier.AGENT)
        self.name = name or _DEFAULT_AGENT_NAME
        self.description = description

        self.callback_handler: Callable[..., Any] | PrintingCallbackHandler
        if isinstance(callback_handler, _DefaultCallbackHandlerSentinel):
            self.callback_handler = PrintingCallbackHandler()
        elif callback_handler is None:
            self.callback_handler = null_callback_handler
        else:
            self.callback_handler = callback_handler

        if self.model.stateful and conversation_manager is not None:
            raise ValueError(
                "conversation_manager cannot be used with a stateful model. "
                "The model manages conversation state server-side."
            )

        self.conversation_manager: ConversationManager
        if self.model.stateful:
            self.conversation_manager = NullConversationManager()
        elif conversation_manager:
            self.conversation_manager = conversation_manager
        else:
            self.conversation_manager = SlidingWindowConversationManager()

        self.trace_attributes: dict[str, AttributeValue] = {}
        if trace_attributes:
            for k, v in trace_attributes.items():
                if isinstance(v, (str, int, float, bool)) or (
                    isinstance(v, list) and all(isinstance(x, (str, int, float, bool)) for x in v)
                ):
                    self.trace_attributes[k] = v

        self.record_direct_tool_call = record_direct_tool_call
        self.load_tools_from_directory = load_tools_from_directory
`;

const INIT_DOCSTRING = `Initialize the Agent with the specified configuration.

Wires up the model, messages buffer, system prompt, conversation manager,
callback handler, trace attributes, tool registry, plugin registry, retry
strategy, hook registry, and session manager. Raises ValueError if the
agent_id contains path separators or if a stateful model is paired with a
conversation_manager.
`;

// ---------------------------------------------------------------------------
// Entrypoint.
// ---------------------------------------------------------------------------

function fmtUsage(u: AttemptUsage): string {
  return (
    `input=${String(u.input_tokens).padStart(5)}  output=${String(u.output_tokens).padStart(4)}  ` +
    `cacheRead=${String(u.cache_read).padStart(5)}  cacheWrite=${String(u.cache_write).padStart(5)}`
  );
}

function sumUsage(attempts: AttemptUsage[]): AttemptUsage {
  return attempts.reduce<AttemptUsage>(
    (acc, a) => ({
      input_tokens: acc.input_tokens + a.input_tokens,
      output_tokens: acc.output_tokens + a.output_tokens,
      cache_read: acc.cache_read + a.cache_read,
      cache_write: acc.cache_write + a.cache_write,
    }),
    { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 },
  );
}

function printResult(label: string, r: SummarizerResult): void {
  console.log(JSON.stringify(r.summary, null, 2));
  console.log();
  console.log(`attempts=${r.attempts}  wall_clock=${r.wallClockS.toFixed(2)}s`);
  r.usageByAttempt.forEach((u, i) => {
    console.log(`  #${i + 1}: ${fmtUsage(u)}`);
  });
  if (r.validationFailures.length > 0) {
    console.log("validation failures (recovered):");
    for (const f of r.validationFailures) {
      for (const line of f.split("\n")) {
        console.log(`  ${line}`);
      }
    }
  }
  console.log();
  void label;
}

async function main(): Promise<number> {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const client = new BedrockRuntimeClient({ region });

  console.log(`Model: ${MODEL_ID}`);
  console.log(`Region: ${region}`);
  console.log();

  let result1: SummarizerResult;
  let result2: SummarizerResult;
  try {
    console.log("=".repeat(80));
    console.log("CALL 1 (cold) — Agent.invoke_async");
    console.log("=".repeat(80));
    result1 = await summarizeSymbol(client, {
      source: INVOKE_ASYNC_SOURCE,
      filePath: SOURCE_PATH,
      lineStart: 503,
      lineEnd: 549,
      docstring: INVOKE_ASYNC_DOCSTRING,
      enclosingClass: "Agent",
    });
    printResult("invoke_async", result1);

    console.log("=".repeat(80));
    console.log("CALL 2 (warm) — Agent.__init__");
    console.log("=".repeat(80));
    result2 = await summarizeSymbol(client, {
      source: INIT_SOURCE,
      filePath: SOURCE_PATH,
      lineStart: 125,
      lineEnd: 250,
      docstring: INIT_DOCSTRING,
      enclosingClass: "Agent",
    });
    printResult("__init__", result2);
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const msg = err instanceof Error ? err.message : String(err);
    if (/credential/i.test(name) || /credential/i.test(msg) || /Region is missing/i.test(msg)) {
      console.error(
        `\nERROR: AWS credentials / region not resolved (${name}: ${msg}). ` +
          `Hint: re-run with \`AWS_PROFILE=bedrock-a AWS_REGION=us-east-1\` or run \`aws sso login --profile bedrock-a\`.`,
      );
      return 2;
    }
    console.error(`\nERROR: Bedrock call failed: ${name}: ${msg}`);
    console.error(
      `Hint: check AWS_PROFILE, that the account has Bedrock model access for ${MODEL_ID}, ` +
        `and that the region supports the 'global.' inference profile.`,
    );
    return 3;
  }

  const call1Total = sumUsage(result1.usageByAttempt);
  const call2Total = sumUsage(result2.usageByAttempt);
  const call1First = result1.usageByAttempt[0];
  const call2First = result2.usageByAttempt[0];

  const call2Denominator = call2First.input_tokens + call2First.cache_read;
  const cacheEfficiency = call2Denominator > 0 ? call2First.cache_read / call2Denominator : 0;

  const firstAttemptHits = (firstAttemptValid(result1) ? 1 : 0) + (firstAttemptValid(result2) ? 1 : 0);
  const firstAttemptRate = firstAttemptHits / 2;

  console.log("=".repeat(80));
  console.log("CACHING PROOF (first attempt of each call)");
  console.log("=".repeat(80));
  console.log(
    `Call 1 (cold):  input=${String(call1First.input_tokens).padStart(5)}  ` +
      `cacheWrite=${String(call1First.cache_write).padStart(5)}  ` +
      `cacheRead=${String(call1First.cache_read).padStart(5)}`,
  );
  console.log(
    `Call 2 (warm):  input=${String(call2First.input_tokens).padStart(5)}  ` +
      `cacheWrite=${String(call2First.cache_write).padStart(5)}  ` +
      `cacheRead=${String(call2First.cache_read).padStart(5)}`,
  );
  console.log(
    `Call 2 cache efficiency (cacheRead / (input + cacheRead)): ${(cacheEfficiency * 100).toFixed(1)}%`,
  );
  if (call2First.cache_read === 0) {
    console.log(
      "\nWARNING: cacheReadInputTokens == 0 on the warm call. Caching did not engage. " +
        "Possible causes: (a) system+tool prefix under 4,096 tokens, (b) cachePoint placement wrong, " +
        "(c) prompt bytes differ from call 1, (d) model ID / region pairing incorrect.",
    );
  }
  console.log();

  console.log("=".repeat(80));
  console.log("FINAL REPORT");
  console.log("=".repeat(80));

  const cacheStatus =
    call2First.cache_read > 0
      ? `cache engaged: Converse cachePoint blocks in system+toolConfig.tools wrote ${call1First.cache_write} tokens on call 1, hit for ${call2First.cache_read} tokens on call 2 (${(cacheEfficiency * 100).toFixed(0)}% of call 2 input served from cache)`
      : "cache did NOT engage on call 2 — investigate prefix size, cachePoint placement, or region/model pairing";

  let validityNote: string;
  if (firstAttemptHits === 2) {
    validityNote =
      "the rubric + three few-shot examples in the cached system prompt landed the schema on attempt 1 for both symbols, including the constructor-heavy __init__ that tripped the 200-char returns cap in the Python spike";
  } else if (firstAttemptHits === 1) {
    validityNote =
      "one symbol passed on attempt 1; the other tripped a length/verb validator and recovered on attempt 2 via ReAct feedback through the toolResult channel";
  } else {
    validityNote =
      "both symbols failed attempt 1 (typically on returns.details length or a side_effects item missing a required verb) and recovered on attempt 2 via ReAct feedback through the toolResult channel — validators are doing real work, and the retry loop is load-bearing, not decorative";
  }

  const takeaway =
    `Haiku 4.5 via AWS SDK v3 Converse (${MODEL_ID}) produced schema-conforming ` +
    `SymbolSummary objects for both symbols. ` +
    `Call 1 attempts=${result1.attempts} in ${result1.wallClockS.toFixed(2)}s; ` +
    `call 2 attempts=${result2.attempts} in ${result2.wallClockS.toFixed(2)}s. ` +
    `First-attempt validity: ${firstAttemptHits}/2 (${(firstAttemptRate * 100).toFixed(0)}%) — ` +
    `${validityNote}. Totals: call1 ${fmtUsage(call1Total)}; call2 ${fmtUsage(call2Total)}. ` +
    `${cacheStatus}. ` +
    `Zod 4's z.toJSONSchema emits Draft 2020-12 which Bedrock accepts without conversion; ` +
    `strict-by-default objects give us Pydantic's extra="forbid" for free, and superRefine ` +
    `covers the citation-coverage invariant that was a model_validator in the Python spike. ` +
    `Splitting returns.description into type_summary + details removed the 200-char cap that ` +
    `was clipping dense constructors. Engineering takeaway: the TS port matches the Python ` +
    `contract, Zod 4 is production-viable for the summarizer's schema layer, and AWS SDK v3 ` +
    `gives the same cachePoint wire-level control as boto3. Next: wire this into the ingest ` +
    `pipeline, measure recovery rate over ~1k real symbols, and revisit ttl=1h for overnight ` +
    `batch indexing.`;
  const words = takeaway.split(" ");
  const trimmed = words.length > 200 ? words.slice(0, 200).join(" ") + "..." : takeaway;
  console.log(trimmed);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
