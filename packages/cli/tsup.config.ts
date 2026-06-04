import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

/**
 * Single-tarball build for `@opencodehub/cli`.
 *
 * The 14 internal `@opencodehub/*` workspace libraries are force-bundled into
 * this one package (`noExternal`), so the CLI is the only published runtime
 * package. Native bindings, the worker host, and lazily-imported packages stay
 * `external` — they resolve from the CLI's own `node_modules` at runtime.
 *
 * Two non-obvious constraints drive the shape of this config:
 *
 *  1. **Workers must be sibling chunks.** esbuild does NOT rewrite
 *     `new Worker(new URL("./x.js", import.meta.url))` or piscina `filename`
 *     strings — it leaves them verbatim, so they resolve at runtime against the
 *     *emitted* file. The two piscina pools in `@opencodehub/ingestion`
 *     (`parse/worker-pool.ts` and `pipeline/phases/embedder-pool.ts`) point at
 *     `./parse-worker.js` / `./embedder-worker.js` next to themselves. We
 *     declare each worker as its own named `entry` so tsup emits
 *     `dist/parse-worker.js` and `dist/embedder-worker.js` as siblings of the
 *     bundled pool code. `splitting: true` (the ESM default) hoists the shared
 *     graph into `dist/chunk-*.js` instead of duplicating it into each worker.
 *
 *  2. **Runtime assets are resolved by walking up from `import.meta.url`.**
 *     The grammar WASMs, plugin assets, CI templates, scanner config, and the
 *     COBOL JVM bridge are loaded at runtime via `import.meta.url`-relative
 *     walk-up resolvers (see `assets.ts`), not via `import`, so esbuild's asset
 *     loaders never see them. We copy each tree into `dist/` in `onSuccess`;
 *     the walk-up resolvers find `dist/<asset>` whether the code runs from the
 *     bundle (here = `dist/`) or from a source checkout.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const distDir = join(here, "dist");

/**
 * Externalize EVERY third-party package — we bundle only our own
 * `@opencodehub/*` source (`noExternal` below). Third-party deps stay in the
 * CLI's `node_modules` and resolve at runtime. This is the idiomatic
 * monorepo-collapse shape and, crucially, it avoids dragging esbuild into
 * fragile transitive CJS graphs (e.g. `@cyclonedx/cyclonedx-library`'s
 * optional-plugin `require("xmlbuilder2")` / `require("libxmljs2")` shims,
 * which are runtime-optional and must not be statically resolved). The
 * `external: [/^[^.]/]` regex matches any import specifier that does not start
 * with `.` (i.e. every bare package import); relative imports inside our
 * bundled source are still followed. `noExternal` takes precedence for the
 * `@opencodehub/*` scope, so our workspace libs are still inlined.
 *
 * This implicitly covers the native bindings (`@ladybugdb/core`,
 * `@duckdb/node-api`, `onnxruntime-node`, `web-tree-sitter`), the worker host
 * (`piscina`), the CJS MCP SDK, and the lazily-imported packages
 * (`@chonkiejs/core`, `@apidevtools/swagger-parser`,
 * `@aws-sdk/client-sagemaker-runtime`, `ts-morph`).
 */
const EXTERNAL = [/^[^.]/];

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true, errorOnExist: false });
}

export default defineConfig({
  entry: {
    // The bin — carries the `#!/usr/bin/env node` shebang from src/index.ts.
    index: "src/index.ts",
    // piscina worker targets — emitted as dist/<name>.js siblings of the bundle.
    "parse-worker": "../ingestion/src/parse/parse-worker.ts",
    "embedder-worker": "../ingestion/src/pipeline/phases/embedder-worker.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  splitting: true,
  // No `shims`: our source is native ESM and uses `import.meta.url` directly,
  // so tsup's injected esm_shims.js is unnecessary — and its absolute injected
  // path collides with the `external: [/^[^.]/]` bare-import rule.
  clean: true,
  dts: false, // a bin needs no published type surface
  // Force-bundle every internal workspace package into this one tarball.
  noExternal: [/^@opencodehub\//],
  external: EXTERNAL,
  async onSuccess() {
    // Grammar WASMs (16 blobs, ~25 MB) — resolved by walk-up to `vendor/wasms`.
    await copyTree(
      join(repoRoot, "packages", "ingestion", "vendor", "wasms"),
      join(distDir, "vendor", "wasms"),
    );
    // Claude Code plugin assets — consumed by `codehub init`.
    await copyTree(
      join(repoRoot, "plugins", "opencodehub", "skills"),
      join(distDir, "plugin-assets", "skills"),
    );
    await copyTree(
      join(repoRoot, "plugins", "opencodehub", "agents"),
      join(distDir, "plugin-assets", "agents"),
    );
    await copyTree(
      join(repoRoot, "plugins", "opencodehub", "hooks"),
      join(distDir, "plugin-assets", "hooks"),
    );
    await copyTree(
      join(repoRoot, "plugins", "opencodehub", "hooks.json"),
      join(distDir, "plugin-assets", "hooks.json"),
    );
    // CI-init templates — read at runtime by `codehub ci-init`.
    await copyTree(
      join(here, "src", "commands", "ci-templates"),
      join(distDir, "commands", "ci-templates"),
    );
    // Scanner default config (betterleaks) — resolved by walk-up to `config/`.
    await copyTree(
      join(repoRoot, "packages", "scanners", "config"),
      join(distDir, "config"),
    );
    // COBOL ProLeap JVM bridge source — resolved by walk-up to `java/`.
    await copyTree(
      join(repoRoot, "packages", "cobol-proleap", "java"),
      join(distDir, "java"),
    );
  },
});
