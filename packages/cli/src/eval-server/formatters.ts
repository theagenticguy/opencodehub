/**
 * Text formatters for the `codehub eval-server` HTTP surface.
 *
 * Each formatter maps a `ToolResult.structuredContent` payload into a
 * compact, agent-readable string. The goal is token efficiency: when a
 * model is running a SWE-bench loop, the difference between a pretty-
 * printed JSON blob and a 5-line summary is measurable.
 *
 * Every formatter is tolerant to partial payloads — missing arrays are
 * treated as empty, missing scalars as null. This keeps the HTTP path
 * robust across tool-shape revisions without breaking the harness.
 *
 * Unrecognised tools fall back to JSON.stringify so the eval harness
 * still sees the full payload. The `text` field on ToolResult is NOT
 * used here: the MCP-flavoured text already contains a "Suggested next
 * tools:" block that duplicates the eval-server hints and would waste
 * tokens.
 */

import type { ToolResult } from "@opencodehub/mcp";

type Sc = Record<string, unknown>;

const MAX_LIST = 20;
const MAX_TABLE = 30;

function sc(result: ToolResult): Sc {
  const raw = result.structuredContent;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Sc;
  }
  return {};
}

function asArr(v: unknown): readonly Sc[] {
  return Array.isArray(v) ? (v as Sc[]) : [];
}

function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function errorPrefix(result: ToolResult): string | null {
  if (!result.isError) return null;
  const payload = sc(result);
  const err = payload["error"] as Sc | undefined;
  if (err) {
    const code = asStr(err["code"], "ERROR");
    const message = asStr(err["message"], "(no message)");
    return `Error [${code}]: ${message}`;
  }
  return `Error: ${result.text || "(no message)"}`;
}

// ─── query ────────────────────────────────────────────────────────────

export function formatQuery(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const rows = asArr(payload["results"]);
  const mode = asStr(payload["mode"], "bm25");
  const processes = asArr(payload["processes"]);
  const processSymbols = asArr(payload["process_symbols"]);

  if (rows.length === 0 && processes.length === 0) {
    return "No matches. Broaden the query or drop the `kinds` filter.";
  }

  const lines: string[] = [];
  lines.push(`${rows.length} ${mode} match(es):`);
  for (const r of rows.slice(0, MAX_LIST)) {
    const name = asStr(r["name"]);
    const kind = asStr(r["kind"]);
    const filePath = asStr(r["filePath"]);
    const startLine = r["startLine"];
    const loc = typeof startLine === "number" ? `:${startLine}` : "";
    const score = asNum(r["score"]);
    lines.push(`  ${kind} ${name} — ${filePath}${loc} (score ${score.toFixed(3)})`);
  }
  if (rows.length > MAX_LIST) {
    lines.push(`  … ${rows.length - MAX_LIST} more`);
  }

  if (processes.length > 0) {
    lines.push("");
    lines.push(`Execution flows touching top hits (${processes.length}):`);
    for (const p of processes.slice(0, 10)) {
      const name = asStr(p["name"]);
      const stepCount = asNum(p["stepCount"]);
      const pid = asStr(p["id"]);
      const members = processSymbols.filter((s) => s["process_id"] === pid);
      lines.push(`  ⊿ ${name} (${stepCount} steps, ${members.length} members)`);
    }
  }
  return lines.join("\n");
}

// ─── context ──────────────────────────────────────────────────────────

export function formatContext(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const target = payload["target"] as Sc | null;
  const candidates = asArr(payload["candidates"]);

  if (!target && candidates.length > 0) {
    const lines = [`Ambiguous — ${candidates.length} candidates:`];
    for (const c of candidates.slice(0, MAX_LIST)) {
      lines.push(
        `  [${asStr(c["kind"])}] ${asStr(c["name"])} — ${asStr(c["filePath"])}  (id: ${asStr(c["id"])})`,
      );
    }
    lines.push("");
    lines.push("Re-call `context` with `uid` or narrow via `kind` / `file_path`.");
    return lines.join("\n");
  }

  if (!target) {
    return "Symbol not found.";
  }

  const lines: string[] = [];
  lines.push(
    `Symbol: ${asStr(target["name"])} [${asStr(target["kind"])}] — ${asStr(target["filePath"])}`,
  );

  const confidence = payload["confidenceBreakdown"] as Sc | undefined;
  if (confidence) {
    lines.push(
      `Confidence: ${asNum(confidence["confirmed"])} confirmed, ${asNum(confidence["heuristic"])} heuristic, ${asNum(confidence["unknown"])} unknown`,
    );
  }

  const callers = asArr(payload["callers"]);
  if (callers.length > 0) {
    lines.push(`Callers (${callers.length}):`);
    for (const c of callers.slice(0, MAX_LIST)) {
      lines.push(`  ← ${asStr(c["name"])} [${asStr(c["kind"])}] — ${asStr(c["filePath"])}`);
    }
  }

  const callees = asArr(payload["callees"]);
  if (callees.length > 0) {
    lines.push(`Callees (${callees.length}):`);
    for (const c of callees.slice(0, MAX_LIST)) {
      lines.push(`  → ${asStr(c["name"])} [${asStr(c["kind"])}] — ${asStr(c["filePath"])}`);
    }
  }

  const processes = asArr(payload["processes"]);
  if (processes.length > 0) {
    lines.push(`Participates in ${processes.length} flow(s):`);
    for (const p of processes.slice(0, 10)) {
      const label = asStr(p["label"] ?? p["name"]);
      const step = p["step"];
      const stepSuffix = typeof step === "number" ? ` (step ${step})` : "";
      lines.push(`  ⊿ ${label}${stepSuffix}`);
    }
  }

  const cochanges = asArr(payload["cochanges"]);
  if (cochanges.length > 0) {
    lines.push(`Cochange partners — git history, NOT dependencies (${cochanges.length}):`);
    for (const c of cochanges.slice(0, 10)) {
      lines.push(`  ⇌ ${asStr(c["file"])} (lift ${asNum(c["lift"]).toFixed(2)})`);
    }
  }

  return lines.join("\n");
}

// ─── impact ───────────────────────────────────────────────────────────

export function formatImpact(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const target = payload["target"] as Sc | null;
  const direction = asStr(payload["direction"], "upstream");
  const risk = asStr(payload["risk"], "LOW");
  const impactedCount = asNum(payload["impactedCount"]);
  const byDepth = (payload["byDepth"] as Record<string, unknown>) ?? {};
  const affectedProcesses = asArr(payload["affected_processes"]);
  const affectedModules = asArr(payload["affected_modules"]);
  const confidence = payload["confidenceBreakdown"] as Sc | undefined;

  if (!target) {
    return "Impact: target not resolved.";
  }

  const lines: string[] = [];
  const label = `${asStr(target["name"])} [${asStr(target["kind"])}]`;
  lines.push(`Impact for ${label} (${direction}): ${risk}, ${impactedCount} impacted`);
  if (confidence) {
    lines.push(
      `Confidence: ${asNum(confidence["confirmed"])} confirmed, ${asNum(confidence["heuristic"])} heuristic, ${asNum(confidence["unknown"])} unknown`,
    );
  }

  const depthLabels: Record<string, string> = {
    "1": "WILL BREAK (direct)",
    "2": "LIKELY AFFECTED",
    "3": "MAY NEED TESTING",
  };
  for (const depth of ["1", "2", "3"]) {
    const nodes = asArr(byDepth[depth]);
    if (nodes.length === 0) continue;
    lines.push(`d=${depth} ${depthLabels[depth] ?? ""} (${nodes.length}):`);
    for (const n of nodes.slice(0, 12)) {
      const conf = asNum(n["confidence"], 1);
      const confTag = conf < 1 ? ` (conf ${conf.toFixed(2)})` : "";
      lines.push(
        `  ${asStr(n["kind"])} ${asStr(n["name"])} — ${asStr(n["filePath"])} [${asStr(n["viaRelation"] ?? n["relationType"])}]${confTag}`,
      );
    }
    if (nodes.length > 12) lines.push(`  … ${nodes.length - 12} more`);
  }

  if (affectedProcesses.length > 0) {
    lines.push(`Processes (${affectedProcesses.length}):`);
    for (const p of affectedProcesses.slice(0, 8)) {
      lines.push(`  ⊿ ${asStr(p["label"] ?? p["name"])}`);
    }
  }
  if (affectedModules.length > 0) {
    lines.push(`Modules (${affectedModules.length}):`);
    for (const m of affectedModules.slice(0, 8)) {
      lines.push(`  ⊡ ${asStr(m["name"])} [${asStr(m["impact"])}] ${asNum(m["hits"])} hit(s)`);
    }
  }

  return lines.join("\n");
}

// ─── detect_changes ───────────────────────────────────────────────────

export function formatDetectChanges(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const summary = (payload["summary"] as Sc) ?? {};
  const affectedSymbols = asArr(payload["affected_symbols"]);
  const affectedProcesses = asArr(payload["affected_processes"]);
  const changedFiles = asArr(payload["changed_files"]);

  const fileCount = asNum(summary["fileCount"], changedFiles.length);
  const symbolCount = asNum(summary["symbolCount"], affectedSymbols.length);
  const processCount = asNum(summary["processCount"], affectedProcesses.length);
  const risk = asStr(summary["risk"], "unknown");

  if (fileCount === 0 && symbolCount === 0) {
    return "No changes detected.";
  }

  const lines: string[] = [];
  lines.push(
    `Changes: ${fileCount} file(s), ${symbolCount} symbol(s), ${processCount} process(es). Risk: ${risk}`,
  );
  if (affectedSymbols.length > 0) {
    lines.push(`Affected symbols (${affectedSymbols.length}):`);
    for (const s of affectedSymbols.slice(0, MAX_LIST)) {
      lines.push(`  ${asStr(s["kind"])} ${asStr(s["name"])} — ${asStr(s["filePath"])}`);
    }
    if (affectedSymbols.length > MAX_LIST) {
      lines.push(`  … ${affectedSymbols.length - MAX_LIST} more`);
    }
  }
  if (affectedProcesses.length > 0) {
    lines.push(`Affected processes (${affectedProcesses.length}):`);
    for (const p of affectedProcesses.slice(0, 10)) {
      lines.push(`  ⊿ ${asStr(p["name"])}`);
    }
  }

  return lines.join("\n");
}

// ─── list_repos ───────────────────────────────────────────────────────

export function formatListRepos(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const repos = asArr(payload["repos"]);
  if (repos.length === 0) {
    return "No indexed repos. Run `codehub analyze` in a repo root.";
  }
  const lines = [`${repos.length} indexed repo(s):`];
  for (const r of repos) {
    lines.push(
      `  ${asStr(r["name"])} — nodes=${asNum(r["nodeCount"])}, edges=${asNum(r["edgeCount"])}`,
    );
    lines.push(`    path: ${asStr(r["path"])}`);
    lines.push(`    indexedAt: ${asStr(r["indexedAt"])}`);
  }
  return lines.join("\n");
}

// ─── sql ──────────────────────────────────────────────────────────────

export function formatSql(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const rows = asArr(payload["rows"]);
  const columns = (payload["columns"] as string[] | undefined) ?? [];
  if (rows.length === 0) {
    return "0 rows.";
  }
  const cols = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
  const lines = [`${rows.length} row(s):`];
  for (const row of rows.slice(0, MAX_TABLE)) {
    const parts = cols.map((c) => `${c}=${renderCell(row[c])}`);
    lines.push(`  ${parts.join(" | ")}`);
  }
  if (rows.length > MAX_TABLE) {
    lines.push(`  … ${rows.length - MAX_TABLE} more`);
  }
  return lines.join("\n");
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 77)}...` : v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  } catch {
    return String(v);
  }
}

// ─── verdict ──────────────────────────────────────────────────────────

export function formatVerdict(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const verdict = asStr(payload["verdict"], "unknown");
  const confidence = asNum(payload["confidence"]);
  const exitCode = asNum(payload["exit_code"]);
  const blastRadius = asNum(payload["blast_radius"]);
  const changed = asNum(payload["changed_file_count"]);
  const affected = asNum(payload["affected_symbol_count"]);
  const communities = asNum(payload["communities_touched"]);
  const reviewers = asArr(payload["recommended_reviewers"]);

  const lines = [
    `Verdict: ${verdict.toUpperCase()} (confidence ${confidence.toFixed(2)}, exit ${exitCode})`,
    `Blast radius: ${blastRadius} | changed files: ${changed} | affected symbols: ${affected} | communities: ${communities}`,
  ];
  if (reviewers.length > 0) {
    lines.push(
      `Reviewers: ${reviewers
        .slice(0, 5)
        .map((r) => asStr(r["name"] ?? r["email_hash"] ?? r["id"]))
        .filter((s) => s.length > 0)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

// ─── scan ─────────────────────────────────────────────────────────────

export function formatScan(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const summary = (payload["summary"] as Sc) ?? {};
  const total = asNum(summary["total"]);
  const byTool = (summary["byTool"] as Record<string, unknown>) ?? {};
  const errored = asArr(payload["errored"]);
  const outputPath = asStr(payload["outputPath"]);

  const lines = [`scan: ${total} finding(s) across ${Object.keys(byTool).length} scanner(s)`];
  if (outputPath) lines.push(`SARIF: ${outputPath}`);
  for (const [tool, count] of Object.entries(byTool).sort()) {
    lines.push(`  ${tool}: ${asNum(count)}`);
  }
  if (errored.length > 0) {
    lines.push(`Errored scanners (${errored.length}):`);
    for (const e of errored.slice(0, 5)) {
      // `errored` entries are strings like "id: message" in the current shape.
      lines.push(`  - ${typeof e === "string" ? e : JSON.stringify(e)}`);
    }
  }
  return lines.join("\n");
}

// ─── list_findings ────────────────────────────────────────────────────

export function formatListFindings(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const findings = asArr(payload["findings"]);
  const total = asNum(payload["total"], findings.length);
  if (findings.length === 0) {
    return "No findings. Run `codehub scan` or `codehub ingest-sarif <log>`.";
  }
  const lines = [`${total} finding(s):`];
  for (const f of findings.slice(0, MAX_LIST)) {
    const startLine = f["startLine"];
    const loc = typeof startLine === "number" ? `:${startLine}` : "";
    lines.push(
      `  [${asStr(f["severity"])}] ${asStr(f["scanner"])}:${asStr(f["ruleId"])} — ${asStr(f["filePath"])}${loc} — ${asStr(f["message"])}`,
    );
  }
  if (findings.length > MAX_LIST) {
    lines.push(`  … ${findings.length - MAX_LIST} more`);
  }
  return lines.join("\n");
}

// ─── list_findings_delta ──────────────────────────────────────────────

export function formatListFindingsDelta(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const summary = (payload["summary"] as Sc) ?? {};
  const findings = (payload["findings"] as Sc) ?? {};
  const newItems = asArr(findings["new"]);
  const fixed = asArr(findings["fixed"]);
  const updated = asArr(findings["updated"]);
  const unchanged = asArr(findings["unchanged"]);
  const warnings = asArr(payload["warnings"]);

  const lines = [
    `Delta: ${asNum(summary["new"], newItems.length)} new · ${asNum(summary["fixed"], fixed.length)} fixed · ${asNum(summary["unchanged"], unchanged.length)} unchanged · ${asNum(summary["updated"], updated.length)} updated`,
  ];
  if (warnings.length > 0) {
    for (const w of warnings) lines.push(`Warning: ${String(w)}`);
  }
  if (newItems.length > 0) {
    lines.push("New:");
    for (const f of newItems.slice(0, 15)) {
      lines.push(
        `  [${asStr(f["severity"])}] ${asStr(f["scanner"])}:${asStr(f["ruleId"])} — ${asStr(f["filePath"])} — ${asStr(f["message"])}`,
      );
    }
    if (newItems.length > 15) lines.push(`  … ${newItems.length - 15} more`);
  }
  return lines.join("\n");
}

// ─── rename ───────────────────────────────────────────────────────────

export function formatRename(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const status = asStr(payload["status"], "unknown");
  if (payload["ambiguous"] === true) {
    return "Rename: target ambiguous — pass `file` to narrow the target, or call `context` first.";
  }
  const filesAffected = asNum(payload["files_affected"]);
  const totalEdits = asNum(payload["total_edits"]);
  const graphEdits = asNum(payload["graph_edits"]);
  const textEdits = asNum(payload["text_edits"]);
  const changes = asArr(payload["changes"]);

  const lines = [
    `Rename (${status}): ${filesAffected} file(s), ${totalEdits} edit(s), graph=${graphEdits}, text=${textEdits}`,
  ];
  for (const c of changes.slice(0, 15)) {
    const source = asStr(c["source"]);
    const marker = source === "graph" ? "✓" : "?";
    const conf = asNum(c["confidence"], 1);
    lines.push(
      `  ${marker} ${asStr(c["filePath"])}:${asNum(c["line"])}:${asNum(c["column"])} "${asStr(c["before"])}" → "${asStr(c["after"])}" (conf ${conf.toFixed(2)})`,
    );
  }
  if (changes.length > 15) {
    lines.push(`  … ${changes.length - 15} more`);
  }
  return lines.join("\n");
}

// ─── api_impact ───────────────────────────────────────────────────────

export function formatApiImpact(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const routes = asArr(payload["routes"]);
  const highest = asStr(payload["highestRisk"], "LOW");
  if (routes.length === 0) {
    return "api_impact: no matching routes.";
  }
  const lines = [`api_impact: ${routes.length} route(s), highest risk: ${highest}`];
  for (const r of routes.slice(0, MAX_LIST)) {
    const route = (r["route"] as Sc) ?? {};
    const consumers = asArr(r["consumers"]);
    const middleware = asArr(r["middleware"]);
    const mismatches = asArr(r["mismatches"]);
    const procs = asArr(r["affectedProcesses"]);
    lines.push(
      `  [${asStr(r["risk"])}] ${asStr(route["method"])} ${asStr(route["url"])} — consumers=${consumers.length}, middleware=${middleware.length}, mismatches=${mismatches.length}, processes=${procs.length}`,
    );
  }
  return lines.join("\n");
}

// ─── shape_check ──────────────────────────────────────────────────────

export function formatShapeCheck(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const routes = asArr(payload["routes"]);
  if (routes.length === 0) {
    return "shape_check: no matching routes.";
  }
  const lines: string[] = [];
  let mismatches = 0;
  for (const r of routes) {
    const consumers = asArr(r["consumers"]);
    const responseKeys = asArr(r["responseKeys"]);
    lines.push(
      `${asStr(r["method"])} ${asStr(r["url"])} keys=${responseKeys.length} consumers=${consumers.length}`,
    );
    for (const c of consumers.slice(0, 10)) {
      const status = asStr(c["status"]);
      if (status === "MISMATCH") mismatches += 1;
      const missing = asArr(c["missing"]);
      const missTag =
        missing.length > 0 ? ` missing=[${missing.map((m) => String(m)).join(",")}]` : "";
      lines.push(`  [${status}] ${asStr(c["file"])}${missTag}`);
    }
  }
  lines.unshift(`shape_check: ${routes.length} route(s), ${mismatches} mismatch(es)`);
  return lines.join("\n");
}

// ─── route_map ────────────────────────────────────────────────────────

export function formatRouteMap(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const routes = asArr(payload["routes"]);
  const total = asNum(payload["total"], routes.length);
  if (routes.length === 0) {
    return "route_map: no matching routes.";
  }
  const lines = [`${total} route(s):`];
  for (const r of routes.slice(0, MAX_LIST)) {
    const handlers = asArr(r["handlers"]);
    const consumers = asArr(r["consumers"]);
    const keys = asArr(r["responseKeys"]);
    lines.push(
      `  ${asStr(r["method"])} ${asStr(r["url"])} handlers=${handlers.length} consumers=${consumers.length} keys=${keys.length}`,
    );
  }
  if (routes.length > MAX_LIST) {
    lines.push(`  … ${routes.length - MAX_LIST} more`);
  }
  return lines.join("\n");
}

// ─── tool_map ─────────────────────────────────────────────────────────

export function formatToolMap(result: ToolResult): string {
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  const payload = sc(result);
  const tools = asArr(payload["tools"]);
  const total = asNum(payload["total"], tools.length);
  if (tools.length === 0) {
    return "tool_map: no Tool nodes.";
  }
  const lines = [`${total} tool(s):`];
  for (const t of tools.slice(0, MAX_LIST)) {
    const schemaTag = t["inputSchema"] ? " [schema]" : "";
    const desc = asStr(t["description"]);
    const descTag = desc ? ` — ${desc}` : "";
    lines.push(`  ${asStr(t["name"])}${schemaTag} @ ${asStr(t["filePath"])}${descTag}`);
  }
  if (tools.length > MAX_LIST) {
    lines.push(`  … ${tools.length - MAX_LIST} more`);
  }
  return lines.join("\n");
}

// ─── dispatch table ───────────────────────────────────────────────────

type Formatter = (result: ToolResult) => string;

const FORMATTERS: Readonly<Record<string, Formatter>> = Object.freeze({
  query: formatQuery,
  context: formatContext,
  impact: formatImpact,
  detect_changes: formatDetectChanges,
  list_repos: formatListRepos,
  sql: formatSql,
  verdict: formatVerdict,
  scan: formatScan,
  list_findings: formatListFindings,
  list_findings_delta: formatListFindingsDelta,
  rename: formatRename,
  api_impact: formatApiImpact,
  shape_check: formatShapeCheck,
  route_map: formatRouteMap,
  tool_map: formatToolMap,
});

/**
 * Map a tool name + result into a compact text body. Unknown tools fall
 * back to pretty-printed JSON of `structuredContent` so the harness
 * still sees everything, just slightly more verbose.
 */
export function formatToolResult(toolName: string, result: ToolResult): string {
  const formatter = FORMATTERS[toolName];
  if (formatter) return formatter(result);
  const errLine = errorPrefix(result);
  if (errLine) return errLine;
  try {
    return JSON.stringify(result.structuredContent ?? {}, null, 2);
  } catch {
    return result.text || "(no result)";
  }
}
