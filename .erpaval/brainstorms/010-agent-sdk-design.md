# 010 — `@opencodehub/agent-sdk`: The Thin Grounding Wrapper

*Draft: 2026-04-27. Inputs: 009 (remote MCP surface, `grounding_pack` / `policy_evaluate` / `provenance_record`). This memo designs the client-side SDK any agent framework drops in. Target audience: framework authors and in-house agent teams.*

Agent frameworks don't need a new retrieval system. They need a single call that returns a grounded prompt block, a single call that returns a merge verdict, and a context manager that writes the provenance manifest on exit. The SDK is thin on purpose — any intelligence lives server-side in `packages/mcp-http/`.

## Package layout

- `packages/agent-sdk-py/`  → published as `opencodehub-agent-sdk` on PyPI.
- `packages/agent-sdk-ts/`  → published as `@opencodehub/agent-sdk` on npm.

Python is primary because Claude Agent SDK and LangGraph are Python-first; TypeScript is secondary for Vercel AI SDK and LangGraph JS. Both expose the same surface in idiomatic form.

```bash
pip install opencodehub-agent-sdk
pnpm add @opencodehub/agent-sdk
```

## Python core API

```python
# opencodehub_agent_sdk/grounding.py
from contextlib import asynccontextmanager
from pydantic import BaseModel, Field
from datetime import datetime

class Symbol(BaseModel):
    name: str
    kind: str
    path: str
    loc: str
    summary: str

class BlastRadius(BaseModel):
    upstream: list[dict]
    downstream: list[dict]
    tier: int = Field(ge=1, le=5)

class GroundingResult(BaseModel):
    graph_hash: str
    repo_profile: dict
    relevant_symbols: list[Symbol]
    blast_radius: BlastRadius
    owners: list[dict]
    prior_findings: list[dict]
    group_contracts: list[dict] | None = None
    arch_invariants: list[dict] = Field(default_factory=list)

    def as_system_block(self) -> str:
        """Render the grounded prompt block (see Section: Prompt injection)."""
        ...

class VerdictRule(BaseModel):
    id: str
    type: str
    outcome: str               # "pass" | "fail" | "needs-review"
    evidence: dict
    blocked_merge: bool

class VerdictResult(BaseModel):
    graph_hash: str
    pr_ref: str
    overall: str               # "pass" | "fail" | "needs-review"
    rules: list[VerdictRule]
    auto_approve: bool
    required_reviewers: list[str]

class ToolCall(BaseModel):
    name: str
    at: datetime
    input_digest: str
    output_digest: str

class Grounding:
    def __init__(
        self,
        endpoint: str,
        token: str,
        repo: str,
        group: str | None = None,
        strict: bool = True,
    ) -> None:
        self.endpoint, self.token, self.repo, self.group, self.strict = (
            endpoint, token, repo, group, strict
        )
        self._client = _McpHttpClient(endpoint, token)
        self._session_graph_hash: str | None = None
        self._calls: list[ToolCall] = []

    async def ground(
        self,
        task: str,
        target_files: list[str] | None = None,
        max_tokens: int = 8192,
    ) -> GroundingResult:
        result = await self._client.call("grounding_pack", {
            "repo": self.repo, "task_description": task,
            "target_files": target_files, "max_tokens": max_tokens,
        })
        if self._session_graph_hash is None:
            self._session_graph_hash = result["graph_hash"]
        elif self.strict and result["graph_hash"] != self._session_graph_hash:
            raise GraphDriftError(self._session_graph_hash, result["graph_hash"])
        self._record("grounding_pack", result)
        return GroundingResult.model_validate(result)

    async def verdict(
        self, pr_ref: str, policy_path: str | None = None,
    ) -> VerdictResult:
        result = await self._client.call("policy_evaluate", {
            "repo": self.repo, "pr_ref": pr_ref, "policy_path": policy_path,
        })
        self._record("policy_evaluate", result)
        return VerdictResult.model_validate(result)

    async def record_provenance(
        self, pr_ref: str, grounding: GroundingResult,
        tools_called: list[ToolCall],
    ) -> None:
        await self._client.call("provenance_record", {
            "repo": self.repo, "pr_ref": pr_ref,
            "graph_hash": grounding.graph_hash,
            "tools_called": [t.model_dump(mode="json") for t in tools_called],
        })

    @asynccontextmanager
    async def session(self, pr_ref: str):
        sess = GroundingSession(self, pr_ref)
        try:
            yield sess
        finally:
            if sess.last_grounding is not None:
                await self.record_provenance(pr_ref, sess.last_grounding, list(self._calls))

class GroundingSession:
    def __init__(self, parent: Grounding, pr_ref: str) -> None:
        self._g, self.pr_ref = parent, pr_ref
        self.last_grounding: GroundingResult | None = None

    async def ground(self, task: str, **kw) -> GroundingResult:
        self.last_grounding = await self._g.ground(task, **kw)
        return self.last_grounding

    async def verdict(self) -> VerdictResult:
        return await self._g.verdict(self.pr_ref)
```

`_record` appends to `self._calls` with input/output SHA-256 digests so that the session exit can reconstruct the provenance manifest without replaying tools. `GraphDriftError` fires when the index moves mid-session; agents can catch it, re-ground, or override with `strict=False`.

TypeScript mirrors this surface: `class Grounding`, `async ground()`, `async verdict()`, `async withSession(prRef, async (session) => { … })`. Types are generated from the same JSON schemas that the server uses.

## Integration examples

### 1. Claude Agent SDK (Python)

```python
# agent.py
import os, asyncio
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions
from opencodehub_agent_sdk import Grounding

async def main():
    g = Grounding(
        endpoint=os.environ["OPENCODEHUB_ENDPOINT"],
        token=os.environ["OPENCODEHUB_TOKEN"],
        repo=os.environ["GITHUB_REPOSITORY"],
    )
    async with g.session(pr_ref=os.environ["GITHUB_PR_REF"]) as sess:
        pack = await sess.ground(
            task="add rate limiting to the GraphQL mutation handlers",
            target_files=["packages/api/src/graphql/mutations.ts"],
        )

        opts = ClaudeAgentOptions(
            model="claude-opus-4-7",
            system_prompt=f"{DEFAULT_SYSTEM}\n\n{pack.as_system_block()}",
            allowed_tools=["Read", "Edit", "Bash"],
        )
        async with ClaudeSDKClient(options=opts) as client:
            await client.query("Implement the task described in the grounding block.")
            async for msg in client.receive_response():
                print(msg)

        verdict = await sess.verdict()
        if verdict.overall == "fail":
            raise SystemExit(f"policy failed: {verdict.rules}")

asyncio.run(main())
```

### 2. Vercel AI SDK (TypeScript)

```typescript
// agent.ts
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Grounding } from "@opencodehub/agent-sdk";

const g = new Grounding({
  endpoint: process.env.OPENCODEHUB_ENDPOINT!,
  token:    process.env.OPENCODEHUB_TOKEN!,
  repo:     process.env.GITHUB_REPOSITORY!,
});

await g.withSession(process.env.GITHUB_PR_REF!, async (sess) => {
  const pack = await sess.ground({
    task: "add rate limiting to the GraphQL mutation handlers",
    targetFiles: ["packages/api/src/graphql/mutations.ts"],
  });

  const { text } = await generateText({
    model: anthropic("claude-opus-4-7"),
    system: pack.asSystemBlock(),
    prompt: "Produce a unified diff implementing the task.",
  });
  await fs.writeFile(".opencodehub/plan.diff", text);

  const verdict = await sess.verdict();
  if (verdict.overall === "fail") process.exit(1);
});
```

### 3. Framework-agnostic OpenAI tool loop (Python)

```python
# openai_loop.py
import json, os
from openai import OpenAI
from opencodehub_agent_sdk import Grounding, ToolCall
from datetime import datetime, UTC

client = OpenAI()
g = Grounding(endpoint=os.environ["OPENCODEHUB_ENDPOINT"],
              token=os.environ["OPENCODEHUB_TOKEN"],
              repo=os.environ["GITHUB_REPOSITORY"])

async def run(task: str, pr_ref: str):
    async with g.session(pr_ref) as sess:
        pack = await sess.ground(task=task)
        messages = [
            {"role": "system", "content": pack.as_system_block()},
            {"role": "user", "content": task},
        ]
        while True:
            resp = client.chat.completions.create(
                model="gpt-4.1", messages=messages,
                tools=[{"type": "function", "function": {"name": "edit_file",
                        "parameters": {"type": "object",
                        "properties": {"path": {"type": "string"},
                                       "patch": {"type": "string"}}}}}])
            choice = resp.choices[0]
            if choice.finish_reason == "stop":
                break
            for call in choice.message.tool_calls or []:
                apply_patch(json.loads(call.function.arguments))
                messages.append({"role": "tool", "tool_call_id": call.id, "content": "ok"})

        verdict = await sess.verdict()
        return verdict
```

### 4. LangGraph node (Python)

```python
# langgraph_nodes.py
from langgraph.graph import StateGraph
from opencodehub_agent_sdk import Grounding, GroundingResult

class GroundingNode:
    def __init__(self, grounding: Grounding) -> None:
        self.g = grounding

    async def __call__(self, state: dict) -> dict:
        task = state["task"]
        pack: GroundingResult = await self.g.ground(
            task=task, target_files=state.get("target_files"),
        )
        return {**state, "grounding": pack, "system_prompt": pack.as_system_block()}

class VerdictNode:
    def __init__(self, grounding: Grounding) -> None:
        self.g = grounding

    async def __call__(self, state: dict) -> dict:
        v = await self.g.verdict(pr_ref=state["pr_ref"])
        return {**state, "verdict": v, "should_merge": v.auto_approve}

graph = StateGraph(dict)
graph.add_node("ground",  GroundingNode(grounding))
graph.add_node("plan",    plan_node)         # user-defined LLM node
graph.add_node("execute", execute_node)
graph.add_node("verdict", VerdictNode(grounding))
graph.add_edge("ground",  "plan")
graph.add_edge("plan",    "execute")
graph.add_edge("execute", "verdict")
```

## Prompt injection pattern

`GroundingResult.as_system_block()` produces clean Markdown that LLMs parse reliably:

```markdown
# Repository grounding (OpenCodeHub)

You are editing **github.com/acme/payments-api** (graph_hash `sha256:8f3c…`).
Node 22 monorepo, GraphQL API over Postgres, 42 packages.
Entrypoints: `packages/api/src/server.ts`, `packages/worker/src/main.ts`.

## Task
Add rate limiting to the GraphQL mutation handlers.

## Relevant symbols (top 2)
- `createPayment` — function at `packages/api/src/graphql/mutations.ts:L42-L91`.
  Mutation resolver; calls `PaymentService.create`; no throttling.
- `refundPayment` — function at `packages/api/src/graphql/mutations.ts:L93-L140`.
  Mutation resolver; calls `PaymentService.refund`.

## Blast radius — tier 2 (high)
Touching these files affects 1 upstream and 2 downstream symbols.
- Upstream:   `graphqlServer` (packages/api/src/server.ts)
- Downstream: `PaymentService.create` (packages/core/src/payment.ts),
              `metricsEmit`           (packages/obs/src/metrics.ts)

## Owners to notify
- `packages/api/**`  → @api-team
- `packages/core/**` → @payments-core

## Prior findings on touched files
- [warning] **no-unbounded-loops** at `packages/api/src/graphql/mutations.ts`
  L67 unbounded forEach over user input.

## Architectural invariants (must not violate)
- **db-access-only-in-storage** — only `packages/storage/**` may touch `db` directly.

## Rules for your output
1. Do not modify files outside `packages/api/**` without explicit owner approval.
2. Preserve the listed invariants. Your plan will be re-evaluated by `policy_evaluate` before merge.
3. Cite file paths and line ranges you touched in your final summary.
```

Sections are elided when empty (no group contracts in this example). The block is stable across calls so prompt caches hit.

## Auth flow

1. Org installs the **OpenCodeHub GitHub App** on the relevant repos/groups.
2. At workflow start, the `opencodehub/verdict-action@v1` action exchanges the GitHub OIDC token for a short-lived OpenCodeHub JWT against the auth service. Scope = `(install_id, repo, pr_ref)`, TTL 60 minutes.
3. The JWT lands in the workflow env as `OPENCODEHUB_TOKEN`. The SDK reads it on construction.
4. The SDK passes `Authorization: Bearer <jwt>` on every MCP call plus `X-Codehub-Graph-Hash` when the caller wants to pin a specific graph version.

No long-lived secrets in workflows. Token rotation is automatic because CI re-runs mint fresh tokens.

## Triggers and telemetry

- Every `ground()` / `verdict()` call appends a `ToolCall` record to the in-memory ledger with input/output SHA-256 digests.
- `graph_hash` is captured on first `ground()`; subsequent calls compare and raise `GraphDriftError` under `strict=True` (default). This maps the "reproducibility boundary" contract from 005 onto the remote plane — if the index moved, the session is not reproducible and the agent must decide.
- On session exit (`__aexit__`), `record_provenance()` fires, writing the manifest described in 009 §7.
- A `Grounding(debug=True)` constructor flag emits OTel spans (`otel.semconv: llm.*`) per MCP call for observability stacks that already sample them.

---

This is a 500-line implementation at most. The complexity is on the server (009) and in the CI playbook (011). The SDK's job is to make the pattern a two-line import for any agent author.
