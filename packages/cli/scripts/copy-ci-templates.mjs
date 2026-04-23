#!/usr/bin/env node
/**
 * Copy `src/commands/ci-templates/*.yml` into `dist/commands/ci-templates/`
 * after `tsc -b`, because tsc only emits .ts→.js. The CI-init command reads
 * these templates at runtime via `import.meta.url`-relative paths.
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const src = join(pkgRoot, "src", "commands", "ci-templates");
const dest = join(pkgRoot, "dist", "commands", "ci-templates");

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
