/**
 * Lightweight read-only SQL guard.
 *
 * The primary safety mechanism for user-supplied queries is opening the DuckDB
 * connection in `READ_ONLY` access mode — the engine itself rejects mutating
 * statements with a clear error. This guard is belt-and-braces: it catches
 * obviously-bad inputs before they hit the engine, and blocks extension /
 * configuration commands (INSTALL / LOAD / ATTACH / PRAGMA) that DuckDB does
 * permit in read-only mode and that would let a caller reach outside the
 * sandbox.
 */

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

/**
 * Tokens that must never appear as a statement-leading keyword. The list covers
 * every DDL/DML verb DuckDB knows about, plus ATTACH/COPY/INSTALL/LOAD which
 * could exfiltrate data or load arbitrary code even on a read-only connection.
 * PRAGMA is also blocked — the one read-only PRAGMA a user might want
 * (`EXPLAIN`) is reachable via the `EXPLAIN` keyword directly.
 */
const BANNED_LEADING_KEYWORDS: readonly string[] = [
  "CREATE",
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "REPLACE",
  "MERGE",
  "VACUUM",
  "ATTACH",
  "DETACH",
  "COPY",
  "IMPORT",
  "EXPORT",
  "INSTALL",
  "LOAD",
  "UNINSTALL",
  "PRAGMA",
  "SET",
  "RESET",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "CHECKPOINT",
  "CALL",
  "USE",
];

const ALLOWED_LEADING_KEYWORDS: ReadonlySet<string> = new Set([
  "SELECT",
  "WITH",
  "EXPLAIN",
  "DESCRIBE",
  "SHOW",
  "SUMMARIZE",
  "VALUES",
  "FROM", // DuckDB FROM-first SELECT shorthand.
  "TABLE", // shorthand for SELECT * FROM table.
]);

/**
 * Strip single/double/dollar-quoted strings, line comments (`-- ...`), and
 * block comments (`/* ... *\/`). We replace each with a single space so that
 * the resulting tokens remain well-separated for keyword scanning.
 */
function stripStringsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i + 2);
      i = eol === -1 ? n : eol;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n) {
        const c = sql[i];
        if (c === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (c === quote) {
          // Handle SQL-standard doubled-quote escaping: '' or "".
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
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

/** True if the statement body (after stripping strings/comments) contains text. */
function hasNonWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return true;
  }
  return false;
}

/**
 * Reject any SQL that is not a single read-only statement. Call this before
 * handing `sql` to DuckDB on a read-only connection.
 */
export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new SqlGuardError("SQL must be a non-empty string");
  }

  const cleaned = stripStringsAndComments(sql);

  // Split on `;` and ensure at most one non-empty statement.
  const parts = cleaned.split(";");
  let nonEmptyParts = 0;
  for (const part of parts) {
    if (hasNonWhitespace(part)) nonEmptyParts += 1;
  }
  if (nonEmptyParts > 1) {
    throw new SqlGuardError("Stacked statements are not allowed");
  }

  // Leading-keyword check — case-insensitive, unicode-whitespace tolerant.
  const match = /^[\s]*([A-Za-z_][A-Za-z0-9_]*)/.exec(cleaned);
  if (!match) {
    throw new SqlGuardError("SQL does not start with a recognizable keyword");
  }
  const first = (match[1] ?? "").toUpperCase();
  if (BANNED_LEADING_KEYWORDS.includes(first)) {
    throw new SqlGuardError(`Write / DDL statement rejected: ${first}`);
  }
  if (!ALLOWED_LEADING_KEYWORDS.has(first)) {
    throw new SqlGuardError(`Leading keyword not allowed: ${first}`);
  }

  // Second-line banned tokens that can appear after a legitimate WITH/SELECT
  // via subquery injection, e.g. `WITH x AS (SELECT 1) INSERT INTO ...`.
  // We require that none of the DDL/DML verbs appear as standalone tokens.
  const upper = ` ${cleaned.toUpperCase()} `;
  for (const kw of BANNED_LEADING_KEYWORDS) {
    // CALL / USE also show up in legitimate function names like "call_site" —
    // use word-boundary pattern to avoid false positives.
    const pattern = new RegExp(`[^A-Z_]${kw}[^A-Z0-9_]`);
    if (pattern.test(upper)) {
      // Some keywords are legitimate inside a SELECT (e.g. USE is fine as a
      // column alias). Only reject keywords that are strictly dangerous.
      if (DANGEROUS_ANYWHERE.has(kw)) {
        throw new SqlGuardError(`Banned keyword appears in statement: ${kw}`);
      }
    }
  }
}

/**
 * Keywords that must never appear anywhere in the statement. Other banned
 * leading keywords (e.g. `SET`, `CALL`) can legitimately occur as column
 * aliases or function names and are only blocked at the leading position.
 */
const DANGEROUS_ANYWHERE: ReadonlySet<string> = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "REPLACE",
  "MERGE",
  "ATTACH",
  "DETACH",
  "COPY",
  "IMPORT",
  "EXPORT",
  "INSTALL",
  "LOAD",
  "UNINSTALL",
  "PRAGMA",
]);
