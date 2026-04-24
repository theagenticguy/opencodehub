/**
 * Next-step hints for the `codehub eval-server` HTTP surface.
 *
 * The MCP tool layer already emits a `next_steps` array under
 * `structuredContent`, but those steps are phrased as MCP tool calls
 * ("call `context` with …"). In the eval-server we emit CLI-flavoured
 * hints so the agent on the other end of curl knows the exact next
 * command to run. A hint is a short trailing line prefixed with
 * "Next:" — 1-2 lines max, never more.
 *
 * Hints are appended after the formatted response by `buildResponseBody`
 * in `http-server.ts`. Tools without a useful hint return the empty
 * string, which the caller suppresses.
 */

import type { ToolResult } from "@opencodehub/mcp";

type Sc = Record<string, unknown>;

function sc(result: ToolResult): Sc {
  const raw = result.structuredContent;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Sc;
  }
  return {};
}

function firstArr(payload: Sc, ...keys: string[]): Sc | undefined {
  for (const k of keys) {
    const v = payload[k];
    if (Array.isArray(v) && v.length > 0) {
      return v[0] as Sc;
    }
  }
  return undefined;
}

function hintQuery(result: ToolResult): string {
  const payload = sc(result);
  const first = firstArr(payload, "results", "definitions");
  if (!first) {
    return "Next: broaden the query or drop the `kinds` filter.";
  }
  const name = typeof first["name"] === "string" ? (first["name"] as string) : "<symbol>";
  return `Next: codehub context "${name}" for a 360-degree view.`;
}

function hintContext(result: ToolResult): string {
  const payload = sc(result);
  const target = payload["target"] as Sc | null;
  if (!target) {
    const candidates = Array.isArray(payload["candidates"]) ? (payload["candidates"] as Sc[]) : [];
    if (candidates.length > 0) {
      return "Next: re-call with `uid` from a candidate, or narrow via `kind` / `file_path`.";
    }
    return "Next: call `query` with a broader phrase.";
  }
  const name = typeof target["name"] === "string" ? (target["name"] as string) : "<symbol>";
  return `Next: codehub impact "${name}" to assess blast radius.`;
}

function hintImpact(result: ToolResult): string {
  const payload = sc(result);
  const risk = typeof payload["risk"] === "string" ? (payload["risk"] as string) : "LOW";
  const byDepth = (payload["byDepth"] as Record<string, unknown>) ?? {};
  const d1 = Array.isArray(byDepth["1"]) ? (byDepth["1"] as Sc[]) : [];
  if (risk === "LOW" || d1.length === 0) {
    return "Next: low direct impact — skim d=2/d=3 for transitive risk if behaviour changes.";
  }
  const topName = typeof d1[0]?.["name"] === "string" ? (d1[0]["name"] as string) : "<symbol>";
  return `Next: codehub context "${topName}" to inspect the highest-risk caller.`;
}

function hintDetectChanges(result: ToolResult): string {
  const payload = sc(result);
  const affected = Array.isArray(payload["affected_symbols"])
    ? (payload["affected_symbols"] as Sc[])
    : [];
  if (affected.length === 0) {
    return "Next: no indexed symbols touched — verify the diff scope or re-index.";
  }
  const name =
    typeof affected[0]?.["name"] === "string" ? (affected[0]["name"] as string) : "<symbol>";
  return `Next: codehub impact "${name}" to assess blast radius of this change.`;
}

function hintListRepos(result: ToolResult): string {
  const payload = sc(result);
  const repos = Array.isArray(payload["repos"]) ? (payload["repos"] as Sc[]) : [];
  if (repos.length === 0) {
    return "Next: run `codehub analyze` in a repo root to create an index.";
  }
  const name = typeof repos[0]?.["name"] === "string" ? (repos[0]["name"] as string) : "<repo>";
  return `Next: POST /tool/query with { "query": "<phrase>", "repo": "${name}" }.`;
}

function hintSql(result: ToolResult): string {
  const payload = sc(result);
  const rowCount = typeof payload["row_count"] === "number" ? (payload["row_count"] as number) : 0;
  if (rowCount === 0) {
    return "Next: broaden the WHERE clause or verify the NodeKind/RelationType filters.";
  }
  return 'Next: POST /tool/context with { "uid": "<row id>" } to drill into a row.';
}

function hintVerdict(result: ToolResult): string {
  const payload = sc(result);
  const verdict = typeof payload["verdict"] === "string" ? (payload["verdict"] as string) : "";
  if (verdict === "block" || verdict === "expert_review") {
    return "Next: POST /tool/impact on each affected symbol to identify reducible scope.";
  }
  if (verdict === "dual_review") {
    return "Next: POST /tool/detect_changes to map the full affected-process set.";
  }
  return "Next: POST /tool/list_findings to confirm the scanner run is clean.";
}

function hintScan(_result: ToolResult): string {
  return "Next: POST /tool/list_findings to browse the ingested findings.";
}

function hintListFindings(result: ToolResult): string {
  const payload = sc(result);
  const findings = Array.isArray(payload["findings"]) ? (payload["findings"] as Sc[]) : [];
  if (findings.length === 0) {
    return "Next: run `codehub scan` to populate findings.";
  }
  const first = findings[0] ?? {};
  const filePath = typeof first["filePath"] === "string" ? (first["filePath"] as string) : "";
  if (filePath) {
    return `Next: POST /tool/context with { "file_path": "${filePath}" } for caller/callee neighbours.`;
  }
  return "Next: POST /tool/context with a finding's filePath for caller/callee neighbours.";
}

function hintListFindingsDelta(result: ToolResult): string {
  const payload = sc(result);
  const summary = (payload["summary"] as Sc | undefined) ?? {};
  const newCount = typeof summary["new"] === "number" ? (summary["new"] as number) : 0;
  if (newCount > 0) {
    return "Next: POST /tool/verdict to see how the delta maps to a PR decision.";
  }
  return "Next: POST /tool/list_findings for the full non-delta finding list.";
}

function hintRename(result: ToolResult): string {
  const payload = sc(result);
  const status = typeof payload["status"] === "string" ? (payload["status"] as string) : "";
  const totalEdits =
    typeof payload["total_edits"] === "number" ? (payload["total_edits"] as number) : 0;
  if (payload["ambiguous"] === true) {
    return "Next: call `context` first to pick a concrete definition.";
  }
  if (status === "dry-run" && totalEdits > 0) {
    return "Next: re-call with `dry_run: false` to apply the edits.";
  }
  return "";
}

function hintApiImpact(result: ToolResult): string {
  const payload = sc(result);
  const routes = Array.isArray(payload["routes"]) ? (payload["routes"] as Sc[]) : [];
  if (routes.length === 0) return "Next: POST /tool/route_map to list available routes.";
  const highest =
    typeof payload["highestRisk"] === "string" ? (payload["highestRisk"] as string) : "LOW";
  if (highest === "CRITICAL" || highest === "HIGH") {
    const route = (routes[0]?.["route"] as Sc | undefined) ?? {};
    const url = typeof route["url"] === "string" ? (route["url"] as string) : "";
    return `Next: POST /tool/shape_check with { "route": "${url}" } for per-consumer mismatches.`;
  }
  return "Next: confirm with /tool/shape_check before merging.";
}

function hintShapeCheck(_result: ToolResult): string {
  return "Next: POST /tool/context on a MISMATCH consumer to trace upstream callers.";
}

function hintRouteMap(result: ToolResult): string {
  const payload = sc(result);
  const routes = Array.isArray(payload["routes"]) ? (payload["routes"] as Sc[]) : [];
  if (routes.length === 0) return "Next: re-index with `codehub analyze` to emit Route nodes.";
  const first = routes[0] ?? {};
  const url = typeof first["url"] === "string" ? (first["url"] as string) : "";
  return `Next: POST /tool/api_impact with { "route": "${url}" } to score blast radius.`;
}

function hintToolMap(result: ToolResult): string {
  const payload = sc(result);
  const tools = Array.isArray(payload["tools"]) ? (payload["tools"] as Sc[]) : [];
  if (tools.length === 0) return "Next: re-index with `codehub analyze` to refresh Tool nodes.";
  const name = typeof tools[0]?.["name"] === "string" ? (tools[0]["name"] as string) : "<tool>";
  return `Next: codehub context "${name}" to see callers/callees.`;
}

type HintFn = (result: ToolResult) => string;

const HINTS: Readonly<Record<string, HintFn>> = Object.freeze({
  query: hintQuery,
  context: hintContext,
  impact: hintImpact,
  detect_changes: hintDetectChanges,
  list_repos: hintListRepos,
  sql: hintSql,
  verdict: hintVerdict,
  scan: hintScan,
  list_findings: hintListFindings,
  list_findings_delta: hintListFindingsDelta,
  rename: hintRename,
  api_impact: hintApiImpact,
  shape_check: hintShapeCheck,
  route_map: hintRouteMap,
  tool_map: hintToolMap,
});

/**
 * Render the next-step hint for a tool's result. Returns the empty
 * string when no hint is defined or the handler opted out (e.g. rename
 * when the edit list is already applied).
 */
export function getNextStepHint(toolName: string, result: ToolResult): string {
  const fn = HINTS[toolName];
  if (!fn) return "";
  try {
    return fn(result);
  } catch {
    return "";
  }
}
