/**
 * `@opencodehub/frameworks` — 5-stage framework detection over a curated
 * 23-entry registry.
 *
 * Stages (each emits `{name, version?, confidence, evidence[]}`):
 *   1. Manifest presence (`package.json`, `pyproject.toml`, `pom.xml`, …)
 *   2. Lockfile + exact versions (`package-lock.json`, `pnpm-lock.yaml`,
 *      `Gemfile.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`)
 *   3. Config AST (`next.config.*`, `astro.config.*`, `vite.config.*`,
 *      `spring.factories`)
 *   4. Folder convention (`app/`, `pages/`, `src/main/java/`, …)
 *   5. Import / SCIP usage patterns (consumes the graph's `IMPORTS` edges)
 *
 * All stages are pure-local file-system + string/regex inspection; no
 * network, no LLM, no subprocess.
 *
 * This file is the scaffold entry point — concrete exports land in later
 * commits of T-M4-7 as files are moved from `packages/ingestion`.
 */

// Scaffold — concrete exports added in subsequent commits (see T-M4-7).
export {};
