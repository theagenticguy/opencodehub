// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type FakeFinding,
  getToolHandler,
  makeFakeGraphStore,
  withMcpHarness,
} from "../test-utils.js";
import { registerListFindingsTool } from "./list-findings.js";
import type { ToolContext } from "./shared.js";

interface FakeRow {
  [k: string]: unknown;
}

/**
 * Project the snake_case test seed shape onto the `FakeFinding` record
 * the test-utils helper coerces into the typed `FindingNode` `listFindings`
 * returns. Tests retain the original SARIF-style key names; the helper
 * normalizes to camelCase.
 */
function rowToFinding(r: FakeRow): FakeFinding {
  const props = (() => {
    const raw = r["properties_bag"];
    if (typeof raw !== "string") return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const sev = r["severity"];
  const out: FakeFinding = {
    id: typeof r["id"] === "string" ? r["id"] : "",
    kind: "Finding",
    name: typeof r["rule_id"] === "string" ? r["rule_id"] : "",
    filePath: typeof r["file_path"] === "string" ? r["file_path"] : "",
    scannerId: typeof r["scanner_id"] === "string" ? r["scanner_id"] : "",
    ruleId: typeof r["rule_id"] === "string" ? r["rule_id"] : "",
    ...(typeof sev === "string" ? { severity: sev as FakeFinding["severity"] } : {}),
    message: typeof r["message"] === "string" ? r["message"] : "",
    propertiesBag: props,
    ...(typeof r["start_line"] === "number" ? { startLine: r["start_line"] as number } : {}),
    ...(typeof r["end_line"] === "number" ? { endLine: r["end_line"] as number } : {}),
  };
  return out;
}

async function withHarness(
  rows: FakeRow[],
  fn: (
    ctx: ToolContext,
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  ) => Promise<void>,
): Promise<void> {
  await withMcpHarness(
    {
      tmpPrefix: "codehub-mcp-findings-",
      storeFactory: () => makeFakeGraphStore({ findings: rows.map(rowToFinding) }),
    },
    async ({ server, pool, home }) => {
      const ctx: ToolContext = { pool, home };
      await fn(ctx, server);
    },
  );
}

function findings(): FakeRow[] {
  return [
    {
      id: "Finding:src/api.ts:semgrep:semgrep.xss:10",
      scanner_id: "semgrep",
      rule_id: "semgrep.xss",
      severity: "error",
      message: "Potential XSS",
      file_path: "src/api.ts",
      start_line: 10,
      end_line: 12,
      properties_bag: JSON.stringify({ "opencodehub.blastRadius": 3 }),
    },
    {
      id: "Finding:src/db.ts:osv-scanner:GHSA-xyz:1",
      scanner_id: "osv-scanner",
      rule_id: "GHSA-xyz",
      severity: "warning",
      message: "vulnerable dep",
      file_path: "src/db.ts",
      start_line: 1,
      end_line: null,
      properties_bag: "{}",
    },
    {
      id: "Finding:src/api.ts:bandit:B101:50",
      scanner_id: "bandit",
      rule_id: "B101",
      severity: "note",
      message: "use assert",
      file_path: "src/api.ts",
      start_line: 50,
      end_line: null,
      properties_bag: "{}",
    },
  ];
}

test("list_findings returns every finding by default", async () => {
  await withHarness(findings(), async (ctx, server) => {
    registerListFindingsTool(server, ctx);
    const handler = getToolHandler(server, "list_findings");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      findings: Array<{ scanner: string; ruleId: string; severity: string }>;
      total: number;
    };
    assert.equal(sc.total, 3);
    const rules = sc.findings.map((f) => f.ruleId).sort();
    assert.deepEqual(rules, ["B101", "GHSA-xyz", "semgrep.xss"]);
  });
});

test("list_findings filters by severity", async () => {
  await withHarness(findings(), async (ctx, server) => {
    registerListFindingsTool(server, ctx);
    const handler = getToolHandler(server, "list_findings");
    const result = await handler({ repo: "fakerepo", severity: "error" }, {});
    const sc = result.structuredContent as {
      findings: Array<{ severity: string; ruleId: string }>;
      total: number;
    };
    assert.equal(sc.total, 1);
    assert.equal(sc.findings[0]?.ruleId, "semgrep.xss");
    assert.equal(sc.findings[0]?.severity, "error");
  });
});

test("list_findings filters by scanner", async () => {
  await withHarness(findings(), async (ctx, server) => {
    registerListFindingsTool(server, ctx);
    const handler = getToolHandler(server, "list_findings");
    const result = await handler({ repo: "fakerepo", scanner: "bandit" }, {});
    const sc = result.structuredContent as {
      findings: Array<{ scanner: string }>;
      total: number;
    };
    assert.equal(sc.total, 1);
    assert.equal(sc.findings[0]?.scanner, "bandit");
  });
});

test("list_findings filters by file path substring", async () => {
  await withHarness(findings(), async (ctx, server) => {
    registerListFindingsTool(server, ctx);
    const handler = getToolHandler(server, "list_findings");
    const result = await handler({ repo: "fakerepo", filePath: "api" }, {});
    const sc = result.structuredContent as {
      findings: Array<{ filePath: string }>;
      total: number;
    };
    assert.equal(sc.total, 2);
    for (const f of sc.findings) {
      assert.ok(f.filePath.includes("api"));
    }
  });
});

test("list_findings returns an empty list + remediation hint when no rows match", async () => {
  await withHarness([], async (ctx, server) => {
    registerListFindingsTool(server, ctx);
    const handler = getToolHandler(server, "list_findings");
    const result = await handler({ repo: "fakerepo" }, {});
    const sc = result.structuredContent as {
      findings: unknown[];
      total: number;
      next_steps: string[];
    };
    assert.equal(sc.total, 0);
    assert.ok(sc.next_steps.some((s) => s.includes("codehub scan")));
  });
});
