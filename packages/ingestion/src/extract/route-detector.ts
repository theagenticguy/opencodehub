/**
 * Route detectors.
 *
 * This file carries Next.js App Router (filesystem routing) and Express
 * (app/router verb calls). Sibling files supply the other detectors:
 *
 *   - FastAPI / Starlette: route-detector-python.ts
 *   - Spring MVC + WebFlux: route-detector-java.ts
 *   - NestJS: route-detector-nestjs.ts
 *   - Rails (`config/routes.rb`): route-detector-rails.ts
 *
 * All patterns below were authored fresh from the public framework
 * documentation:
 *   - Next.js App Router: https://nextjs.org/docs/app/building-your-application/routing
 *   - Express routing:    https://expressjs.com/en/guide/routing.html
 */

import { resolveReceiver } from "./receiver-resolver.js";
import type { ExtractedRoute, ExtractInput } from "./types.js";

/**
 * Module specifier the Express detector verifies receivers against. We
 * accept only the canonical `"express"` specifier; wrapping libraries
 * (`express-promise-router`, etc.) that rename `app`/`router` locally will
 * land via their own `localAlias` so this tight match is safe.
 */
const EXPRESS_MODULE = "express";

// ---------------------------------------------------------------------------
// Next.js (App Router)
// ---------------------------------------------------------------------------

/** Files that are not routable themselves, even though they sit under `app/`. */
const NEXTJS_SPECIAL_FILES: ReadonlySet<string> = new Set([
  "layout",
  "error",
  "loading",
  "not-found",
  "global-error",
  "template",
  "default",
]);

/** HTTP verbs that, when exported from a `route.ts`, become method handlers. */
const NEXTJS_ROUTE_VERBS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;

/** Match `export async function GET`, `export function POST`, `export const DELETE =`, etc. */
const NEXTJS_VERB_EXPORT_RE =
  /export\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;

/**
 * Convert one App-Router path segment to URL form:
 *   - `(group)`        -> dropped (route groups, docs: "Route Groups")
 *   - `[...slug]`      -> `{+slug}` (catch-all)
 *   - `[[...slug]]`    -> `{+slug}` (optional catch-all; same shape at this layer)
 *   - `[id]`           -> `{id}` (dynamic segment)
 *   - anything else    -> passed through unchanged
 */
function nextJsSegmentToUrl(segment: string): string | null {
  if (segment.length === 0) return null;
  // Route groups: (foo) — invisible in URL.
  if (segment.startsWith("(") && segment.endsWith(")")) return null;
  // Optional catch-all: [[...name]]
  const optionalCatch = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optionalCatch) return `{+${optionalCatch[1]}}`;
  // Catch-all: [...name]
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return `{+${catchAll[1]}}`;
  // Dynamic: [name]
  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic) return `{${dynamic[1]}}`;
  return segment;
}

/**
 * Given a repo-relative file path, return the canonical URL under App Router,
 * or `null` if the file is not a route. The input `filePath` is expected to
 * be POSIX-style (forward slashes); on Windows callers should normalise.
 */
function nextJsUrlFromFilePath(filePath: string, repoRoot: string): string | null {
  const normalized = normalizeRelative(filePath, repoRoot);
  const parts = normalized.split("/");
  const appIndex = parts.indexOf("app");
  if (appIndex === -1) return null;
  const under = parts.slice(appIndex + 1);
  if (under.length === 0) return null;

  const last = under[under.length - 1];
  if (last === undefined) return null;
  const match = last.match(/^(.+)\.(tsx?|jsx?|mjs|mts|cjs|cts)$/);
  if (!match) return null;
  const basename = match[1] as string;

  // Only `route` and `page` map to URLs; layouts/error/loading/etc. are skipped.
  if (basename !== "route" && basename !== "page") return null;
  if (NEXTJS_SPECIAL_FILES.has(basename)) return null;

  const urlSegments: string[] = [];
  for (const seg of under.slice(0, -1)) {
    const converted = nextJsSegmentToUrl(seg);
    if (converted === null) continue;
    urlSegments.push(converted);
  }
  return urlSegments.length === 0 ? "/" : `/${urlSegments.join("/")}`;
}

function normalizeRelative(filePath: string, repoRoot: string): string {
  const p = filePath.replace(/\\/g, "/");
  const r = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (r.length > 0 && p.startsWith(`${r}/`)) return p.slice(r.length + 1);
  if (p.startsWith("/")) return p.slice(1);
  return p;
}

function extractNextJsVerbs(content: string): string[] {
  const verbs = new Set<string>();
  NEXTJS_VERB_EXPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null = NEXTJS_VERB_EXPORT_RE.exec(content);
  while (match !== null) {
    const verb = match[1];
    if (verb !== undefined) verbs.add(verb);
    match = NEXTJS_VERB_EXPORT_RE.exec(content);
  }
  // Preserve canonical ordering instead of insertion order for byte-stability.
  return NEXTJS_ROUTE_VERBS.filter((v) => verbs.has(v));
}

/**
 * Walk the supplied files, filter to those under `app/**`, and emit one
 * `ExtractedRoute` per route/method pair. `page.tsx` files emit a single
 * route with no method (treated as an HTML GET page by consumers).
 */
export function detectNextJsRoutes(
  files: readonly { filePath: string; content: string }[],
  repoRoot: string,
): readonly ExtractedRoute[] {
  const out: ExtractedRoute[] = [];
  for (const file of files) {
    const url = nextJsUrlFromFilePath(file.filePath, repoRoot);
    if (url === null) continue;
    const rel = normalizeRelative(file.filePath, repoRoot);
    const isRoute = /(^|\/)route\.(tsx?|jsx?|mjs|mts|cjs|cts)$/.test(rel);

    if (isRoute) {
      const verbs = extractNextJsVerbs(file.content);
      if (verbs.length === 0) {
        // A route.ts with no recognised verb export is still a route shell;
        // surface it without a method so the pipeline can warn downstream.
        out.push({ url, handlerFile: rel, framework: "nextjs" });
      } else {
        for (const method of verbs) {
          out.push({ url, method, handlerFile: rel, framework: "nextjs" });
        }
      }
    } else {
      // `page.tsx` — a renderable route; no HTTP method attached.
      out.push({ url, handlerFile: rel, framework: "nextjs" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

/**
 * Match `app.get('/x', h)` / `router.post("/x", m, h)` / `server.use(\`/x\`, h)`.
 *
 * Group 1: receiver identifier (e.g. `app`, `router`, `apiRouter`).
 * Group 2: HTTP verb keyword.
 * Group 3: path — single-quoted, double-quoted, or template-literal body.
 *
 * Template-literal bodies are captured verbatim; callers inspect for `${...}`
 * to decide whether to log a warning about unresolved interpolation.
 */
const EXPRESS_ROUTE_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|delete|patch|all|use)\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;

const EXPRESS_VERBS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "all",
  "use",
]);

/**
 * Regex-scan the file content for Express route registrations and emit one
 * {@link ExtractedRoute} per (receiver, verb, path) triple whose receiver
 * identifier resolves back to the `"express"` npm module. When no import
 * map is supplied AND {@link ExtractInput.strictDetectors} is `false`, the
 * detector falls back to the pre-P06 regex-only behavior so dogfood mode
 * on legacy callers still produces edges.
 */
export function detectExpressRoutes(input: ExtractInput): readonly ExtractedRoute[] {
  const { filePath, content, importsByFile, tsMorphProject, strictDetectors } = input;
  const out: ExtractedRoute[] = [];
  EXPRESS_ROUTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = EXPRESS_ROUTE_RE.exec(content);
  while (match !== null) {
    const receiver = match[1] ?? "";
    const verb = (match[2] ?? "").toLowerCase();
    const pathSingle = match[3];
    const pathDouble = match[4];
    const pathTemplate = match[5];
    const rawPath = pathSingle ?? pathDouble ?? pathTemplate;
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;
    match = EXPRESS_ROUTE_RE.exec(content);

    if (rawPath === undefined) continue;
    if (!EXPRESS_VERBS.has(verb)) continue;
    if (pathTemplate !== undefined && /\$\{[^}]*\}/.test(pathTemplate)) {
      // Template literal with interpolation; the URL cannot be resolved
      // statically. Skip but leave a console warning so pipeline logs can
      // surface it; consumers that want silent behaviour can wrap console.
      // eslint-disable-next-line no-console
      console.warn(
        `[extract/route-detector] express template literal with interpolation at ${filePath}: ${pathTemplate}`,
      );
      continue;
    }

    if (!confirmExpressReceiver(receiver, filePath, importsByFile, tsMorphProject, strictDetectors))
      continue;

    // Scrape the handler body for `res.json({...})` / `res.send({...})`
    // object-literal shapes so downstream Route nodes can carry
    // `responseKeys`. We scope the scan to the balanced-paren call that
    // registered this route so neighbouring handlers don't bleed in.
    const callBody = extractBalancedArgument(content, matchEnd);
    const responseKeys = scrapeExpressResponseKeys(callBody);

    out.push({
      url: rawPath,
      method: verb.toUpperCase(),
      handlerFile: filePath,
      framework: "express",
      ...(responseKeys !== undefined ? { responseKeys } : {}),
    });
  }
  return out;
}

/**
 * Confirm `receiver` resolves to an `express` import in `filePath`. Returns
 * `true` when:
 *   - the import-graph or ts-morph path matches `"express"`, OR
 *   - an import map is present, the receiver itself wasn't resolved, but
 *     `"express"` is imported somewhere in the file (covers
 *     `const app = express()` where `app` is a local const, not an
 *     import) — unless strict mode is on, OR
 *   - no import map was plumbed AND strict mode is off (legacy fallback).
 *
 * Returns `false` when:
 *   - the receiver resolved to a DIFFERENT module (real false positive), OR
 *   - an import map was plumbed, strict mode is on, and the receiver
 *     isn't imported, OR
 *   - an import map was plumbed, express is not imported anywhere in the
 *     file, and the receiver itself isn't imported.
 */
function confirmExpressReceiver(
  receiver: string,
  filePath: string,
  importsByFile: ExtractInput["importsByFile"],
  tsMorphProject: ExtractInput["tsMorphProject"],
  strictDetectors: boolean | undefined,
): boolean {
  const origin = resolveReceiver(receiver, filePath, importsByFile, tsMorphProject);
  if (origin !== null) return origin.moduleName === EXPRESS_MODULE;
  if (importsByFile !== undefined) {
    if (strictDetectors) return false;
    const imports = importsByFile.get(filePath);
    if (imports === undefined) return false;
    for (const imp of imports) {
      if (imp.source === EXPRESS_MODULE) return true;
    }
    return false;
  }
  return strictDetectors !== true;
}

// ---------------------------------------------------------------------------
// Response-key scraping
// ---------------------------------------------------------------------------

/**
 * Read from `startIdx` onward until the first balanced `)` closes. Returns
 * the substring between the opening `(` and the matching `)`. When the
 * starting region contains no opening paren (defensive) we return an empty
 * string.
 */
function extractBalancedArgument(content: string, startIdx: number): string {
  let i = startIdx;
  let depth = 0;
  let seenOpen = false;
  let bodyStart = -1;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "(") {
      if (!seenOpen) {
        seenOpen = true;
        bodyStart = i + 1;
      }
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        if (bodyStart === -1) return "";
        return content.slice(bodyStart, i);
      }
    } else if (!seenOpen && ch === ",") {
      // The regex match consumed the verb's opening paren + path literal;
      // the `,` we hit here is the outer call's separator, so walk back
      // to the original opening paren (already past startIdx).
      if (bodyStart === -1) bodyStart = startIdx;
      seenOpen = true;
      depth = 1;
    }
    i += 1;
  }
  return "";
}

/** Extract top-level object keys from the first `res.json({...})` match. */
function scrapeExpressResponseKeys(body: string): readonly string[] | undefined {
  if (body.length === 0) return undefined;
  const callRe = /\b(?:res|response)\s*\.\s*(?:json|send)\s*\(\s*(\{[\s\S]*?\})\s*[,)]/;
  const m = callRe.exec(body);
  if (m === null) return undefined;
  const keys = parseTopLevelObjectKeys(m[1] as string);
  return [...keys].sort();
}

/** Extract top-level keys from a `NextResponse.json({...})` / `Response.json({...})`. */
function scrapeNextResponseKeys(handlerBody: string): readonly string[] | undefined {
  if (handlerBody.length === 0) return undefined;
  const callRe = /\b(?:NextResponse|Response)\s*\.\s*json\s*\(\s*(\{[\s\S]*?\})\s*[,)]/;
  const m = callRe.exec(handlerBody);
  if (m === null) return undefined;
  const keys = parseTopLevelObjectKeys(m[1] as string);
  return [...keys].sort();
}

/**
 * Parse `{ key1: ..., key2: "x" }` and return the literal top-level keys.
 * Strips nested object/array bodies so `{a:{b:1},c:2}` returns `[a,c]`.
 * Computed keys (`[foo]: 1`) and spreads are dropped.
 */
function parseTopLevelObjectKeys(literal: string): readonly string[] {
  const body = literal.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let tokenStart = 0;
  let i = 0;
  const boundary = (): void => {
    const segment = body.slice(tokenStart, i).trim();
    tokenStart = i + 1;
    if (segment.length === 0) return;
    const colonIdx = segment.indexOf(":");
    const keyPart = (colonIdx === -1 ? segment : segment.slice(0, colonIdx)).trim();
    const m = /^['"]?([A-Za-z_$][\w$]*)['"]?$/.exec(keyPart);
    if (m !== null) keys.push(m[1] as string);
  };
  while (i < body.length) {
    const ch = body[i];
    if (inString !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) boundary();
    i += 1;
  }
  boundary();
  return keys;
}

/**
 * Walk each Next.js verb handler's body for `NextResponse.json({...})` /
 * `Response.json({...})` and attach the literal keys to the matching route.
 * Returns a fresh array; callers must not mutate the originals.
 */
export function populateNextJsResponseKeys(
  routes: readonly ExtractedRoute[],
  files: readonly { filePath: string; content: string }[],
): readonly ExtractedRoute[] {
  if (routes.length === 0) return routes;
  const contentByFile = new Map<string, string>();
  for (const f of files) contentByFile.set(f.filePath, f.content);
  return routes.map((r) => {
    if (r.framework !== "nextjs") return r;
    if (r.method === undefined) return r;
    const content = findFileContent(contentByFile, r.handlerFile);
    if (content === undefined) return r;
    const handlerBody = extractNextJsHandlerBody(content, r.method);
    const keys = scrapeNextResponseKeys(handlerBody);
    return keys !== undefined ? { ...r, responseKeys: keys } : r;
  });
}

function findFileContent(
  contentByFile: ReadonlyMap<string, string>,
  handlerFile: string,
): string | undefined {
  const direct = contentByFile.get(handlerFile);
  if (direct !== undefined) return direct;
  for (const [k, v] of contentByFile) {
    if (k.endsWith(`/${handlerFile}`)) return v;
  }
  return undefined;
}

function extractNextJsHandlerBody(content: string, verb: string): string {
  const fnRe = new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\s*\\([^)]*\\)\\s*\\{`, "m");
  const fnMatch = fnRe.exec(content);
  if (fnMatch !== null) {
    const start = fnMatch.index + fnMatch[0].length - 1;
    return sliceBalancedBlock(content, start);
  }
  const constRe = new RegExp(
    `export\\s+const\\s+${verb}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`,
    "m",
  );
  const constMatch = constRe.exec(content);
  if (constMatch !== null) {
    const start = constMatch.index + constMatch[0].length - 1;
    return sliceBalancedBlock(content, start);
  }
  return "";
}

function sliceBalancedBlock(content: string, openBraceIdx: number): string {
  if (content[openBraceIdx] !== "{") return "";
  let depth = 0;
  let inString: string | null = null;
  for (let i = openBraceIdx; i < content.length; i += 1) {
    const ch = content[i];
    if (inString !== null) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(openBraceIdx + 1, i);
    }
  }
  return "";
}
