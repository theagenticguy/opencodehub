/**
 * ORM call detectors for Prisma and Supabase.
 *
 * Regexes authored fresh from:
 *   - Prisma Client API:     https://www.prisma.io/docs/orm/reference/prisma-client-reference
 *   - Supabase JS reference: https://supabase.com/docs/reference/javascript/select
 *
 * Receiver precision (P06): each candidate call site's receiver identifier
 * is confirmed against the file's import graph before an edge is emitted.
 * Prisma edges require a `@prisma/client` import; Supabase edges require a
 * `@supabase/supabase-js` import. When no import map is supplied AND
 * {@link ExtractInput.strictDetectors} is `false`, the detector falls back
 * to the pre-P06 regex-only heuristic (tagged `reason: "heuristic"` so
 * downstream can filter).
 */

import { resolveReceiver } from "./receiver-resolver.js";
import type { ExtractedOrmEdge, ExtractInput } from "./types.js";

const PRISMA_MODULE = "@prisma/client";
const SUPABASE_MODULE = "@supabase/supabase-js";

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
  const { filePath, content, importsByFile, tsMorphProject, strictDetectors } = input;
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

    const emitReason = verifyReceiver({
      receiver,
      filePath,
      expectedModule: PRISMA_MODULE,
      importsByFile,
      tsMorphProject,
      strictDetectors: strictDetectors === true,
    });
    if (emitReason === null) continue;
    out.push({
      callerFile: filePath,
      modelName: model,
      operation: op,
      orm: "prisma",
      confidence: 0.9,
      reason: emitReason,
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
  const { filePath, content, importsByFile, tsMorphProject, strictDetectors } = input;
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

    const emitReason = verifyReceiver({
      receiver,
      filePath,
      expectedModule: SUPABASE_MODULE,
      importsByFile,
      tsMorphProject,
      strictDetectors: strictDetectors === true,
    });
    if (emitReason === null) continue;
    out.push({
      callerFile: filePath,
      modelName: table,
      operation: matchedOp,
      orm: "supabase",
      confidence: 0.85,
      reason: emitReason,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Receiver verification
// ---------------------------------------------------------------------------

interface VerifyReceiverArgs {
  readonly receiver: string;
  readonly filePath: string;
  readonly expectedModule: string;
  readonly importsByFile?: ExtractInput["importsByFile"];
  readonly tsMorphProject?: ExtractInput["tsMorphProject"];
  readonly strictDetectors: boolean;
}

/**
 * Confirm the receiver identifier resolves back to `expectedModule` via the
 * import graph (and, optionally, ts-morph). Returns the provenance tag to
 * attach to the emitted edge, or `null` when the detector should drop the
 * candidate.
 *
 *  - `"receiver-confirmed"` — the resolver matched `expectedModule`.
 *  - `"heuristic"`          — resolver could not pinpoint the receiver, but
 *                             the expected module is imported elsewhere in
 *                             the file (common for ORM clients wrapped by
 *                             a local factory), OR no import map was
 *                             supplied at all and strict-mode is off.
 *  - `null`                 — resolver returned a DIFFERENT module, OR
 *                             strict-mode is on and no positive match found.
 */
function verifyReceiver(args: VerifyReceiverArgs): "receiver-confirmed" | "heuristic" | null {
  const { receiver, filePath, expectedModule, importsByFile, tsMorphProject, strictDetectors } =
    args;

  const origin = resolveReceiver(receiver, filePath, importsByFile, tsMorphProject);
  if (origin !== null) {
    if (origin.moduleName === expectedModule) return "receiver-confirmed";
    // Resolved to a DIFFERENT module — this is a real false positive the
    // heuristic would have otherwise emitted. Always drop.
    return null;
  }

  // Resolver could not pinpoint the receiver's origin. If the expected
  // module is imported anywhere in the file we treat this as a weaker
  // "same-module" heuristic — typical for Prisma clients constructed from
  // `new PrismaClient()` or wrapped by a `createClient()` factory where
  // the receiver identifier isn't itself imported. `strictDetectors`
  // disables this fallback.
  if (importsByFile !== undefined) {
    if (strictDetectors) return null;
    if (fileImportsModule(filePath, expectedModule, importsByFile)) return "heuristic";
    return null;
  }

  // No import map plumbed at all — fall back to the pre-P06 regex emit
  // unless strict mode is on.
  if (strictDetectors) return null;
  return "heuristic";
}

/** `true` when `filePath` imports from `moduleName` (exact specifier match). */
function fileImportsModule(
  filePath: string,
  moduleName: string,
  importsByFile: NonNullable<ExtractInput["importsByFile"]>,
): boolean {
  const imports = importsByFile.get(filePath);
  if (imports === undefined) return false;
  for (const imp of imports) {
    if (imp.source === moduleName) return true;
  }
  return false;
}
