/**
 * Layout-agnostic runtime asset resolution.
 *
 * The CLI loads several runtime assets by walking out from `import.meta.url`
 * rather than via `import` (so esbuild never sees them): the Claude Code
 * plugin tree, CI templates, the scanner default config, vendored grammar
 * WASMs, and the COBOL JVM bridge. tsup copies each tree into `dist/` in its
 * `onSuccess` hook (see `tsup.config.ts`).
 *
 * The hazard these resolvers must survive is that the *emitted* module layout
 * is not the *source* layout, and the emitted layout is not even stable:
 *
 *   - source checkout:   <pkg>/src/commands/init.ts
 *   - pre-collapse dist:  <pkg>/dist/commands/init.js
 *   - post-collapse dist: <pkg>/dist/init-<hash>.js   (PR #189 tsup bundle)
 *
 * Any resolver that hardcodes a fixed count of `..` segments is calibrated to
 * exactly one of those layouts and silently breaks on the others — which is
 * how the bundle collapse shipped a `codehub init` that resolved its plugin
 * source to `.../_npx/<hash>/plugins/opencodehub` (one level too high) and
 * threw "plugin source not found". The survivors (`doctor.ts` wasm probe,
 * `cobol-proleap-setup.ts`) used a walk-up probe and were immune.
 *
 * This module is the one walk-up probe every asset resolver delegates to. It
 * walks UP from a start directory and, at each level, tests a list of
 * candidate relative subpaths; the first that exists on disk wins. Because it
 * never assumes a depth, it resolves identically from the flat bundle, the
 * nested pre-collapse bundle, the test build (`dist-test/`), and a raw source
 * checkout. Order candidates bundle-first so the shipped path is preferred
 * over a coincidental source-tree match.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Cheap synchronous directory probe used only during path resolution. */
function isDirSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Cheap synchronous regular-file probe used only during path resolution. */
function isFileSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface ResolveAssetOptions {
  /**
   * Directory to start walking up from. Defaults to the directory of the
   * caller-supplied `fromFileUrl` (i.e. the calling module). Callers almost
   * always pass `import.meta.url` via `fromFileUrl`.
   */
  readonly startDir?: string;
  /** A `file://` URL — typically the caller's `import.meta.url`. */
  readonly fromFileUrl?: string;
  /** Max levels to climb before giving up. Defaults to 10. */
  readonly maxLevels?: number;
  /**
   * What kind of filesystem node each candidate must resolve to. `"dir"`
   * (default) for asset directories like `plugin-assets/`; `"file"` for a
   * single config file like `betterleaks.default.toml`.
   */
  readonly kind?: "dir" | "file";
}

/**
 * Walk up from a start directory, probing each candidate relative subpath at
 * every level. Returns the first existing match, or `null` if none of the
 * candidates exists within `maxLevels` of the start.
 *
 * @param candidates Relative subpaths to probe at each level, in priority
 *   order. Each is an array of path segments, e.g. `["plugin-assets"]` or
 *   `["plugins", "opencodehub"]`. Bundle-first ordering preferred.
 */
export function resolveAsset(
  candidates: readonly (readonly string[])[],
  opts: ResolveAssetOptions = {},
): string | null {
  const maxLevels = opts.maxLevels ?? 10;
  const kind = opts.kind ?? "dir";
  const exists = kind === "file" ? isFileSync : isDirSync;

  let dir =
    opts.startDir ?? (opts.fromFileUrl ? dirname(fileURLToPath(opts.fromFileUrl)) : process.cwd());

  for (let level = 0; level <= maxLevels; level += 1) {
    for (const segments of candidates) {
      const candidate = join(dir, ...segments);
      if (exists(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  return null;
}
