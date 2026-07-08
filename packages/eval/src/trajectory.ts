/**
 * Trajectory capture + normalization (Move 1 / arXiv:2607.06184 "TraceProbe").
 *
 * The variance probe captures each agent run's *outcome* (final text, tokens).
 * TraceProbe's insight is that the *trajectory* — the ordered action sequence —
 * carries diagnostic signal a pass/fail label hides: search loops, re-read
 * churn, redundant search. To score those, we first normalize every harness's
 * raw event stream into one canonical action list.
 *
 * The taxonomy is TraceProbe's **nine canonical action types** (§ "canonical
 * actions from a nine-type taxonomy: file read, file write, search, command,
 * sub-agent spawn, plan, navigate, fetch, and reason"). We keep the four
 * *structural* fields the deterministic INSIGHT detectors need — action type,
 * file target, normalized search query, and the raw command string — and drop
 * the semantic effect labels (failed / reverted), which need an LLM labeler and
 * are a v2 concern (see `insight.ts`).
 *
 * Faithfulness note: the detectors' "10-action window" is defined over this
 * full canonical list *including* `reason` actions, exactly as the paper does,
 * so our per-detector numbers are comparable to TraceProbe's own figures rather
 * than a bespoke tool-only variant.
 *
 * Both normalizers are pure functions of the captured stdout — no clock, no
 * filesystem — so a trajectory is a deterministic function of the run's bytes.
 */

/** TraceProbe's nine canonical action types. */
export type ActionType =
  | "file_read"
  | "file_write"
  | "search"
  | "command"
  | "spawn"
  | "plan"
  | "navigate"
  | "fetch"
  | "reason";

/**
 * One normalized action in a run's trajectory. Optional fields carry only the
 * signal the structural detectors read:
 *   - `target`  — canonical file path for `file_read`/`file_write`; URL for `fetch`.
 *   - `query`   — normalized search query for `search`.
 *   - `command` — raw command line for `command` (the shell-first-word and
 *                 validation classifiers derive from it).
 */
export interface Action {
  readonly type: ActionType;
  readonly target?: string;
  readonly query?: string;
  readonly command?: string;
}

/**
 * Normalize a search query for equality comparison (Redundant Search): trim and
 * collapse internal whitespace runs to a single space. Case is preserved —
 * agent search patterns are case-sensitive regexes, so `Foo` and `foo` are
 * genuinely different queries.
 */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Recover the real program name from a command line, unwrapping the shell
 * invocation harnesses wrap commands in (Codex emits `/bin/zsh -lc '<inner>'`;
 * Claude Bash runs bare). Strips a leading shell wrapper, then leading
 * `sudo` / `command` / `env` and `VAR=value` assignments, then returns the
 * basename of the program token, lower-cased. Returns "" when empty.
 *
 * Examples:
 *   "/bin/zsh -lc 'cat data.txt'"      → "cat"
 *   "grep -rn foo src/"                → "grep"
 *   "FOO=1 /usr/bin/rg pattern"        → "rg"
 *   "bash -c \"find . -name '*.ts'\""  → "find"
 */
export function shellFirstWord(command: string): string {
  const inner = unwrapShell(command).trim();
  const tokens = inner.split(/\s+/);
  let i = 0;
  // Skip leading VAR=value assignments and trivial prefixes.
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t === "sudo" || t === "command" || t === "env" || t === "time") {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i += 1;
      continue;
    }
    break;
  }
  const program = tokens[i] ?? "";
  const base = program.split("/").pop() ?? program;
  return base.toLowerCase();
}

/** Shell wrappers seen from the harnesses, e.g. `/bin/zsh -lc '<inner>'`. */
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-[A-Za-z]*c\s+(.*)$/;

/** Unwrap one layer of `sh -c '<inner>'` / `zsh -lc "<inner>"`, else identity. */
function unwrapShell(command: string): string {
  const m = SHELL_WRAPPER.exec(command);
  if (m?.[1] === undefined) return command;
  return stripOuterQuotes(m[1].trim());
}

/** Strip one matched layer of surrounding single or double quotes. */
function stripOuterQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === "'" || first === '"') && last === first) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Programs whose use is a "read" or "search" done through the shell instead of
 * a structured tool — the Shell-over-Tool anti-pattern's frozen set (grep
 * family, rg/ag, find, and the pager/cat readers).
 */
const SHELL_READ_SEARCH_PROGRAMS: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "find",
]);

/** True when a command's unwrapped program is in the shell read/search set. */
export function isShellReadSearch(command: string): boolean {
  return SHELL_READ_SEARCH_PROGRAMS.has(shellFirstWord(command));
}

/**
 * Heuristic validation-command classifier (Search Loop reset condition): does
 * this command run tests / a build / a linter? A run of search+read actions is
 * "broken" by a validation command — the agent stopped hunting and checked its
 * work. Matched against the unwrapped command line, so wrapper-nested test runs
 * still classify. Deliberately broad across the common ecosystems; it is a
 * documented heuristic, not an exhaustive oracle.
 */
export function isValidationCommand(command: string): boolean {
  const inner = unwrapShell(command);
  return VALIDATION_PATTERNS.some((re) => re.test(inner));
}

const VALIDATION_PATTERNS: readonly RegExp[] = [
  /\b(pytest|py\.test)\b/,
  /\bpython[0-9.]*\s+-m\s+(pytest|unittest|tox|nose2?)\b/,
  /\b(tox|nox)\b/,
  /\bunittest\b/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b/,
  /\bnode\s+--test\b/,
  /\b(vitest|jest|mocha|ava|tap)\b/,
  /\b(tsc|biome|eslint|ruff|mypy|pyright)\b/,
  /\bcargo\s+(test|build|check|clippy|nextest)\b/,
  /\bgo\s+(test|build|vet)\b/,
  /\b(make|ctest|cmake)\b/,
  /\b(mvn|gradle|gradlew)\b/,
  /\b(phpunit|rspec|rake\s+test)\b/,
  /\bbazel\s+(test|build)\b/,
  /\bdotnet\s+test\b/,
];

/* ────────────────────────────── Claude Code ────────────────────────────── */

/**
 * Normalize Claude Code's `--output-format stream-json --verbose` JSONL into a
 * canonical action list. Each `assistant` event's `message.content[]` blocks
 * become actions in order: `thinking`/`text` → `reason`, `tool_use` → the
 * mapped action. `user` (tool_result) and `system`/`result` events carry no
 * agent action and are skipped. Non-JSON / partial lines are tolerated.
 *
 * Tool → action mapping (built-in tool `input` shapes are grounded against
 * Claude Code 2.1.x): Read→file_read, Write/Edit/NotebookEdit→file_write,
 * Grep/Glob→search, Bash→command, Task/Agent→spawn, TodoWrite/TaskCreate/
 * TaskUpdate→plan, WebFetch/WebSearch→fetch. Unknown tools (including OCH's own
 * `mcp__…` graph tools) map by a name heuristic, defaulting to `navigate` so an
 * unclassified tool never masquerades as a read/search/write/command and skews
 * a detector.
 */
export function actionsFromClaudeStreamJson(stdout: string): Action[] {
  const actions: Action[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof evt !== "object" || evt === null) continue;
    const e = evt as { type?: unknown; message?: { content?: unknown } };
    if (e.type !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const action = claudeBlockToAction(block);
      if (action !== undefined) actions.push(action);
    }
  }
  return actions;
}

function claudeBlockToAction(block: unknown): Action | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const b = block as { type?: unknown; name?: unknown; input?: unknown };
  if (b.type === "thinking" || b.type === "text") return { type: "reason" };
  if (b.type !== "tool_use" || typeof b.name !== "string") return undefined;
  const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<
    string,
    unknown
  >;
  return claudeToolToAction(b.name, input);
}

function claudeToolToAction(name: string, input: Record<string, unknown>): Action {
  const filePath = str(input["file_path"]);
  switch (name) {
    case "Read":
      return filePath !== undefined
        ? { type: "file_read", target: filePath }
        : { type: "file_read" };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return filePath !== undefined
        ? { type: "file_write", target: filePath }
        : { type: "file_write" };
    case "Grep":
    case "Glob": {
      const pattern = str(input["pattern"]);
      return pattern !== undefined
        ? { type: "search", query: normalizeQuery(pattern) }
        : { type: "search" };
    }
    case "Bash": {
      const command = str(input["command"]);
      return command !== undefined ? { type: "command", command } : { type: "command" };
    }
    case "Task":
    case "Agent":
      return { type: "spawn" };
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "ExitPlanMode":
      return { type: "plan" };
    case "WebFetch": {
      const url = str(input["url"]);
      return url !== undefined ? { type: "fetch", target: url } : { type: "fetch" };
    }
    case "WebSearch": {
      const query = str(input["query"]);
      return query !== undefined
        ? { type: "search", query: normalizeQuery(query) }
        : { type: "search" };
    }
    default:
      return unknownToolToAction(name, input);
  }
}

/**
 * Map an unrecognized tool (an MCP tool such as OCH's `mcp__…query` / `impact`,
 * or a newly-added built-in) by a conservative name heuristic. Search-ish and
 * read-ish MCP tools are the only ones promoted into a detector-relevant type;
 * everything else lands in `navigate`, which no structural detector reads.
 */
function unknownToolToAction(name: string, input: Record<string, unknown>): Action {
  const lower = name.toLowerCase();
  if (/search|query|grep|find|list_findings|dead_code/.test(lower)) {
    const q = str(input["query"]) ?? str(input["pattern"]);
    return q !== undefined ? { type: "search", query: normalizeQuery(q) } : { type: "search" };
  }
  if (/fetch|http|url|web/.test(lower)) return { type: "fetch" };
  return { type: "navigate" };
}

/* ─────────────────────────────────── Codex ─────────────────────────────── */

/**
 * Normalize Codex's `exec --json` JSONL into a canonical action list. Codex
 * reports work as `item.completed` events; we read each item once at
 * completion (its `item.started` twin is ignored to avoid double-counting).
 *
 * Item → action mapping (grounded against codex-cli 0.143.x
 * `exec_events.rs`): `command_execution`→command (Codex does reads/greps
 * through the shell, so those surface here and are caught by Shell-over-Tool),
 * `file_change`→one `file_write` per changed path, `web_search`→search,
 * `reasoning`→reason. `agent_message` is the final answer, not an action, and
 * is skipped. `mcp_tool_call` maps by the same name heuristic as Claude.
 */
export function actionsFromCodexJsonl(stdout: string): Action[] {
  const actions: Action[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof evt !== "object" || evt === null) continue;
    const e = evt as { type?: unknown; item?: unknown };
    if (e.type !== "item.completed") continue;
    pushCodexItem(actions, e.item);
  }
  return actions;
}

function pushCodexItem(actions: Action[], item: unknown): void {
  if (typeof item !== "object" || item === null) return;
  const it = item as {
    type?: unknown;
    command?: unknown;
    changes?: unknown;
    query?: unknown;
    server?: unknown;
    tool?: unknown;
    arguments?: unknown;
  };
  switch (it.type) {
    case "command_execution": {
      const command = str(it.command);
      actions.push(command !== undefined ? { type: "command", command } : { type: "command" });
      return;
    }
    case "file_change": {
      if (Array.isArray(it.changes)) {
        for (const ch of it.changes) {
          const path = str((ch as { path?: unknown } | null)?.path);
          actions.push(
            path !== undefined ? { type: "file_write", target: path } : { type: "file_write" },
          );
        }
      } else {
        actions.push({ type: "file_write" });
      }
      return;
    }
    case "web_search": {
      const query = str(it.query);
      actions.push(
        query !== undefined ? { type: "search", query: normalizeQuery(query) } : { type: "search" },
      );
      return;
    }
    case "reasoning":
      actions.push({ type: "reason" });
      return;
    case "mcp_tool_call": {
      const tool = str(it.tool) ?? "";
      actions.push(unknownToolToAction(tool, {}));
      return;
    }
    // agent_message (final answer), todo_list, and unknown item types carry no
    // detector-relevant action in v1.
    default:
      return;
  }
}

/** Narrow an unknown JSON value to a non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
