/**
 * `defineTool` — the factory that folds the repeated MCP register-tool +
 * `withStore` + try/catch + envelope + `toToolResult` boilerplate into ONE
 * place, so a read-only tool file collapses to four declarations: the
 * `core-ops` capability that does the finder → filter → projection, an
 * `args → Input` projector (the undefined-strip idiom), a `present`
 * function that renders the capability's plain `Output` into the tool's
 * text body + `next_steps`, and the register metadata (wire name, title,
 * description, input schema, annotations).
 *
 * WHY THIS EXISTS. Every read-only tool — `list_findings`, `dependencies`,
 * `license_audit`, `project_profile`, … — ran the identical wrapper:
 *
 *   run(ctx, args) = withStore(ctx, args, (store, resolved) => try {
 *     ...capability body... ; return withNextSteps(text, structured, next,
 *     stalenessFromMeta(resolved.meta)) } catch (err) {
 *     return toolErrorFromUnknown(err) }) ; return toToolResult(call)
 *   register(server, ctx) = server.registerTool(name, {...}, args =>
 *     fromToolResult(run(ctx, args)))
 *
 * Only the middle (the finder/filter/projection, now a `Capability`) and the
 * rendering (now `present`) differ per tool. This factory owns the rest. The
 * factory is transport-bound (it imports the MCP SDK and the mcp-side helpers),
 * so it lives here in `@opencodehub/mcp`, NOT in the dependency-light
 * `@opencodehub/core-ops` where the capabilities live.
 *
 * The zod `inputSchema` stays per-tool (each transport owns its validation
 * shape) and so does `present` (text/next-steps rendering is the deliberate
 * per-surface part). Everything else is uniform, and this is where it lives.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Capability } from "@opencodehub/core-ops";
import type { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import type { ResolvedRepo } from "../repo-resolver.js";
import { stalenessFromMeta } from "../staleness.js";
import {
  fromToolResult,
  type RepoArgs,
  type ToolContext,
  type ToolResult,
  toToolResult,
  withStore,
} from "./shared.js";

/**
 * What a tool's `present` returns for one capability `Output` — the exact
 * rendered text body, the machine-readable structured payload, and the
 * next-step hints. `structured` becomes the `structuredContent` (minus the
 * `next_steps` + `_meta` the factory layers on via {@link withNextSteps}).
 */
export interface ToolPresentation {
  readonly text: string;
  readonly structured: Record<string, unknown>;
  readonly nextSteps: readonly string[];
}

/**
 * The declarative spec for one read-only, per-repo MCP tool. `Args` is the
 * SDK-validated arg object (spreads `repoArgShape`); `Input` is the plain
 * shape the capability consumes; `Output` is the plain shape it returns.
 */
export interface DefineToolSpec<Args extends RepoArgs, Input, Output> {
  /** Wire name — also the SDK tool id (usually equals `capability.id`). */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Raw-shape zod schema (spreads `repoArgShape`). Stays per-tool. */
  readonly inputSchema: z.ZodRawShape;
  readonly annotations: ToolAnnotations;
  readonly capability: Capability<Input, Output>;
  /** The undefined-strip projection from validated args to capability input. */
  readonly toInput: (args: Args) => Input;
  /** Render the capability's plain output into text + structured + next-steps. */
  readonly present: (output: Output, resolved: ResolvedRepo) => ToolPresentation;
}

/**
 * A defined tool: `run` is the transport-agnostic handler (the one place tests
 * can call to assert `structuredContent`), and `register` wires it onto an
 * `McpServer`. Each tool file keeps its `registerXxxTool` export as a one-line
 * delegate to `register`, so `server.ts`'s existing call sites are unchanged.
 */
export interface DefinedTool<Args extends RepoArgs> {
  readonly name: string;
  readonly run: (ctx: ToolContext, args: Args) => Promise<ToolResult>;
  readonly register: (server: McpServer, ctx: ToolContext) => void;
}

export function defineTool<Args extends RepoArgs, Input, Output>(
  spec: DefineToolSpec<Args, Input, Output>,
): DefinedTool<Args> {
  async function run(ctx: ToolContext, args: Args): Promise<ToolResult> {
    const call = await withStore(ctx, args, async (store, resolved) => {
      try {
        const output = await spec.capability.execute(spec.toInput(args), {
          store,
          repoName: resolved.name,
        });
        const view = spec.present(output, resolved);
        return withNextSteps(
          view.text,
          view.structured,
          view.nextSteps,
          stalenessFromMeta(resolved.meta),
        );
      } catch (err) {
        return toolErrorFromUnknown(err);
      }
    });
    return toToolResult(call);
  }

  function register(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: spec.annotations,
      },
      async (args) => fromToolResult(await run(ctx, args as Args)),
    );
  }

  return { name: spec.name, run, register };
}
