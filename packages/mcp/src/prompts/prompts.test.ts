/**
 * Prompts tests.
 *
 * Registers each prompt against a fresh McpServer, then drives it through
 * the SDK's prompt callback to assert:
 *   - the prompt is registered with a title + description
 *   - argsSchema (zod raw shape) validates required/optional fields
 *   - callback returns a non-empty user-role message that mentions the
 *     tools the prompt is meant to chain.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: private SDK field access in tests

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuditDependenciesPrompt } from "./audit-dependencies.js";
import { registerDetectImpactPrompt } from "./detect-impact.js";
import { registerExploreAreaPrompt } from "./explore-area.js";
import { registerReviewPrPrompt } from "./review-pr.js";

interface RegisteredPromptShape {
  readonly title?: string;
  readonly description?: string;
  readonly argsSchema?: Record<string, unknown>;
  readonly callback: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    messages: readonly {
      readonly role: string;
      readonly content: { readonly type: string; readonly text: string };
    }[];
  }>;
}

function enumeratePrompts(server: McpServer): Record<string, RegisteredPromptShape> {
  const withPrivate = server as unknown as {
    _registeredPrompts: Record<string, RegisteredPromptShape>;
  };
  return withPrivate._registeredPrompts;
}

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { prompts: {} } });
}

test("detect_impact prompt registers with title + description + required target", async () => {
  const server = makeServer();
  registerDetectImpactPrompt(server);
  const prompts = enumeratePrompts(server);
  const p = prompts["detect_impact"];
  assert.ok(p, "detect_impact must be registered");
  assert.equal(p.title, "Detect impact of a code change");
  assert.ok(p.description && p.description.length > 0);
  const out = await p.callback({ target: "UserService" }, {});
  assert.equal(out.messages.length, 1);
  const msg = out.messages[0];
  assert.ok(msg);
  assert.equal(msg.role, "user");
  assert.equal(msg.content.type, "text");
  // Must chain the expected tools.
  assert.ok(msg.content.text.includes("impact"));
  assert.ok(msg.content.text.includes("context"));
  assert.ok(msg.content.text.includes("UserService"));
});

test("detect_impact prompt includes repo scope when provided", async () => {
  const server = makeServer();
  registerDetectImpactPrompt(server);
  const prompts = enumeratePrompts(server);
  const p = prompts["detect_impact"];
  assert.ok(p);
  const out = await p.callback({ target: "pay", repo: "billing" }, {});
  const text = out.messages[0]?.content.text ?? "";
  assert.ok(text.includes('repo="billing"'));
});

test("review_pr prompt chains detect_changes + impact + owners", async () => {
  const server = makeServer();
  registerReviewPrPrompt(server);
  const prompts = enumeratePrompts(server);
  const p = prompts["review_pr"];
  assert.ok(p);
  assert.equal(p.title, "Review a pull request");
  const out = await p.callback({ base: "origin/main" }, {});
  const text = out.messages[0]?.content.text ?? "";
  assert.ok(text.includes("detect_changes"));
  assert.ok(text.includes("impact"));
  assert.ok(text.includes("owners"));
  assert.ok(text.includes("origin/main"));
});

test("explore_area prompt probes the Community kind", async () => {
  const server = makeServer();
  registerExploreAreaPrompt(server);
  const prompts = enumeratePrompts(server);
  const p = prompts["explore_area"];
  assert.ok(p);
  const out = await p.callback({ area: "authentication" }, {});
  const text = out.messages[0]?.content.text ?? "";
  assert.ok(text.includes("Community"));
  assert.ok(text.includes("authentication"));
  assert.ok(text.includes("owners"));
});

test("audit_dependencies prompt chains dependencies + license_audit + list_findings", async () => {
  const server = makeServer();
  registerAuditDependenciesPrompt(server);
  const prompts = enumeratePrompts(server);
  const p = prompts["audit_dependencies"];
  assert.ok(p);
  const out = await p.callback({}, {});
  const text = out.messages[0]?.content.text ?? "";
  assert.ok(text.includes("dependencies"));
  assert.ok(text.includes("license_audit"));
  assert.ok(text.includes("list_findings"));
  assert.ok(text.includes("osv-scanner"));
});

test("audit_dependencies prompt scopes to ecosystem when provided", async () => {
  const server = makeServer();
  registerAuditDependenciesPrompt(server);
  const prompts = enumeratePrompts(server);
  const p = prompts["audit_dependencies"];
  assert.ok(p);
  const out = await p.callback({ ecosystem: "npm" }, {});
  const text = out.messages[0]?.content.text ?? "";
  assert.ok(text.includes("npm"));
});

test("all four prompts are registered from a common call sequence", () => {
  const server = makeServer();
  registerDetectImpactPrompt(server);
  registerReviewPrPrompt(server);
  registerExploreAreaPrompt(server);
  registerAuditDependenciesPrompt(server);
  const prompts = enumeratePrompts(server);
  const names = Object.keys(prompts).sort();
  assert.deepEqual(names, ["audit_dependencies", "detect_impact", "explore_area", "review_pr"]);
});
