/**
 * `@opencodehub/lsp-oracle` — pyright-langserver driven LSP oracle for
 * Python symbol reference / implementation / incoming-call queries.
 *
 * The package exports one stateful client class — `PyrightClient` —
 * that spawns pyright as a subprocess, speaks raw LSP JSON-RPC over
 * stdio, and surfaces the three queries downstream ingestion consumers
 * actually need:
 *
 *   - `queryCallers`        (prepareCallHierarchy + incomingCalls, with
 *                            constructor-redirect and a references-based
 *                            fallback when call-hierarchy is empty)
 *   - `queryReferences`     (textDocument/references)
 *   - `queryImplementations` (textDocument/implementation)
 *
 * The two Python spikes that validated the wire behavior live under
 * `reference/` — see `reference/README.md` for what each one proved.
 *
 * @example
 * ```ts
 * import { PyrightClient } from "@opencodehub/lsp-oracle";
 *
 * const client = new PyrightClient({ workspaceRoot: "/path/to/repo" });
 * await client.start();
 * try {
 *   const callers = await client.queryCallers({
 *     filePath: "src/foo.py",
 *     line: 42,
 *     character: 8,
 *     symbolKind: "method",
 *     symbolName: "Agent.invoke_async",
 *   });
 *   console.log(callers);
 * } finally {
 *   await client.stop();
 * }
 * ```
 */

export {
  type BaseClientStatus,
  BaseLspClient,
  type BaseLspClientOptions,
  DEFAULT_INDEX_WAIT_MS,
  type LspCallHierarchyIncomingCall,
  type LspCallHierarchyItem,
  type LspLocation,
  type LspPosition,
  type LspRange,
  makeTextDocumentPosition,
  SHUTDOWN_GRACE_MS,
  toFileUri,
  toRelativeFilePath,
  uriToFsPath,
} from "./base-client.js";
export { PyrightClient } from "./client.js";
export { encodeFrame, FrameDecoder } from "./framing.js";
export {
  GoplsClient,
  type GoplsClientOptions,
  type GoplsClientStatus,
} from "./gopls-client.js";
export type {
  JsonRpcNotificationMessage,
  JsonRpcRequestMessage,
  JsonRpcResponseMessage,
  NotificationHandler,
  ServerRequestHandler,
} from "./jsonrpc.js";
export { JsonRpcDispatcher } from "./jsonrpc.js";
export {
  parseRustAnalyzerVersion,
  RustAnalyzerClient,
  type RustAnalyzerClientOptions,
  type RustAnalyzerClientStatus,
} from "./rust-analyzer-client.js";
export type {
  CallerSite,
  ClientStatus,
  FilePosition,
  ImplementationSite,
  PyrightClientOptions,
  PythonResolutionMode,
  QueryCallersInput,
  ReferenceSite,
  SymbolKind,
} from "./types.js";
export {
  TypeScriptClient,
  type TypeScriptClientOptions,
  type TypeScriptClientStatus,
} from "./typescript-client.js";
export { detectPythonEnv, type VenvDetection } from "./venv.js";
