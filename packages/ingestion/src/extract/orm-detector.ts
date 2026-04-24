/**
 * ORM call detectors for Prisma and Supabase.
 *
 * Regexes authored fresh from:
 *   - Prisma Client API:     https://www.prisma.io/docs/orm/reference/prisma-client-reference
 *   - Supabase JS reference: https://supabase.com/docs/reference/javascript/select
 *
 * Both detectors are intentionally receiver-agnostic: any identifier ending
 * in the known root name (`prisma`, `supabase`) triggers the scan.
 * TODO: tighten by resolved receiver type once import resolution is available here.
 */

import type { ExtractedOrmEdge, ExtractInput } from "./types.js";

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

/** Prisma Client operation names — the public model-delegate surface. */
const PRISMA_OPS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

/**
 * Match `<ident>.<model>.<op>(` where the identifier contains `prisma`
 * (case-insensitive). Model name must be a valid JS identifier; op must be
 * one of `PRISMA_OPS`.
 */
const PRISMA_CALL_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

export function detectPrismaCalls(input: ExtractInput): readonly ExtractedOrmEdge[] {
  const { filePath, content } = input;
  if (!/prisma/i.test(content)) return [];
  const out: ExtractedOrmEdge[] = [];
  PRISMA_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null = PRISMA_CALL_RE.exec(content);
  while (match !== null) {
    const receiver = match[1] ?? "";
    const model = match[2];
    const op = match[3];
    match = PRISMA_CALL_RE.exec(content);
    if (model === undefined || op === undefined) continue;
    if (!/prisma/i.test(receiver)) continue;
    if (!PRISMA_OPS.has(op)) continue;
    // `prisma.$transaction(...)` etc. use `$` prefix — already excluded
    // because `$transaction` isn't in `PRISMA_OPS` and a `$`-prefixed token
    // wouldn't be treated as a model anyway.
    if (model.startsWith("$")) continue;
    out.push({
      callerFile: filePath,
      modelName: model,
      operation: op,
      orm: "prisma",
      confidence: 0.9,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

/** Supabase query-builder leaf operations we treat as "writes/reads". */
const SUPABASE_OPS = ["select", "insert", "upsert", "update", "delete"] as const;

/**
 * Match `<ident>.from('table')` / `.from("table")` / \`.from(\`table\`)\`.
 * The `from()` call is what binds a table name in supabase-js.
 */
const SUPABASE_FROM_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*from\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`$]+)`)\s*\)/g;

/** Window (in characters) after `.from(...)` to look for the leaf op. */
const SUPABASE_OP_WINDOW = 10;

export function detectSupabaseCalls(input: ExtractInput): readonly ExtractedOrmEdge[] {
  const { filePath, content } = input;
  if (!/supabase/i.test(content)) return [];
  const out: ExtractedOrmEdge[] = [];
  SUPABASE_FROM_RE.lastIndex = 0;
  let match: RegExpExecArray | null = SUPABASE_FROM_RE.exec(content);
  while (match !== null) {
    const receiver = match[1] ?? "";
    const table = match[2] ?? match[3] ?? match[4];
    const end = SUPABASE_FROM_RE.lastIndex;
    match = SUPABASE_FROM_RE.exec(content);

    if (table === undefined) continue;
    if (!/supabase/i.test(receiver)) continue;

    // Look ahead up to SUPABASE_OP_WINDOW characters for `.<op>(`.
    const tail = content.slice(end, end + SUPABASE_OP_WINDOW + 8);
    let matchedOp: string | undefined;
    for (const op of SUPABASE_OPS) {
      // Permit whitespace but require the dot to land within the window.
      const probe = new RegExp(`^\\s*\\.\\s*${op}\\s*\\(`);
      if (probe.test(tail)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp === undefined) continue;
    out.push({
      callerFile: filePath,
      modelName: table,
      operation: matchedOp,
      orm: "supabase",
      confidence: 0.85,
    });
  }
  return out;
}
