/**
 * Outbound HTTP-call detectors (W2-D.3).
 *
 * Lightweight regex-based detectors shared across provider hooks. The
 * patterns intentionally trade recall for precision: we prefer to miss
 * exotic forms than emit false positives that pollute the FETCHES graph.
 *
 * Covered clients:
 *   TypeScript / JavaScript:
 *     - `fetch(url, { method: "POST" })`, `fetch(url)` (default GET)
 *     - `axios.get(url, ...)`, `axios.post(url, ...)`, `axios({method, url})`
 *     - `ky.get(url)` / `ky.post(url)`
 *   Python:
 *     - `requests.get(url, ...)`, `requests.post(url, ...)`
 *     - `httpx.get(url)`, `httpx.post(url)`, `httpx.AsyncClient().get(url)`
 *     - `urllib.request.urlopen(url)` — best-effort, assumed GET
 *   Go:
 *     - `http.Get(url)`, `http.Post(url, ...)`, `http.PostForm(url, ...)`
 *   Java:
 *     - `restTemplate.getForObject(url, ...)`, `restTemplate.postForObject(url, ...)`
 *     - `webClient.get().uri(url)`, `webClient.post().uri(url)`
 *     - OkHttp `Request.Builder().url(url)` — method defaults to GET unless
 *       a subsequent `.post(...)` / `.put(...)` / `.delete(...)` is chained.
 *
 * Every detector is purely text-oriented. Providers can call into these
 * helpers from their `detectOutboundHttp` hook and merge / sort the result.
 */

import type { HttpCall } from "./types.js";

type HttpMethod = HttpCall["method"];

const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);

/**
 * Deterministic sort so two runs of the same input always yield the same
 * edge order. Order:
 *   1. ascending startLine
 *   2. tiebreak on method
 *   3. tiebreak on urlTemplate
 *   4. tiebreak on clientLibrary
 */
export function sortHttpCalls(calls: readonly HttpCall[]): readonly HttpCall[] {
  const copy = [...calls];
  copy.sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    if (a.urlTemplate !== b.urlTemplate) return a.urlTemplate < b.urlTemplate ? -1 : 1;
    if (a.clientLibrary !== b.clientLibrary) return a.clientLibrary < b.clientLibrary ? -1 : 1;
    return 0;
  });
  return copy;
}

/** Convert `:id` / `{id}` to a canonical `{id}` form and drop query strings. */
export function normalizeUrlTemplate(raw: string): string {
  const qIdx = raw.indexOf("?");
  const stripped = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const trimmed = stripped.trim();
  // Convert Express-style `:name` to `{name}`.
  return trimmed.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function matchMethodString(raw: string): HttpMethod | undefined {
  const upper = raw.toUpperCase();
  return METHODS.has(upper) ? (upper as HttpMethod) : undefined;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const TS_STRING_URL = /(['"`])([^'"`]+)\1/;

/** Match `fetch(url, { method: "POST" })` and `fetch(url)` (default GET). */
const FETCH_CALL = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1(?:\s*,\s*\{([^}]*)\})?\s*\)/g;

/**
 * Match `axios.get("/x")`, `axios.post("/x", body)`, etc. The verb is any of
 * the HTTP methods lowercased.
 */
const AXIOS_VERB =
  /\b(axios|ky)\s*\.\s*(get|post|put|patch|delete|head|options|trace)\s*\(\s*(['"`])([^'"`]+)\3/g;

/** `axios({ method: "post", url: "/x" })` */
const AXIOS_CONFIG = /\baxios\s*\(\s*\{([^}]*)\}\s*\)/g;

function extractTsAxiosConfigBody(body: string): { method?: HttpMethod; url?: string } {
  const methodMatch = /\bmethod\s*:\s*(['"`])([^'"`]+)\1/.exec(body);
  const urlMatch = /\burl\s*:\s*(['"`])([^'"`]+)\1/.exec(body);
  const out: { method?: HttpMethod; url?: string } = {};
  if (methodMatch) {
    const m = matchMethodString(methodMatch[2] as string);
    if (m !== undefined) out.method = m;
  }
  if (urlMatch) {
    out.url = urlMatch[2] as string;
  }
  return out;
}

export function detectHttpCallsTsJs(sourceText: string): readonly HttpCall[] {
  const out: HttpCall[] = [];

  for (const m of sourceText.matchAll(FETCH_CALL)) {
    const url = m[2] as string;
    const optsBody = m[3] ?? "";
    let method: HttpMethod = "GET";
    const mm = /\bmethod\s*:\s*(['"`])([^'"`]+)\1/.exec(optsBody);
    if (mm) {
      const parsed = matchMethodString(mm[2] as string);
      if (parsed !== undefined) method = parsed;
    }
    const start = lineOf(sourceText, m.index ?? 0);
    out.push({
      method,
      urlTemplate: normalizeUrlTemplate(url),
      startLine: start,
      endLine: start,
      clientLibrary: "fetch",
    });
  }

  for (const m of sourceText.matchAll(AXIOS_VERB)) {
    const lib = m[1] as string;
    const verb = m[2] as string;
    const url = m[4] as string;
    const method = matchMethodString(verb);
    if (method === undefined) continue;
    const start = lineOf(sourceText, m.index ?? 0);
    out.push({
      method,
      urlTemplate: normalizeUrlTemplate(url),
      startLine: start,
      endLine: start,
      clientLibrary: lib,
    });
  }

  for (const m of sourceText.matchAll(AXIOS_CONFIG)) {
    const body = m[1] as string;
    const parsed = extractTsAxiosConfigBody(body);
    if (parsed.url === undefined) continue;
    const method = parsed.method ?? "GET";
    const start = lineOf(sourceText, m.index ?? 0);
    out.push({
      method,
      urlTemplate: normalizeUrlTemplate(parsed.url),
      startLine: start,
      endLine: start,
      clientLibrary: "axios",
    });
  }

  return sortHttpCalls(out);
}

// Keep `TS_STRING_URL` referenced (imported for future use / documentation).
void TS_STRING_URL;

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_VERB_CALL =
  /\b(requests|httpx)(?:\.AsyncClient\(\)|\.Client\(\))?\s*\.\s*(get|post|put|patch|delete|head|options|trace)\s*\(\s*(['"])([^'"]+)\3/gi;

const PY_URLOPEN = /\burllib\.request\.urlopen\s*\(\s*(['"])([^'"]+)\1/g;

export function detectHttpCallsPython(sourceText: string): readonly HttpCall[] {
  const out: HttpCall[] = [];

  for (const m of sourceText.matchAll(PY_VERB_CALL)) {
    const lib = (m[1] as string).toLowerCase();
    const verb = m[2] as string;
    const url = m[4] as string;
    const method = matchMethodString(verb);
    if (method === undefined) continue;
    const start = lineOf(sourceText, m.index ?? 0);
    out.push({
      method,
      urlTemplate: normalizeUrlTemplate(url),
      startLine: start,
      endLine: start,
      clientLibrary: lib,
    });
  }

  for (const m of sourceText.matchAll(PY_URLOPEN)) {
    const url = m[2] as string;
    const start = lineOf(sourceText, m.index ?? 0);
    out.push({
      method: "GET",
      urlTemplate: normalizeUrlTemplate(url),
      startLine: start,
      endLine: start,
      clientLibrary: "urllib",
    });
  }

  return sortHttpCalls(out);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_VERB_CALL = /\bhttp\.(Get|Post|PostForm|Head|Put|Delete|Patch)\s*\(\s*(["`])([^"`]+)\2/g;

export function detectHttpCallsGo(sourceText: string): readonly HttpCall[] {
  const out: HttpCall[] = [];
  for (const m of sourceText.matchAll(GO_VERB_CALL)) {
    const verbRaw = m[1] as string;
    const url = m[3] as string;
    const verb = verbRaw === "PostForm" ? "POST" : verbRaw.toUpperCase();
    const method = matchMethodString(verb);
    if (method === undefined) continue;
    const start = lineOf(sourceText, m.index ?? 0);
    out.push({
      method,
      urlTemplate: normalizeUrlTemplate(url),
      startLine: start,
      endLine: start,
      clientLibrary: "net/http",
    });
  }
  return sortHttpCalls(out);
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_REST_TEMPLATE =
  /\b(restTemplate|this\.restTemplate)\s*\.\s*(getForObject|getForEntity|postForObject|postForEntity|put|delete|patchForObject|exchange)\s*\(\s*"([^"]+)"/g;

const JAVA_WEBCLIENT_URI =
  /\bwebClient\s*\.\s*(get|post|put|patch|delete|head|options|trace)\s*\(\s*\)\s*\.\s*uri\s*\(\s*"([^"]+)"/g;

const JAVA_OKHTTP_URL = /new\s+Request\.Builder\s*\(\s*\)\s*\.\s*url\s*\(\s*"([^"]+)"/g;

const JAVA_OKHTTP_METHOD_CHAIN = /\.(get|post|put|patch|delete|head|options)\s*\(/g;

function restTemplateVerb(op: string): HttpMethod | undefined {
  const o = op.toLowerCase();
  if (o.startsWith("getfor")) return "GET";
  if (o.startsWith("postfor")) return "POST";
  if (o === "put") return "PUT";
  if (o === "delete") return "DELETE";
  if (o.startsWith("patchfor")) return "PATCH";
  if (o === "exchange") return "GET"; // ambiguous — default to GET
  return undefined;
}

export function detectHttpCallsJava(sourceText: string): readonly HttpCall[] {
  const out: HttpCall[] = [];

  for (const m of sourceText.matchAll(JAVA_REST_TEMPLATE)) {
    const op = m[2] as string;
    const url = m[3] as string;
    const method = restTemplateVerb(op);
    if (method === undefined) continue;
    const start = lineOf(sourceText, m.index ?? 0);
    out.push({
      method,
      urlTemplate: normalizeUrlTemplate(url),
      startLine: start,
      endLine: start,
      clientLibrary: "restTemplate",
    });
  }

  for (const m of sourceText.matchAll(JAVA_WEBCLIENT_URI)) {
    const verb = m[1] as string;
    const url = m[2] as string;
    const method = matchMethodString(verb);
    if (method === undefined) continue;
    const start = lineOf(sourceText, m.index ?? 0);
    out.push({
      method,
      urlTemplate: normalizeUrlTemplate(url),
      startLine: start,
      endLine: start,
      clientLibrary: "webClient",
    });
  }

  // OkHttp: correlate `new Request.Builder().url(X)` with any method-verb
  // chained within the next ~400 characters of source. If no verb is found
  // assume GET.
  for (const m of sourceText.matchAll(JAVA_OKHTTP_URL)) {
    const url = m[1] as string;
    const start = lineOf(sourceText, m.index ?? 0);
    const end = (m.index ?? 0) + (m[0] as string).length;
    const windowText = sourceText.slice(end, end + 400);
    let method: HttpMethod = "GET";
    const chain = JAVA_OKHTTP_METHOD_CHAIN.exec(windowText);
    // Reset lastIndex so subsequent iterations of the outer loop aren't
    // skewed by the inner regex state.
    JAVA_OKHTTP_METHOD_CHAIN.lastIndex = 0;
    if (chain !== null) {
      const parsed = matchMethodString(chain[1] as string);
      if (parsed !== undefined) method = parsed;
    }
    out.push({
      method,
      urlTemplate: normalizeUrlTemplate(url),
      startLine: start,
      endLine: start,
      clientLibrary: "okhttp",
    });
  }

  return sortHttpCalls(out);
}
