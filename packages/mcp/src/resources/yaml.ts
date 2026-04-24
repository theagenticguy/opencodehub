/**
 * Minimal YAML scalar quoter shared across resource handlers.
 *
 * Resources emit YAML for agent readability (see `repo-context.ts`). The
 * quoter is intentionally conservative: plain identifiers pass through
 * unquoted, anything else is wrapped in double quotes with embedded
 * quotes escaped. A loose parser will round-trip either form.
 */

export function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (/^[A-Za-z0-9._\-/]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
