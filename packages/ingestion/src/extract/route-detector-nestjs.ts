/**
 * NestJS route detector.
 *
 * NestJS routes are two-layer decorators:
 *
 *   @Controller("/users")                // class prefix
 *   class UserController {
 *     @Get()                             // -> GET  /users
 *     @Get(":id")                        // -> GET  /users/:id
 *     @Post()                            // -> POST /users
 *     @Put(":id") @Delete(":id") ...
 *   }
 *
 * Every method decorator (`@Get / @Post / @Put / @Delete / @Patch /
 * @Options / @Head / @All`) attaches to the nearest enclosing
 * `@Controller`. The detector prepends the controller prefix to the
 * method path.
 *
 * Profile-gated on `"nestjs"` being in the detected frameworks list
 * (which itself checks `@nestjs/core` / `@nestjs/common` in
 * package.json).
 */

import type { ExtractedRoute, ExtractInput } from "./types.js";

/** Method decorators and their canonical HTTP verb. */
const METHOD_ANNOTATIONS: ReadonlyMap<string, string> = new Map([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Delete", "DELETE"],
  ["Patch", "PATCH"],
  ["Options", "OPTIONS"],
  ["Head", "HEAD"],
  ["All", "ANY"],
]);

const METHOD_DECORATOR_RE =
  /@\s*(Get|Post|Put|Delete|Patch|Options|Head|All)\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)?\s*\)/g;

const CONTROLLER_RE =
  /@\s*Controller\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)?\s*\)/g;

const CLASS_DECL_RE = /\bclass\s+([A-Za-z_$][\w$]*)/g;

interface ControllerRange {
  readonly startIdx: number;
  readonly endIdx: number;
  readonly prefix: string;
}

/**
 * Detect NestJS routes in a TS / JS source file. Returns one
 * {@link ExtractedRoute} per method-decorator hit, with the class-level
 * `@Controller` prefix applied.
 */
export function detectNestJsRoutes(input: ExtractInput): readonly ExtractedRoute[] {
  const { filePath, content } = input;
  const out: ExtractedRoute[] = [];

  const controllers = collectControllerRanges(content);

  METHOD_DECORATOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null = METHOD_DECORATOR_RE.exec(content);
  while (m !== null) {
    const verb = METHOD_ANNOTATIONS.get(m[1] as string);
    const path = m[2] ?? m[3] ?? m[4] ?? "";
    const atIdx = m.index;
    m = METHOD_DECORATOR_RE.exec(content);
    if (verb === undefined) continue;
    const controller = findEnclosingController(atIdx, controllers);
    const prefix = controller?.prefix ?? "";
    const url = composeUrl(prefix, path);
    if (verb === "ANY") {
      // `@All()` — no HTTP method filter, matches any verb.
      out.push({
        url,
        handlerFile: filePath,
        framework: "nestjs",
      });
    } else {
      out.push({
        url,
        method: verb,
        handlerFile: filePath,
        framework: "nestjs",
      });
    }
  }

  return out;
}

/**
 * Walk every `class Foo` in the file; associate each class range with
 * the `@Controller(...)` annotation immediately above it (searched in a
 * small backwards window so unrelated earlier decorators don't leak in).
 */
function collectControllerRanges(content: string): readonly ControllerRange[] {
  const classStarts: number[] = [];
  CLASS_DECL_RE.lastIndex = 0;
  let c: RegExpExecArray | null = CLASS_DECL_RE.exec(content);
  while (c !== null) {
    classStarts.push(c.index);
    c = CLASS_DECL_RE.exec(content);
  }

  const out: ControllerRange[] = [];
  for (let i = 0; i < classStarts.length; i++) {
    const start = classStarts[i];
    if (start === undefined) continue;
    const end = i + 1 < classStarts.length ? (classStarts[i + 1] ?? content.length) : content.length;
    const prefix = readControllerPrefixAbove(content, start);
    out.push({ startIdx: start, endIdx: end, prefix });
  }
  return out;
}

function readControllerPrefixAbove(content: string, classStart: number): string {
  const from = Math.max(0, classStart - 400);
  const window = content.slice(from, classStart);
  CONTROLLER_RE.lastIndex = 0;
  let best = "";
  let m: RegExpExecArray | null = CONTROLLER_RE.exec(window);
  while (m !== null) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    best = normalizePrefix(raw);
    m = CONTROLLER_RE.exec(window);
  }
  return best;
}

function findEnclosingController(
  idx: number,
  ranges: readonly ControllerRange[],
): ControllerRange | undefined {
  for (const r of ranges) {
    if (idx >= r.startIdx && idx < r.endIdx) return r;
  }
  return undefined;
}

function normalizePrefix(p: string): string {
  if (p === "") return "";
  return p.startsWith("/") ? p : `/${p}`;
}

function composeUrl(prefix: string, path: string): string {
  const p = path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
  if (prefix === "") return p === "" ? "/" : p;
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const joined = `${base}${p}`;
  return joined === "" ? "/" : joined;
}
