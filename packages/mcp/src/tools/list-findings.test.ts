// biome-ignore-all lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { KnowledgeGraph } from "@opencodehub/core-types";
import type {
  BulkLoadStats,
  DuckDbStore,
  EmbeddingRow,
  SearchQuery,
  SearchResult,
  SqlParam,
  StoreMeta,
  TraverseQuery,
  TraverseResult,
  VectorQuery,
  VectorResult,
} from "@opencodehub/storage";
import { ConnectionPool } from "../connection-pool.js";
import { registerListFindingsTool } from "./list-findings.js";
import type { ToolContext } from "./shared.js";

interface FakeRow {
  [k: string]: unknown;
}

function makeFakeStore(rows: FakeRow[]): DuckDbStore {
  const api = {
    open: async () => {},
    close: async () => {},
    createSchema: async () => {},
    bulkLoad: async (_g: KnowledgeGraph): Promise<BulkLoadStats> => ({
      nodeCount: 0,
      edgeCount: 0,
      durationMs: 0,
    }),
    upsertEmbeddings: async (_r: readonly EmbeddingRow[]): Promise<void> => {},
    query: async (
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<readonly Record<string, unknown>[]> => {
      const text = sql.replace(/\s+/g, " ").trim();
      if (!text.includes("kind = 'Finding'")) return [];
      let out = rows;
      let pi = 0;
      if (text.includes("severity = ?")) {
        const v = params[pi++];
        out = out.filter((r) => r["severity"] === v);
      }
      if (text.includes("scanner_id = ?")) {
        const v = params[pi++];
        out = out.filter((r) => r["scanner_id"] === v);
      }
      if (text.includes("rule_id = ?")) {
        const v = params[pi++];
        out = out.filter((r) => r["rule_id"] === v);
      }
      if (text.includes("file_path LIKE ?")) {
        const v = String(params[pi++] ?? "").replace(/%/g, "");
        out = out.filter((r) => String(r["file_path"] ?? "").includes(v));
      }
      return out;
    },
    search: async (_q: SearchQuery): Promise<readonly SearchResult[]> => [],
    vectorSearch: async (_q: VectorQuery): Promise<readonly VectorResult[]> => [],
    traverse: async (_q: TraverseQuery): Promise<readonly TraverseResult[]> => [],
    getMeta: async (): Promise<StoreMeta | undefined> => undefined,
    setMeta: async (_m: StoreMeta): Promise<void> => {},
    healthCheck: async () => ({ ok: true }),
  } as unknown as DuckDbStore;
  return api;
}

async function withHarness(
  rows: FakeRow[],
  fn: (ctx: ToolContext, server: McpServer) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-findings-"));
  try {
    const repoPath = resolve(home, "fakerepo");
    await mkdir(repoPath, { recursive: true });
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(
      resolve(regDir, "registry.json"),
      JSON.stringify({
        fakerepo: {
          name: "fakerepo",
          path: repoPath,
          indexedAt: "2026-04-18T00:00:00Z",
          nodeCount: rows.length,
          edgeCount: 0,
          lastCommit: "abc123",
        },
      }),
    );
    const pool = new ConnectionPool({ max: 2, ttlMs: 60_000 }, async () => makeFakeStore(rows));
    const ctx: ToolContext = { pool, home };
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    try {
      await fn(ctx, server);
    } finally {
      await pool.shutdown();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

function getHandler(server: McpServer, name: string): RegisteredTool["handler"] {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal field for test-only access
  const map = (server as any)._registeredTools as Record<string, RegisteredTool>;
  const entry = map[name];
  assert.ok(entry, `tool not registered: ${name}`);
  return entry.handler.bind(entry);
}

test("list_findings returns every finding by default", async () => {
  await withHarness(findings(), async (ctx, server) => {
    registerListFindingsTool(server, ctx);
    const handler = getHandler(server, "list_findings");
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
    const handler = getHandler(server, "list_findings");
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
    const handler = getHandler(server, "list_findings");
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
    const handler = getHandler(server, "list_findings");
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
    const handler = getHandler(server, "list_findings");
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
