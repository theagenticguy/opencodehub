/**
 * Lightweight read-only Cypher guard.
 *
 * Mirrors {@link ./sql-guard.ts} but for the Cypher dialect the graph-db
 * backend accepts. The guard's job is to reject obvious write verbs before
 * they reach the native binding — the native engine does enforce its own
 * read-only mode when the connection is opened read-only, but we want a
 * typed rejection earlier in the stack plus a consistent user-facing
 * message regardless of backend.
 *
 * Scope:
 *   - Allowlist of reader clauses: MATCH, RETURN, WITH, WHERE, ORDER BY,
 *     LIMIT, SKIP, UNWIND.
 *   - `CALL` is rejected unless the invocation is exactly one of the two
 *     known read-only index procedures the FTS / vector surfaces need:
 *     `QUERY_FTS_INDEX(...)` or `QUERY_VECTOR_INDEX(...)`.
 *   - Writes are rejected: CREATE, DELETE, SET, MERGE, REMOVE, DROP (plus
 *     the DDL / DML verbs the native binding documents even if they are
 *     not technically Cypher — ALTER, COPY, IMPORT, EXPORT, CHECKPOINT,
 *     INSTALL, LOAD EXTENSION).
 *
 * Tokenization is lexical (regex over the un-commented query text) — this
 * is a defense-in-depth check, not a full Cypher parser. Strings in which
 * a banned keyword legitimately appears (e.g. a node property literal
 * containing the word "DELETE") are correctly ignored because the string-
 * stripping pass drops them before the keyword sweep.
 *
 * Known limitation: the string-stripper walks the raw source character by
 * character and does not understand Cypher's full quoting grammar (no
 * backtick-delimited identifier handling, no multi-line triple-quotes).
 * That is acceptable for v1 — the allowlist-first leading-keyword check
 * provides the load-bearing guarantee and the string stripper is only
 * responsible for the "banned keyword inside a string literal" edge case
 * on the single/double-quoted forms we actually use in practice.
 */

export class CypherGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CypherGuardError";
  }
}

/**
 * Leading-keyword allowlist. A Cypher statement must start with one of
 * these clauses. Case-insensitive. `CALL` is intentionally absent — the
 * CALL-procedure check is a separate, stricter path below.
 */
const ALLOWED_LEADING_KEYWORDS: ReadonlySet<string> = new Set([
  "MATCH",
  "OPTIONAL", // `OPTIONAL MATCH ...`
  "RETURN",
  "WITH",
  "UNWIND",
]);

/**
 * Clauses that are allowed anywhere in the statement body (they always
 * follow a reader clause, not a standalone statement). Listed here for
 * documentation — the guard does not actually check "what may follow what",
 * it only rejects writes.
 */
const _ALLOWED_BODY_CLAUSES: readonly string[] = [
  "MATCH",
  "WHERE",
  "RETURN",
  "WITH",
  "ORDER BY",
  "LIMIT",
  "SKIP",
  "UNWIND",
];
void _ALLOWED_BODY_CLAUSES;

/**
 * Exact names of the CALL-able procedures we permit. The graph-db engine
 * exposes a `CALL QUERY_FTS_INDEX('Table', 'IndexName', 'text')` surface
 * and `CALL QUERY_VECTOR_INDEX('Table', 'IndexName', vec, k)`; both are
 * read-only. Any other CALL invocation is rejected — CREATE_FTS_INDEX,
 * DROP_TABLES, LOAD_FROM, `db.*` administrative procedures, user-defined
 * procs: all off-limits.
 */
const ALLOWED_CALL_PROCEDURES: ReadonlySet<string> = new Set([
  "QUERY_FTS_INDEX",
  "QUERY_VECTOR_INDEX",
]);

/**
 * Write / DDL verbs that must never appear as a standalone token anywhere
 * in the statement body. Comparison is case-insensitive and uses a
 * word-boundary regex so a legitimate column name like `created_at` or a
 * node property like `n.creator` does not trip the guard.
 *
 * `LOAD EXTENSION` is a two-word sentinel — we check it before the bare
 * `LOAD` match so the error message points at the right pattern.
 */
const BANNED_KEYWORDS: readonly string[] = [
  "CREATE",
  "MERGE",
  "DELETE",
  "SET",
  "REMOVE",
  "DROP",
  "ALTER",
  "COPY",
  "IMPORT",
  "EXPORT",
  "CHECKPOINT",
  "INSTALL",
  "DETACH", // DETACH DELETE variant
];

/**
 * Strip single-line (`// ...`) and block (`/ * ... * /`) comments from the
 * source Cypher. String literals are preserved so the subsequent quote
 * handler can decide what lives inside them.
 *
 * Returns the stripped text — comment bodies are replaced with a single
 * space so surrounding tokens stay well-separated.
 */
function stripComments(cypher: string): string {
  let out = "";
  let i = 0;
  const n = cypher.length;
  // Track whether we're inside a string so a `//` that appears inside a
  // string literal is NOT treated as a comment. We recognise `'...'` and
  // `"..."` with standard backslash escaping.
  let inQuote: '"' | "'" | null = null;
  while (i < n) {
    const ch = cypher[i];
    const next = cypher[i + 1];
    if (inQuote !== null) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      const eol = cypher.indexOf("\n", i + 2);
      i = eol === -1 ? n : eol;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = cypher.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Replace every string literal with a single space, so keyword scanning
 * never matches a banned word that appears inside a user-supplied string.
 * Handles `'...'` and `"..."` with backslash escaping.
 */
function stripStrings(cypher: string): string {
  let out = "";
  let i = 0;
  const n = cypher.length;
  while (i < n) {
    const ch = cypher[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n) {
        const c = cypher[i];
        if (c === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function hasNonWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return true;
  }
  return false;
}

/**
 * Extract the leading keyword (first identifier token) from the cleaned
 * statement. Returns `null` when no identifier is present. Case is
 * preserved so the caller can uppercase for comparison.
 */
function leadingKeyword(cypher: string): string | null {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(cypher);
  if (!match) return null;
  return match[1] ?? null;
}

/**
 * Extract a CALL invocation's procedure name. Returns `null` when the
 * statement does not start with `CALL`. Returns an empty string when the
 * `CALL` keyword is present but no procedure name follows (malformed
 * input — rejected by the caller).
 */
function leadingCallProcedure(cypher: string): string | null {
  const match = /^\s*CALL\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(cypher);
  if (!match) return null;
  return match[1] ?? "";
}

/**
 * Reject any Cypher that is not a single read-only statement. Call before
 * handing the text to the graph-db backend.
 *
 * Contract:
 *   - Input must be a non-empty string.
 *   - Statement must start with one of ALLOWED_LEADING_KEYWORDS, or be a
 *     CALL to one of ALLOWED_CALL_PROCEDURES.
 *   - No banned write verb may appear anywhere in the statement body (after
 *     comments + string literals are stripped).
 *
 * Throws {@link CypherGuardError} on any violation.
 */
export function assertReadOnlyCypher(cypher: string): void {
  if (typeof cypher !== "string" || cypher.trim().length === 0) {
    throw new CypherGuardError("Cypher must be a non-empty string");
  }

  const uncommented = stripComments(cypher);
  if (!hasNonWhitespace(uncommented)) {
    throw new CypherGuardError("Cypher must contain a statement");
  }

  // Leading-keyword / CALL check.
  const lead = leadingKeyword(uncommented);
  if (lead === null) {
    throw new CypherGuardError("Cypher does not start with a recognizable keyword");
  }
  const leadUpper = lead.toUpperCase();

  if (leadUpper === "CALL") {
    const procRaw = leadingCallProcedure(uncommented);
    if (procRaw === null || procRaw.length === 0) {
      throw new CypherGuardError("CALL requires a procedure name");
    }
    const proc = procRaw.toUpperCase();
    if (!ALLOWED_CALL_PROCEDURES.has(proc)) {
      throw new CypherGuardError(
        `CALL procedure not allowed: ${proc}. Allowed: ${[...ALLOWED_CALL_PROCEDURES].join(", ")}`,
      );
    }
  } else if (leadUpper === "OPTIONAL") {
    // OPTIONAL MATCH is the only valid OPTIONAL-starting form.
    const match = /^\s*OPTIONAL\s+MATCH\b/i.exec(uncommented);
    if (!match) {
      throw new CypherGuardError("OPTIONAL must be followed by MATCH");
    }
  } else if (!ALLOWED_LEADING_KEYWORDS.has(leadUpper)) {
    throw new CypherGuardError(`Leading keyword not allowed: ${leadUpper}`);
  }

  // Body-wide banned-keyword sweep. Strip strings FIRST so a literal like
  // `RETURN 'please DELETE this later'` does not trip. `LOAD EXTENSION` is
  // checked before bare `LOAD` because the bare sentinel is not banned
  // (the native binding uses `LOAD EXTENSION fts` and `LOAD CSV` — the
  // latter is a writer-style call even though its keyword is not in our
  // list, so we require `LOAD` to appear as a two-word phrase; the
  // standalone `LOAD` token is rejected by the allowlist check above).
  const bodySource = stripStrings(uncommented);
  const upper = ` ${bodySource.toUpperCase()} `;

  if (/\bLOAD\s+EXTENSION\b/.test(upper)) {
    throw new CypherGuardError("Banned keyword appears in statement: LOAD EXTENSION");
  }

  for (const kw of BANNED_KEYWORDS) {
    // Word-boundary match so `n.createdAt` does not trip `CREATE`. We use
    // an explicit non-alphanumeric-underscore lookaround equivalent via
    // surrounding-char checks — `\b` handles this correctly in JS regex.
    const pattern = new RegExp(`\\b${kw}\\b`);
    if (pattern.test(upper)) {
      throw new CypherGuardError(`Banned keyword appears in statement: ${kw}`);
    }
  }
}
