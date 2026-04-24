/**
 * Spring MVC / Spring WebFlux route detector.
 *
 * Covers the canonical annotation shapes:
 *
 *   @RequestMapping("/users")                              // class / method
 *   @RequestMapping(value = "/users", method = RequestMethod.GET)
 *   @GetMapping("/users/{id}")
 *   @PostMapping("/users")
 *   @PutMapping("/users/{id}")
 *   @DeleteMapping("/users/{id}")
 *   @PatchMapping("/users/{id}")
 *
 * Class-level `@RequestMapping` prefixes are concatenated with method-
 * level prefixes when both are present on the same class declaration.
 * WebFlux uses the same annotations; there is no separate dispatch.
 *
 * Profile-gated: route phase only dispatches when `java` participates
 * and `spring-boot` (or any `spring-*` variant) is on the detected
 * frameworks list.
 */

import type { ExtractedRoute, ExtractInput } from "./types.js";

const METHOD_RE =
  /@\s*(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*(?:\(\s*(?:value\s*=\s*)?(?:"([^"]*)"|\{\s*"([^"]*)"\s*\}))?/g;

const REQUEST_MAPPING_RE =
  /@\s*RequestMapping\s*\(([\s\S]*?)\)/g;

const CLASS_DECL_RE = /\bclass\s+([A-Za-z_][\w]*)/g;

/**
 * Detect Spring routes in a single Java file. Returns one entry per
 * method-level mapping; class-level `@RequestMapping` path prefixes are
 * prepended to each method's URL.
 */
export function detectSpringRoutes(input: ExtractInput): readonly ExtractedRoute[] {
  const { filePath, content } = input;
  const out: ExtractedRoute[] = [];

  // Collect class declarations + their class-level @RequestMapping prefix.
  const classRanges = collectClassRanges(content);

  // Method-specific shorthand annotations.
  METHOD_RE.lastIndex = 0;
  let m: RegExpExecArray | null = METHOD_RE.exec(content);
  while (m !== null) {
    const verb = annotationToVerb(m[1] as string);
    const url = normalizeUrl(m[2] ?? m[3] ?? "");
    const atIdx = m.index;
    m = METHOD_RE.exec(content);
    if (verb === undefined) continue;
    const enclosing = findEnclosingClass(atIdx, classRanges);
    const finalUrl = composeUrl(enclosing?.baseUrl ?? "", url);
    out.push({
      url: finalUrl,
      method: verb,
      handlerFile: filePath,
      framework: "spring",
    });
  }

  // Generic @RequestMapping — may carry `method = RequestMethod.GET` or a
  // list `method = { RequestMethod.GET, RequestMethod.POST }`.
  REQUEST_MAPPING_RE.lastIndex = 0;
  let rm: RegExpExecArray | null = REQUEST_MAPPING_RE.exec(content);
  while (rm !== null) {
    const body = rm[1] ?? "";
    const atIdx = rm.index;
    rm = REQUEST_MAPPING_RE.exec(content);
    const url = readRequestMappingUrl(body);
    const methods = readRequestMappingMethods(body);
    if (url === undefined) continue;
    const enclosing = findEnclosingClass(atIdx, classRanges);
    const finalUrl = composeUrl(enclosing?.baseUrl ?? "", normalizeUrl(url));

    if (methods.length === 0) {
      // No method filter — class-level mapping or a catch-all. Emit
      // without `method` so the downstream phase stores `ANY`.
      out.push({
        url: finalUrl,
        handlerFile: filePath,
        framework: "spring",
      });
    } else {
      for (const verb of methods) {
        out.push({
          url: finalUrl,
          method: verb,
          handlerFile: filePath,
          framework: "spring",
        });
      }
    }
  }

  return out;
}

interface ClassRange {
  readonly startIdx: number;
  readonly endIdx: number;
  readonly baseUrl: string;
}

/**
 * Walk every `class Foo` declaration in the file and associate the
 * character range `[startIdx, nextClass | eof)` with the class-level
 * `@RequestMapping` path prefix that sits immediately above the class
 * declaration. Classes without a class-level mapping get `baseUrl = ""`.
 */
function collectClassRanges(content: string): readonly ClassRange[] {
  const ranges: { startIdx: number; name: string }[] = [];
  CLASS_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null = CLASS_DECL_RE.exec(content);
  while (m !== null) {
    ranges.push({ startIdx: m.index, name: m[1] as string });
    m = CLASS_DECL_RE.exec(content);
  }

  const out: ClassRange[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r === undefined) continue;
    const endIdx = i + 1 < ranges.length ? (ranges[i + 1]?.startIdx ?? content.length) : content.length;
    const baseUrl = readClassRequestMappingAbove(content, r.startIdx);
    out.push({ startIdx: r.startIdx, endIdx, baseUrl });
  }
  return out;
}

function findEnclosingClass(idx: number, ranges: readonly ClassRange[]): ClassRange | undefined {
  for (const r of ranges) {
    if (idx >= r.startIdx && idx < r.endIdx) return r;
  }
  return undefined;
}

/**
 * Scan backwards from `classStart` looking for a `@RequestMapping(…)`
 * annotation within the last ~400 characters (enough for the annotation
 * block; Spring conventions keep class-level mappings terse).
 */
function readClassRequestMappingAbove(content: string, classStart: number): string {
  const from = Math.max(0, classStart - 400);
  const window = content.slice(from, classStart);
  const re = /@\s*RequestMapping\s*\(([\s\S]*?)\)/g;
  let best = "";
  let m: RegExpExecArray | null = re.exec(window);
  while (m !== null) {
    const url = readRequestMappingUrl(m[1] ?? "");
    if (url !== undefined) best = normalizeUrl(url);
    m = re.exec(window);
  }
  return best;
}

function readRequestMappingUrl(body: string): string | undefined {
  // `value = "/x"` or bare `"/x"` or `path = "/x"` or `{ "/a", "/b" }`.
  const valueKw = /(?:value|path)\s*=\s*(?:"([^"]*)"|\{\s*"([^"]*)"\s*\})/.exec(body);
  if (valueKw !== null) return valueKw[1] ?? valueKw[2];
  const first = /(?:^|[,\s(])(?:"([^"]*)"|\{\s*"([^"]*)"\s*\})/.exec(body);
  return first?.[1] ?? first?.[2];
}

function readRequestMappingMethods(body: string): readonly string[] {
  // `method = RequestMethod.GET` or `method = { RequestMethod.GET, ... }`.
  const methodSection = /method\s*=\s*(?:\{([^}]*)\}|([^,)\s]+))/.exec(body);
  if (methodSection === null) return [];
  const raw = methodSection[1] ?? methodSection[2] ?? "";
  const out: string[] = [];
  for (const m of raw.matchAll(/RequestMethod\.([A-Z]+)/g)) {
    out.push(m[1] as string);
  }
  return out;
}

function annotationToVerb(annotation: string): string | undefined {
  switch (annotation) {
    case "GetMapping":
      return "GET";
    case "PostMapping":
      return "POST";
    case "PutMapping":
      return "PUT";
    case "DeleteMapping":
      return "DELETE";
    case "PatchMapping":
      return "PATCH";
    default:
      return undefined;
  }
}

function normalizeUrl(u: string): string {
  if (u === "") return "/";
  return u.startsWith("/") ? u : `/${u}`;
}

function composeUrl(base: string, path: string): string {
  if (base === "") return path;
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path === "/" ? "" : path;
  const joined = `${b}${p}`;
  return joined === "" ? "/" : joined;
}
