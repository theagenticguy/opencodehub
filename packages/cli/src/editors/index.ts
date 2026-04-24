/**
 * Barrel for editor writers + shared helpers.
 */

export { createClaudeCodeWriter } from "./claude-code.js";
export { createCodexWriter, mergeCodexConfig } from "./codex.js";
export { createCursorWriter } from "./cursor.js";
export { createOpenCodeWriter, mergeOpenCodeConfig } from "./opencode.js";
export type { EditorId, EditorWriter, McpInvocation } from "./types.js";
export { ALL_EDITOR_IDS } from "./types.js";
export { maybeWrapForWindows } from "./windows-wrap.js";
export { createWindsurfWriter } from "./windsurf.js";
