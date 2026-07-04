/**
 * The one canonical `stringOr`. Coerces a value to a string: passes strings
 * through, stringifies numbers/booleans, and falls back otherwise.
 *
 * This was copy-pasted byte-identically across the MCP tools and CLI commands
 * (tech-debt audit finding D7 — 7 files). Capabilities and their adapters
 * import it from here so a change lands once.
 */
export function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
