/**
 * `query` — hybrid keyword + vector search across the indexed graph.
 *
 * Behaviour auto-detects whether the `embeddings` table is populated. When
 * at least one embedding is present we open an ONNX embedder and run
 * `hybridSearch` (BM25 + HNSW fused via RRF). When no embeddings are
 * persisted — or when the embedder itself fails to open (missing weights,
 * native load error) — we fall back to BM25-only. Fallback is never
 * user-visible as an error: we warn to stderr and continue. This preserves
 * the MVP guarantee that `query` works on freshly-analyzed repos even
 * before `codehub setup --embeddings`.
 *
 * The `processes` field is reserved for the hybrid process-grouping output
 * that ships alongside embeddings in v1.0; today it stays empty so callers
 * can depend on the shape.
 *
 * Embedder lifecycle is per-call for v1.0 (open → embed → close). The cost
 * is an InferenceSession creation per `query` invocation which is acceptable
 * at the traffic we target for v1.0; G-stream will revisit caching at the
 * tool-registration layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Embedder } from "@opencodehub/embedder";
import type { FusedHit, SymbolHit } from "@opencodehub/search";
import { bm25Search, hybridSearch } from "@opencodehub/search";
import type { DuckDbStore, SqlParam } from "@opencodehub/storage";
import { z } from "zod";
import { toolErrorFromUnknown } from "../error-envelope.js";
import { withNextSteps } from "../next-step-hints.js";
import { stalenessFromMeta } from "../staleness.js";
import { type EmbedderFactory, type ToolContext, withStore } from "./shared.js";

const QueryInput = {
  query: z
    .string()
    .min(1)
    .describe("Free-text search phrase; ranked via BM25 (with HNSW fusion when embeddings exist)."),
  repo: z
    .string()
    .optional()
    .describe("Registered repo name. Omit to use the only registered repo."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Maximum number of symbol hits to return (default 10, max 100)."),
  kinds: z
    .array(z.string())
    .optional()
    .describe("Restrict to these NodeKind values (e.g. ['Function','Method'])."),
};

/** Row shape returned to the MCP client. Stable across BM25-only + hybrid. */
interface QueryRow {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly score: number;
  readonly sources?: readonly ("bm25" | "vector")[];
}

/**
 * Decide whether the store has any embeddings persisted. Any failure
 * (e.g. schema mismatch, extension missing) returns false so callers
 * transparently fall back to BM25.
 */
async function embeddingsPopulated(store: DuckDbStore): Promise<boolean> {
  try {
    const rows = await store.query("SELECT COUNT(*) AS n FROM embeddings", []);
    const first = rows[0];
    if (!first) return false;
    const n = Number(first["n"] ?? 0);
    return Number.isFinite(n) && n > 0;
  } catch {
    return false;
  }
}

/**
 * Hydrate fused node ids back into the SymbolHit-shaped row the MCP client
 * expects. Order is preserved from the fused list; ties within the same
 * score are already broken deterministically by RRF. Ids that don't resolve
 * (e.g. stale embedding pointing at a deleted node) are dropped.
 */
async function hydrateFused(
  store: DuckDbStore,
  fused: readonly FusedHit[],
): Promise<readonly QueryRow[]> {
  if (fused.length === 0) return [];
  const ids = Array.from(new Set(fused.map((f) => f.nodeId)));
  const placeholders = ids.map(() => "?").join(",");
  const params: readonly SqlParam[] = ids;
  const rows = await store.query(
    `SELECT id, name, file_path, kind FROM nodes WHERE id IN (${placeholders})`,
    params,
  );
  const byId = new Map<string, { name: string; filePath: string; kind: string }>();
  for (const r of rows) {
    const id = String(r["id"] ?? "");
    byId.set(id, {
      name: String(r["name"] ?? ""),
      filePath: String(r["file_path"] ?? ""),
      kind: String(r["kind"] ?? ""),
    });
  }
  const out: QueryRow[] = [];
  for (const hit of fused) {
    const meta = byId.get(hit.nodeId);
    if (!meta) continue;
    out.push({
      nodeId: hit.nodeId,
      name: meta.name,
      kind: meta.kind,
      filePath: meta.filePath,
      score: hit.score,
      sources: hit.sources,
    });
  }
  return out;
}

function bm25RowsToQueryRows(hits: readonly SymbolHit[]): readonly QueryRow[] {
  return hits.map((r) => ({
    nodeId: r.nodeId,
    name: r.name,
    kind: r.kind,
    filePath: r.filePath,
    score: r.score,
    sources: ["bm25" as const],
  }));
}

/**
 * Default production factory — lazy-imports `@opencodehub/embedder` so the
 * ONNX runtime native binding only loads when the tool actually needs it.
 * Tests replace this via `ctx.openEmbedder` so they don't have to stage
 * Arctic Embed XS weight files on disk.
 */
async function defaultOpenEmbedder(): Promise<Embedder> {
  const mod = await import("@opencodehub/embedder");
  return mod.openOnnxEmbedder();
}

/**
 * Open an embedder, or return null if unavailable. Any failure (missing
 * weights, native load error, unexpected exception) is treated the same
 * way: warn to stderr and fall back to BM25. We never abort the query.
 */
async function tryOpenEmbedder(open: EmbedderFactory): Promise<Embedder | null> {
  try {
    return await open();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // stdout is reserved for JSON-RPC on stdio transports; warn to stderr.
    console.warn(
      `[mcp:query] hybrid search unavailable (embeddings populated but embedder could not open): ${message}. Falling back to BM25.`,
    );
    return null;
  }
}

export function registerQueryTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "query",
    {
      title: "Search the code graph",
      description:
        "Rank symbols by relevance against a free-text phrase. Uses BM25 keyword search fused with HNSW vector search (via Reciprocal Rank Fusion) when embeddings have been generated, otherwise pure BM25. Results include `sources` indicating which ranker(s) contributed. Use this as the first lookup step when you know the concept but not the exact symbol. At MVP results arrive as a flat list; the `processes` field is reserved for v1.0 grouped output.",
      inputSchema: QueryInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const limit = args.limit ?? 10;
      const openEmbedder = ctx.openEmbedder ?? defaultOpenEmbedder;
      return withStore(ctx, args.repo, async (store, resolved) => {
        try {
          const kinds = args.kinds && args.kinds.length > 0 ? args.kinds : undefined;

          let rows: readonly QueryRow[];
          let mode: "bm25" | "hybrid" = "bm25";

          if (await embeddingsPopulated(store)) {
            const embedder = await tryOpenEmbedder(openEmbedder);
            if (embedder) {
              try {
                const fused = await hybridSearch(
                  store,
                  {
                    text: args.query,
                    limit,
                    ...(kinds !== undefined ? { kinds } : {}),
                  },
                  embedder,
                );
                rows = await hydrateFused(store, fused);
                mode = "hybrid";
              } finally {
                // Always release the native session — even on error —
                // so we don't leak ONNX runtime resources.
                await embedder.close();
              }
            } else {
              const bmHits = await bm25Search(store, {
                text: args.query,
                limit,
                ...(kinds !== undefined ? { kinds } : {}),
              });
              rows = bm25RowsToQueryRows(bmHits);
            }
          } else {
            const bmHits = await bm25Search(store, {
              text: args.query,
              limit,
              ...(kinds !== undefined ? { kinds } : {}),
            });
            rows = bm25RowsToQueryRows(bmHits);
          }

          const modeLabel = mode === "hybrid" ? "hybrid" : "BM25";
          const header = `Top ${rows.length} ${modeLabel} match(es) for "${args.query}" in ${resolved.name}:`;
          const body =
            rows.length === 0
              ? "(no matches — try a broader phrase or drop the kinds filter)"
              : rows
                  .map(
                    (r, i) =>
                      `${i + 1}. ${r.name} [${r.kind}] — ${r.filePath} (score ${r.score.toFixed(3)})`,
                  )
                  .join("\n");

          const next =
            rows.length === 0
              ? ["broaden the query or remove `kinds` filter"]
              : [
                  `call \`context\` with symbol="${rows[0]?.name ?? ""}" to see its callers/callees`,
                  `call \`impact\` on the top match to see its blast radius`,
                ];

          const staleness = stalenessFromMeta(resolved.meta);
          return withNextSteps(
            `${header}\n${body}`,
            { results: rows, processes: [], mode },
            next,
            staleness,
          );
        } catch (err) {
          return toolErrorFromUnknown(err);
        }
      });
    },
  );
}
