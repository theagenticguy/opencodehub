/**
 * Shared types used by every editor writer.
 *
 * Every writer implements the `EditorWriter` interface: given a resolved MCP
 * invocation (executable + args + env), it produces a merged file payload that
 * preserves every pre-existing entry under the editor's MCP key and only
 * upserts/replaces the single `codehub` entry.
 *
 * Writers are pure on their inputs — they never touch the filesystem. The
 * orchestrator in `commands/setup.ts` handles read, backup, and atomic write.
 */

export type EditorId = "claude-code" | "cursor" | "codex" | "windsurf" | "opencode";

export const ALL_EDITOR_IDS: readonly EditorId[] = [
  "claude-code",
  "cursor",
  "codex",
  "windsurf",
  "opencode",
];

/**
 * Resolved MCP server invocation. The `command` + `args` fields have already
 * been through any platform-specific wrapping (e.g. `cmd /c` on Windows).
 */
export interface McpInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface EditorWriter {
  readonly id: EditorId;
  /** Absolute path of the file this writer targets. */
  readonly configPath: string;
  /**
   * Produce the new file contents. If `existing` is undefined the writer must
   * emit a fresh document. Otherwise it must preserve every unrelated key.
   */
  merge(existing: string | undefined, invocation: McpInvocation): string;
}
