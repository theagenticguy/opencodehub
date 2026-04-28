#!/usr/bin/env node
/**
 * Copy `plugins/opencodehub/{skills,agents,commands,hooks,hooks.json}` into
 * `dist/plugin-assets/` after `tsc -b`, so globally-installed codehub CLIs
 * (which no longer have the monorepo `plugins/` tree on disk) can still
 * bootstrap a project-scope `.claude/` install via `codehub init`.
 *
 * Mirrors `copy-ci-templates.mjs`. Variables are tokens the CLI substitutes
 * at runtime; this script just does a recursive copy.
 *
 * Excludes:
 *   - `.claude-plugin/` (plugin.json is user-scope only; project-scope doesn't
 *     need a manifest because Claude Code auto-discovers `.claude/` content).
 *   - `README.md` (not a Claude-Code asset).
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");
const src = join(repoRoot, "plugins", "opencodehub");
const dest = join(pkgRoot, "dist", "plugin-assets");

const COPY_ENTRIES = [
  "skills",
  "agents",
  "commands",
  "hooks",
  "hooks.json",
];

await mkdir(dest, { recursive: true });
for (const entry of COPY_ENTRIES) {
  const from = join(src, entry);
  const to = join(dest, entry);
  await cp(from, to, { recursive: true, errorOnExist: false, force: true });
}
