/**
 * Ruby on Rails route detector.
 *
 * Rails collects its routes in `config/routes.rb` rather than in
 * per-controller decorators. The DSL hands us three core shapes:
 *
 *   get "/users", to: "users#index"
 *   post "posts", controller: "posts", action: "create"
 *   resources :posts                       # eight REST routes
 *   resource :profile                      # seven singular REST routes
 *   namespace :admin do
 *     resources :users                     # prefixed with /admin
 *   end
 *
 * The detector is file-scoped — pass the contents of `config/routes.rb`
 * (or any sibling route DSL file under `config/`) and it returns one
 * {@link ExtractedRoute} per concrete URL/method pair.
 *
 * Profile-gated on `"rails"` being in the detected frameworks list.
 */

import type { ExtractedRoute } from "./types.js";

/** Pattern: `get "/path"` / `post "/path"` / etc. */
const VERB_RE = /^\s*(get|post|put|patch|delete|head|options)\s+(?:"([^"]*)"|'([^']*)')/gm;

/** Pattern: `resources :posts` / `resource :profile`. */
const RESOURCE_RE = /^\s*(resources?)\s+:([A-Za-z_][\w]*)/gm;

/** Pattern: `namespace :admin do`. */
const NAMESPACE_START_RE = /^\s*namespace\s+:([A-Za-z_][\w]*)\s+do\b/;
/** Pattern: `scope "/api"` / `scope path: "/api"`. */
const SCOPE_START_RE = /^\s*scope\s+(?:"([^"]*)"|'([^']*)'|path\s*:\s*(?:"([^"]*)"|'([^']*)'))/;
/** A trailing `end` keyword on a line. */
const END_RE = /^\s*end\b/;

/**
 * Route detector for a single Rails `config/routes.rb`. `filePath`
 * should be the repo-relative POSIX path to the routes file; it becomes
 * `ExtractedRoute.handlerFile` on each emitted entry.
 */
export function detectRailsRoutes(filePath: string, content: string): readonly ExtractedRoute[] {
  const out: ExtractedRoute[] = [];

  // Prefix stack: each nested `namespace :x do ... end` or `scope "/y" do
  // ... end` block pushes a segment.
  const prefixStack: string[] = [];

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = stripLineComment(raw);
    if (line.trim().length === 0) continue;

    // Enter a namespace or scope.
    const nsMatch = NAMESPACE_START_RE.exec(line);
    if (nsMatch !== null) {
      const seg = nsMatch[1] as string;
      prefixStack.push(`/${seg}`);
      continue;
    }
    const scopeMatch = SCOPE_START_RE.exec(line);
    if (scopeMatch !== null) {
      const rawPath = scopeMatch[1] ?? scopeMatch[2] ?? scopeMatch[3] ?? scopeMatch[4] ?? "";
      prefixStack.push(normalizePath(rawPath));
      continue;
    }
    // Close the innermost block. Rails also closes `do ... end` for
    // non-prefix blocks (`draw`, `constraints`) — we always pop once we
    // see a bare `end` at the same statement level. If the stack is
    // empty, the `end` belongs to a non-prefix block and we leave it
    // alone.
    if (END_RE.test(line)) {
      if (prefixStack.length > 0) prefixStack.pop();
      continue;
    }

    const prefix = prefixStack.join("");

    // Verb-level routes.
    VERB_RE.lastIndex = 0;
    let vm: RegExpExecArray | null = VERB_RE.exec(line);
    while (vm !== null) {
      const verb = (vm[1] ?? "").toUpperCase();
      const path = vm[2] ?? vm[3] ?? "";
      vm = VERB_RE.exec(line);
      out.push({
        url: composeUrl(prefix, path),
        method: verb,
        handlerFile: filePath,
        framework: "rails",
      });
    }

    // `resources :x` / `resource :x` — expand to the canonical REST
    // mapping. Defined by Rails docs.
    RESOURCE_RE.lastIndex = 0;
    let rm: RegExpExecArray | null = RESOURCE_RE.exec(line);
    while (rm !== null) {
      const kind = rm[1] as string; // `resources` | `resource`
      const name = rm[2] as string;
      rm = RESOURCE_RE.exec(line);
      const base = kind === "resource" ? `${prefix}/${name}` : `${prefix}/${name}`;
      const idSegment = `${base}/:id`;
      if (kind === "resources") {
        out.push({ url: base, method: "GET", handlerFile: filePath, framework: "rails" });
        out.push({ url: base, method: "POST", handlerFile: filePath, framework: "rails" });
        out.push({ url: `${base}/new`, method: "GET", handlerFile: filePath, framework: "rails" });
        out.push({ url: idSegment, method: "GET", handlerFile: filePath, framework: "rails" });
        out.push({
          url: `${idSegment}/edit`,
          method: "GET",
          handlerFile: filePath,
          framework: "rails",
        });
        out.push({ url: idSegment, method: "PATCH", handlerFile: filePath, framework: "rails" });
        out.push({ url: idSegment, method: "PUT", handlerFile: filePath, framework: "rails" });
        out.push({ url: idSegment, method: "DELETE", handlerFile: filePath, framework: "rails" });
      } else {
        // singular resource — the seven default routes without :id.
        out.push({ url: base, method: "GET", handlerFile: filePath, framework: "rails" });
        out.push({ url: `${base}/new`, method: "GET", handlerFile: filePath, framework: "rails" });
        out.push({ url: base, method: "POST", handlerFile: filePath, framework: "rails" });
        out.push({ url: `${base}/edit`, method: "GET", handlerFile: filePath, framework: "rails" });
        out.push({ url: base, method: "PATCH", handlerFile: filePath, framework: "rails" });
        out.push({ url: base, method: "PUT", handlerFile: filePath, framework: "rails" });
        out.push({ url: base, method: "DELETE", handlerFile: filePath, framework: "rails" });
      }
    }
  }

  return out;
}

function stripLineComment(line: string): string {
  // Drop `# ...` from the line unless the `#` is inside a string. Ruby
  // string literals here are short and balanced; a minimal one-pass
  // string-aware scan suffices.
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString !== null) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function normalizePath(p: string): string {
  if (p === "") return "";
  return p.startsWith("/") ? p : `/${p}`;
}

function composeUrl(prefix: string, path: string): string {
  const p = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
  if (prefix === "") return p;
  const b = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const joined = p === "/" ? b : `${b}${p}`;
  return joined === "" ? "/" : joined;
}
