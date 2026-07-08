import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  type Action,
  actionsFromClaudeStreamJson,
  actionsFromCodexJsonl,
  isShellReadSearch,
  isValidationCommand,
  normalizeQuery,
  shellFirstWord,
} from "./trajectory.js";

describe("normalizeQuery", () => {
  it("trims and collapses internal whitespace, preserving case", () => {
    assert.equal(normalizeQuery("  foo   bar\tbaz "), "foo bar baz");
    assert.equal(normalizeQuery("Foo"), "Foo");
    assert.notEqual(normalizeQuery("Foo"), normalizeQuery("foo"));
  });
});

describe("shellFirstWord", () => {
  it("unwraps a shell -c wrapper (Codex's /bin/zsh -lc form)", () => {
    assert.equal(shellFirstWord("/bin/zsh -lc 'cat data.txt'"), "cat");
    assert.equal(shellFirstWord("bash -c \"find . -name '*.ts'\""), "find");
  });
  it("takes the basename of an absolute program path", () => {
    assert.equal(shellFirstWord("/usr/bin/rg pattern src/"), "rg");
  });
  it("skips leading VAR=value assignments and sudo/env/time", () => {
    assert.equal(shellFirstWord("FOO=1 BAR=2 grep -rn foo"), "grep");
    assert.equal(shellFirstWord("sudo find / -name x"), "find");
    assert.equal(shellFirstWord("env RUST_LOG=debug cargo test"), "cargo");
  });
  it("lower-cases and handles a bare command", () => {
    assert.equal(shellFirstWord("GREP foo"), "grep");
    assert.equal(shellFirstWord(""), "");
  });
});

describe("isShellReadSearch (Shell-over-Tool set)", () => {
  it("flags the frozen read/search program set", () => {
    for (const cmd of [
      "cat file",
      "head -n5 f",
      "tail f",
      "less f",
      "more f",
      "grep -rn foo .",
      "egrep x f",
      "rg pattern",
      "ag pattern",
      "find . -name '*.ts'",
      "/bin/zsh -lc 'grep -rn TODO src/'",
    ]) {
      assert.equal(isShellReadSearch(cmd), true, cmd);
    }
  });
  it("does NOT flag builds, tests, writes, or other commands", () => {
    for (const cmd of [
      "pnpm test",
      "node --test x.js",
      "python app.py",
      "git status",
      "sed -i s/a/b/ f",
    ]) {
      assert.equal(isShellReadSearch(cmd), false, cmd);
    }
  });
});

describe("isValidationCommand (Search Loop breaker)", () => {
  it("recognizes test/build/lint across ecosystems", () => {
    for (const cmd of [
      "pytest tests/",
      "python -m pytest -k foo",
      "python3 -m unittest",
      "tox",
      "pnpm run test",
      "npm test",
      "node --test ./dist/x.test.js",
      "vitest run",
      "tsc -b",
      "ruff check .",
      "cargo test",
      "go test ./...",
      "make check",
      "mvn test",
      "/bin/zsh -lc 'pnpm run build'",
    ]) {
      assert.equal(isValidationCommand(cmd), true, cmd);
    }
  });
  it("does NOT treat reads/searches/greps as validation", () => {
    for (const cmd of ["cat f", "grep -rn foo .", "ls -la", "echo hi", "git diff"]) {
      assert.equal(isValidationCommand(cmd), false, cmd);
    }
  });
});

describe("actionsFromClaudeStreamJson", () => {
  it("maps every built-in tool to its canonical action type", () => {
    const stream = [
      evt("Glob", { pattern: "**/*.ts" }),
      evt("Grep", { pattern: "  handleAuth " }),
      evt("Read", { file_path: "/src/a.ts" }),
      evt("Edit", { file_path: "/src/a.ts" }),
      evt("Write", { file_path: "/src/b.ts" }),
      evt("Bash", { command: "pnpm test" }),
      evt("Task", { subagent_type: "x" }),
      evt("TodoWrite", { todos: [] }),
      evt("WebFetch", { url: "https://x" }),
      evt("mcp__codehub__query", { query: "  Foo  bar " }),
      evt("mcp__codehub__impact", {}),
    ].join("\n");
    const actions = actionsFromClaudeStreamJson(stream);
    assert.deepEqual(actions, [
      { type: "search", query: "**/*.ts" },
      { type: "search", query: "handleAuth" }, // normalized
      { type: "file_read", target: "/src/a.ts" },
      { type: "file_write", target: "/src/a.ts" },
      { type: "file_write", target: "/src/b.ts" },
      { type: "command", command: "pnpm test" },
      { type: "spawn" },
      { type: "plan" },
      { type: "fetch", target: "https://x" },
      { type: "search", query: "Foo bar" }, // mcp query→search by name heuristic
      { type: "navigate" }, // unknown mcp tool → navigate (no detector reads it)
    ]);
  });

  it("maps assistant text/thinking blocks to reason and skips user/system/result events", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "go" },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t" }] },
      }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n");
    assert.deepEqual(actionsFromClaudeStreamJson(stream), [{ type: "reason" }, { type: "reason" }]);
  });

  it("tolerates non-JSON / blank lines", () => {
    const stream = ["", "  ", "not json", evt("Read", { file_path: "/x" })].join("\n");
    assert.deepEqual(actionsFromClaudeStreamJson(stream), [{ type: "file_read", target: "/x" }]);
  });
});

describe("actionsFromCodexJsonl", () => {
  it("maps command_execution, file_change, web_search, reasoning; skips agent_message", () => {
    const stream = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "cat f" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [
            { path: "/a", kind: "update" },
            { path: "/b", kind: "add" },
          ],
        },
      }),
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "how to x" } }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "..." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ].join("\n");
    assert.deepEqual(actionsFromCodexJsonl(stream), [
      { type: "command", command: "cat f" },
      { type: "file_write", target: "/a" },
      { type: "file_write", target: "/b" },
      { type: "search", query: "how to x" },
      { type: "reason" },
    ]);
  });

  it("ignores item.started twins (counts each item once at completion)", () => {
    const stream = [
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "cat f" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "cat f" },
      }),
    ].join("\n");
    assert.deepEqual(actionsFromCodexJsonl(stream), [{ type: "command", command: "cat f" }]);
  });
});

/** Build one Claude assistant tool_use event line. */
function evt(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name, input }] },
  });
}

// Type-only guard: Action is structurally what the detectors consume.
const _sample: Action = { type: "search", query: "x" };
void _sample;
