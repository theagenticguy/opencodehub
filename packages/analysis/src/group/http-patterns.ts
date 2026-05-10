/**
 * Regex-based HTTP contract extractor. Detects:
 *   - Express / Fastify / Koa routes:     `app.get('/users')`, `router.post(...)`, `fastify.route(...)`
 *   - Flask / FastAPI routes:             `@app.route('/x')`, `@app.get('/x')`, `@router.post('/x')`
 *   - fetch() consumers:                  `fetch('/api/x')`, `fetch('/x', { method: 'POST' })`
 *   - Python requests consumers:          `requests.get('/x')`, `requests.post('/x', ...)`
 *   - axios consumers:                    `axios.get('/x')`, `axios.post('/x', ...)`
 *
 * The extractor is intentionally regex-only so the `analysis` package does
 * not pick up a tree-sitter dependency. We accept a small false-positive
 * rate in exchange for a build that stays under 100ms per file. Contracts
 * converge on a canonical `signature` (`METHOD <normalized-path>`), which
 * is the key the cross-link resolver matches on.
 */

import type { Contract, ContractType } from "./types.js";

/** Normalize a URL template so `:id`, `{id}`, trailing slashes collapse. */
export function normalizeHttpPath(raw: string): string {
  const trimmed = raw.trim();
  const noQuery = trimmed.replace(/\?.*$/, "");
  const braces = noQuery.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
  const noTrailing = braces.replace(/\/+$/, "");
  if (noTrailing.length === 0) return "/";
  return noTrailing.startsWith("/") ? noTrailing : `/${noTrailing}`;
}

export function httpSignature(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizeHttpPath(path)}`;
}

const JS_HTTP_VERBS = "get|post|put|delete|patch|head|options";

/**
 * Express / Fastify / Koa style: `xxx.get('/path', ...)`.
 * We require the receiver to be at least one identifier (app, router,
 * server, fastify, ...). Matches member chains like `app.use(...).get(...)`
 * via the anchor-on-`.verb(` pattern.
 */
const JS_ROUTE_RE = new RegExp(
  `(?:\\b|\\.)((?:${JS_HTTP_VERBS}))\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
  "g",
);

/**
 * `fetch('url')` or `fetch('url', { method: 'POST' })`. Method defaults to
 * GET when no options object is present or when the method key is missing.
 */
const FETCH_RE = /\bfetch\s*\(\s*['"`]([^'"`]+)['"`](\s*,\s*\{[^}]*\})?/g;
const FETCH_METHOD_KEY_RE = /method\s*:\s*['"`]([A-Za-z]+)['"`]/;

/** `axios.get('url', ...)` — member-method form only. */
const AXIOS_RE = new RegExp(`\\baxios\\.(${JS_HTTP_VERBS})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, "g");

/**
 * Flask / FastAPI / Quart / Starlette-style decorators. Matches:
 *   @app.route('/x', methods=['POST'])
 *   @app.get('/x')
 *   @router.post('/x')
 */
const PY_METHOD_DECORATOR_RE = new RegExp(
  `@\\s*[A-Za-z_][A-Za-z0-9_]*\\.(${JS_HTTP_VERBS})\\s*\\(\\s*['"]([^'"]+)['"]`,
  "g",
);
const PY_ROUTE_DECORATOR_RE =
  /@\s*[A-Za-z_][A-Za-z0-9_]*\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?/g;

/** Python `requests.get('/url', ...)`. */
const PY_REQUESTS_RE = new RegExp(
  `\\brequests\\.(${JS_HTTP_VERBS})\\s*\\(\\s*['"]([^'"]+)['"]`,
  "g",
);

function lineNumberOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

export interface HttpExtractOptions {
  readonly repo: string;
  readonly file: string;
  readonly source: string;
  readonly language: "js" | "ts" | "py";
}

/**
 * Extract HTTP producer/consumer contracts from a single file's source.
 */
export function extractHttpContracts(opts: HttpExtractOptions): readonly Contract[] {
  const { repo, file, source, language } = opts;
  const out: Contract[] = [];

  if (language === "js" || language === "ts") {
    for (const match of source.matchAll(JS_ROUTE_RE)) {
      const method = (match[1] ?? "get").toUpperCase();
      const path = match[2] ?? "";
      const line = lineNumberOf(source, match.index ?? 0);
      out.push(makeContract("http_route", method, path, repo, file, line));
    }
    for (const match of source.matchAll(FETCH_RE)) {
      const path = match[1] ?? "";
      const opts = match[2] ?? "";
      const methodMatch = opts.match(FETCH_METHOD_KEY_RE);
      const method = methodMatch?.[1]?.toUpperCase() ?? "GET";
      const line = lineNumberOf(source, match.index ?? 0);
      out.push(makeContract("http_call", method, path, repo, file, line));
    }
    for (const match of source.matchAll(AXIOS_RE)) {
      const method = (match[1] ?? "get").toUpperCase();
      const path = match[2] ?? "";
      const line = lineNumberOf(source, match.index ?? 0);
      out.push(makeContract("http_call", method, path, repo, file, line));
    }
  }

  if (language === "py") {
    for (const match of source.matchAll(PY_METHOD_DECORATOR_RE)) {
      const method = (match[1] ?? "get").toUpperCase();
      const path = match[2] ?? "";
      const line = lineNumberOf(source, match.index ?? 0);
      out.push(makeContract("http_route", method, path, repo, file, line));
    }
    for (const match of source.matchAll(PY_ROUTE_DECORATOR_RE)) {
      const path = match[1] ?? "";
      const methodsLiteral = match[2];
      const methods = methodsLiteral
        ? methodsLiteral
            .split(",")
            .map((m) => m.replace(/['"\s]/g, "").toUpperCase())
            .filter((m) => m.length > 0)
        : ["GET"];
      const line = lineNumberOf(source, match.index ?? 0);
      for (const method of methods) {
        out.push(makeContract("http_route", method, path, repo, file, line));
      }
    }
    for (const match of source.matchAll(PY_REQUESTS_RE)) {
      const method = (match[1] ?? "get").toUpperCase();
      const path = match[2] ?? "";
      const line = lineNumberOf(source, match.index ?? 0);
      out.push(makeContract("http_call", method, path, repo, file, line));
    }
  }

  return dedupContracts(out);
}

function makeContract(
  type: ContractType,
  method: string,
  path: string,
  repo: string,
  file: string,
  line: number,
): Contract {
  return {
    type,
    signature: httpSignature(method, path),
    repo,
    file,
    line,
  };
}

function dedupContracts(list: readonly Contract[]): Contract[] {
  const seen = new Set<string>();
  const out: Contract[] = [];
  for (const c of list) {
    const key = `${c.type}|${c.signature}|${c.file}|${c.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
