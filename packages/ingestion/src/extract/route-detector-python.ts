/**
 * FastAPI / Starlette route detector.
 *
 * Scans Python source files for the canonical decorator patterns that
 * attach an HTTP handler to a URL:
 *
 *   @app.get("/users")                   # FastAPI / Starlette on `app`
 *   @app.post("/users")
 *   @router.put("/users/{id}")            # FastAPI APIRouter
 *   @router.delete("/users/{id}")
 *   @router.patch("/users/{id}")
 *   @app.api_route("/x", methods=["GET"]) # both
 *
 * Profile-gated: the pipeline phase only dispatches here when `python`
 * participates and the `fastapi` framework is present on the
 * `ProjectProfile.frameworks` list. Matching is regex-based (clean-room,
 * from the FastAPI docs) because building an AST-driven path would add
 * per-file cost the other detectors already avoid.
 */

import type { ExtractedRoute, ExtractInput } from "./types.js";

const FASTAPI_VERBS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);

/**
 * Decorator pattern.
 *  - Group 1: receiver identifier (`app`, `router`, `api_router`, …).
 *  - Group 2: HTTP verb keyword.
 *  - Group 3 | 4: single- / double-quoted URL body.
 *
 * Multi-line arguments (`@app.get(\n    "/users",\n    response_model=…\n)`)
 * work because the URL always appears as the first positional argument —
 * we stop at the first quoted string that follows the opening paren.
 */
const DECORATOR_VERB_RE =
  /@\s*([A-Za-z_][\w]*)\s*\.\s*(get|post|put|delete|patch|head|options|trace)\s*\(\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * `@app.api_route("/x", methods=["GET", "POST"])` — both pre- and post-
 * kwarg forms. Returns one route per listed method.
 */
const API_ROUTE_RE =
  /@\s*([A-Za-z_][\w]*)\s*\.\s*api_route\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*,\s*methods\s*=\s*\[([^\]]*)\]/g;

/**
 * File-scoped detector. Emits one {@link ExtractedRoute} per detected
 * decorator. Does not resolve `receiver` against the type graph — two
 * imports of `router` from sibling files produce two separate route
 * registrations, which is correct for FastAPI.
 */
export function detectFastApiRoutes(input: ExtractInput): readonly ExtractedRoute[] {
  const { filePath, content } = input;
  const out: ExtractedRoute[] = [];

  DECORATOR_VERB_RE.lastIndex = 0;
  let m: RegExpExecArray | null = DECORATOR_VERB_RE.exec(content);
  while (m !== null) {
    const verb = (m[2] ?? "").toLowerCase();
    const url = m[3] ?? m[4];
    m = DECORATOR_VERB_RE.exec(content);
    if (url === undefined || !FASTAPI_VERBS.has(verb)) continue;
    out.push({
      url,
      method: verb.toUpperCase(),
      handlerFile: filePath,
      framework: "fastapi",
    });
  }

  API_ROUTE_RE.lastIndex = 0;
  let am: RegExpExecArray | null = API_ROUTE_RE.exec(content);
  while (am !== null) {
    const url = am[2] ?? am[3];
    const methodsBody = am[4] ?? "";
    am = API_ROUTE_RE.exec(content);
    if (url === undefined) continue;
    const methods = parseMethodsList(methodsBody);
    for (const method of methods) {
      out.push({
        url,
        method,
        handlerFile: filePath,
        framework: "fastapi",
      });
    }
  }

  return out;
}

function parseMethodsList(body: string): readonly string[] {
  const out: string[] = [];
  // Match each quoted string — captures single- and double-quoted forms.
  for (const m of body.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const v = (m[1] ?? m[2] ?? "").toUpperCase();
    if (v.length > 0 && FASTAPI_VERBS.has(v.toLowerCase())) out.push(v);
  }
  return out;
}
