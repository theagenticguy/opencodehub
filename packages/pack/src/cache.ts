/**
 * @opencodehub/pack — channel-aware cache-prefix enforcement (Move 4).
 *
 * Prompt caching is now the DEFAULT and is automatic (free, zero markers) on
 * several channels, but remains OPT-IN (explicit cache markers) on others.
 * A pack that emits cache-breakpoint markers + enforces a deterministic prefix
 * boundary is only useful on the opt-in channels; on the automatic channels the
 * ceremony is pure noise. `CacheChannel` names the delivery surface so the pack
 * spends that effort exactly where it pays off.
 *
 * Caching state as verified this session (see the platform-availability matrix
 * in the claude-api reference — "Automatic prompt caching" row):
 *
 *   channel          automatic caching   marker the surface needs   emit markers?
 *   ---------------  ------------------   ------------------------   -------------
 *   anthropic        yes (default, free)  — (n/a)                    no
 *   claude-on-aws    yes (default, free)  — (n/a)                    no
 *   foundry          yes (default, free)  — (n/a)                    no
 *   bedrock          NO (opt-in)          { cachePoint: {...} }      yes
 *   vertex           NO (opt-in)          { cache_control: {...} }   yes
 *   auto (DEFAULT)   assume automatic     — (n/a)                    no
 *
 * `auto` is the conservative default: it assumes automatic caching and emits NO
 * markers, so the default path is byte-identical to the pre-Move-4 behavior and
 * every existing determinism/golden fixture stays green. A caller who knows
 * their pack will be consumed on classic Bedrock or Vertex passes that channel
 * explicitly to turn markers on.
 *
 * Everything here is pure and fully unit-testable — no I/O, no process state.
 */

/**
 * The delivery surface a pack's agent-facing context is consumed on. Controls
 * whether the pack emits opt-in cache-breakpoint markers and enforces a
 * deterministic prefix boundary.
 */
export type CacheChannel =
  | "bedrock" // classic AWS Bedrock (Converse / InvokeModel) — opt-in via cachePoint
  | "vertex" // Google Vertex AI — opt-in via cache_control
  | "anthropic" // Anthropic first-party API — automatic caching
  | "claude-on-aws" // "Claude on AWS" — automatic caching
  | "foundry" // Microsoft Foundry — automatic caching
  | "auto"; // DEFAULT — assume automatic, emit no markers

/** Every valid {@link CacheChannel} value, for validation + enumeration. */
export const CACHE_CHANNELS: readonly CacheChannel[] = [
  "bedrock",
  "vertex",
  "anthropic",
  "claude-on-aws",
  "foundry",
  "auto",
];

/** The default channel when `--cache-channel` is absent. */
export const DEFAULT_CACHE_CHANNEL: CacheChannel = "auto";

/**
 * Narrow an arbitrary string to a {@link CacheChannel}. Returns `undefined`
 * for an unknown value so callers can error clearly instead of silently
 * mis-routing.
 */
export function parseCacheChannel(value: string): CacheChannel | undefined {
  return (CACHE_CHANNELS as readonly string[]).includes(value)
    ? (value as CacheChannel)
    : undefined;
}

/**
 * Whether a channel still needs the pack to emit explicit cache markers +
 * enforce a deterministic prefix boundary. `true` only for the opt-in
 * channels (`bedrock`, `vertex`); every automatic channel — and the
 * conservative `auto` default — returns `false`.
 */
export function cacheChannelNeedsMarkers(channel: CacheChannel): boolean {
  switch (channel) {
    case "bedrock":
    case "vertex":
      return true;
    case "anthropic":
    case "claude-on-aws":
    case "foundry":
    case "auto":
      return false;
  }
}

/** Bedrock's cache-breakpoint marker shape (Converse / InvokeModel). */
export interface BedrockCachePoint {
  readonly cachePoint: { readonly type: "default" };
}

/** The Anthropic-family opt-in cache marker shape (attached to a content block). */
export interface AnthropicCacheControl {
  readonly cache_control: { readonly type: "ephemeral" };
}

/** The union of concrete cache-marker shapes a channel may require. */
export type CachePoint = BedrockCachePoint | AnthropicCacheControl;

/**
 * Build the cache-breakpoint marker a channel needs, or `null` when the channel
 * caches automatically and needs no marker.
 *
 *   - `bedrock` → `{ cachePoint: { type: "default" } }` (the Bedrock opt-in block)
 *   - `vertex`  → `{ cache_control: { type: "ephemeral" } }` (Vertex opt-in shape)
 *   - `anthropic` / `claude-on-aws` / `foundry` / `auto` → `null` (automatic)
 *
 * Pure: same channel in → identical marker object out.
 */
export function buildCachePoint(channel: CacheChannel): CachePoint | null {
  switch (channel) {
    case "bedrock":
      return { cachePoint: { type: "default" } };
    case "vertex":
      return { cache_control: { type: "ephemeral" } };
    case "anthropic":
    case "claude-on-aws":
    case "foundry":
    case "auto":
      return null;
  }
}

/**
 * The textual cache-breakpoint sentinel inserted at the deterministic prefix
 * boundary in the agent-facing assembled context, when a channel needs markers.
 * A stable, self-describing delimiter line so the boundary is byte-deterministic
 * and greppable. The channel-specific marker shape is embedded so a downstream
 * consumer knows which opt-in block to materialize at this point.
 */
export function cacheBreakpointSentinel(channel: CacheChannel): string {
  const point = buildCachePoint(channel);
  if (point === null) return "";
  // Compact, deterministic single-line JSON of the marker (key order is fixed
  // by the object literal above, so this is byte-stable per channel).
  return `<!-- opencodehub:cachePoint channel=${channel} ${JSON.stringify(point)} -->`;
}
