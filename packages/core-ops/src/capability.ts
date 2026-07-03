/**
 * The `Capability` contract — a transport-free unit of work shared by the MCP
 * tool and the CLI command for one code-intelligence operation.
 *
 * WHY THIS EXISTS. Today the MCP tool (`packages/mcp/src/tools/<x>.ts`) and the
 * CLI command (`packages/cli/src/commands/<x>.ts`) for the same operation run
 * byte-identical resolve → open-store → typed-finder → filter → row-projection
 * logic and diverge ONLY at output (an MCP `CallToolResult` envelope vs the
 * CLI's `console.log` / `--json`). A `Capability` owns the shared middle and
 * returns a PLAIN typed `Output`; each surface keeps a thin adapter that maps
 * that `Output` into its own transport. A filter fix then lands once, not twice.
 *
 * SCOPE (v1, the findings proof-of-concept). `execute` receives an ALREADY-OPEN
 * store view plus the resolved repo's display name — both of which each surface
 * already has at its call site (MCP via `withStore`, CLI via
 * `openStoreForCommand`). Repo resolution and store lifecycle stay in the two
 * surfaces for now because their resolvers differ meaningfully (the MCP side
 * carries `AMBIGUOUS_REPO` semantics the CLI does not). Unifying resolution +
 * lifecycle behind a `StoreProvider`, and folding the register/try-catch
 * boilerplate into `defineTool`/`defineCommand` factories, is the natural
 * follow-up once this seam is proven — see `artifacts/och-shared-core/`.
 *
 * A capability NEVER touches `console`, NEVER builds a `CallToolResult`, and
 * NEVER renders.
 *
 * INPUT VALIDATION stays at each surface's boundary, deliberately. The MCP
 * tool validates via the SDK's zod `inputSchema` (raw-shape idiom); the CLI
 * validates + coerces commander flags. Both then hand `execute` a plain,
 * already-validated `Input` object. Keeping the zod schema out of the
 * capability keeps this core package dependency-light and lets each surface
 * own the schema shape its transport requires — the shared, duplicated part
 * was always the `execute` body (finder → filter → projection), never the
 * schema. (A future revision may thread a shared schema through once the two
 * surfaces' validation needs are unified; not required for the dedup win.)
 */

import type { IGraphStore, ITemporalStore } from "@opencodehub/storage";

/**
 * The already-open store views a capability's `execute` reads. Mirrors the
 * `store.graph` / `store.temporal` split every call site uses today, so an
 * `execute` body reads exactly like the inline code it replaces. (When the
 * deferred A1 accessor-collapse lands, this interface is its single flip
 * point: change it to one `store` and update the `execute` bodies, not the
 * ~28 adapter files.)
 */
export interface CapabilityStore {
  readonly graph: IGraphStore;
  readonly temporal: ITemporalStore;
}

/** Everything an `execute` needs beyond the validated input. */
export interface CapabilityContext {
  /** The open store views. */
  readonly store: CapabilityStore;
  /** The resolved repo's display name, for `Output` headers/labels. */
  readonly repoName: string;
}

/**
 * A transport-free operation shared by the MCP tool and CLI command.
 *
 *  - `id` is a stable identifier (e.g. "findings"), used for logging and as
 *    the default tool/command name.
 *  - `execute` receives an already-validated, plain `Input` (each surface
 *    validates at its own boundary), does finder → filter → project, and
 *    returns a PLAIN `Output`. It must not import commander, the MCP SDK, or
 *    `console`.
 */
export interface Capability<Input, Output> {
  readonly id: string;
  readonly execute: (input: Input, ctx: CapabilityContext) => Promise<Output>;
}
