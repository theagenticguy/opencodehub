# @opencodehub/frameworks

Framework detection for OpenCodeHub. Identifies the languages, runtimes, and
frameworks present in a repository without executing any project code, network
access, LLM, or subprocess — pure local file-system plus string/regex
inspection.

## Surface

```ts
import {
  detectFrameworks,
  detectFrameworksDetailed,
} from "@opencodehub/frameworks";

// Both take a FrameworkDetectionInput object — never a bare path string.
const input = {
  repoRoot: "/path/to/repo",
  files: scannedFiles, // readonly { relPath: string }[]
  manifests: ["package.json"], // manifest relPaths present in the repo
  detectedLanguages: ["typescript"], // optional — gates ecosystems
};

// Flat list (legacy v1.0 surface): sorted framework names.
const names: readonly string[] = await detectFrameworks(input);

// Structured (preferred): FrameworkDetection[] with variant / version /
// confidence / evidence / parentName.
const detections = await detectFrameworksDetailed(input);
// detections[i]: { name, category, confidence, evidence[], variant?, version?, parentName? }
```

`FrameworkDetection` and `Evidence` are re-exported from
`@opencodehub/core-types`; the catalog-facing types
(`FrameworkRule`, `ManifestKey`, `FrameworkEcosystem`, `FrameworkTier`,
`VariantDefinition`) come from this package.

## Detection stages

The dispatcher (`src/detector.ts`) walks the curated catalog once and merges
evidence from three stages into each `FrameworkDetection`:

| Stage | Method |
|---|---|
| 1. Manifest | `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, … — declared-dependency and manifest-presence fingerprints |
| 2. Lockfile version | `package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, `uv.lock`, `Cargo.lock`, … — pins the exact version, overriding the manifest's semver range |
| 4. Folder / file marker | exact-path file markers (`vite.config.ts`, …) and regex path markers (`src/app/`, `pages/`, …) |

Two further stages ship as standalone, independently tested modules but are
not yet wired into the ingestion profile phase:

- **Stage 3 — config AST** (`src/stages/config-ast.ts`): regex-pragmatic
  inspectors for `next.config.*`, `astro.config.*`, `vite.config.*`, and
  `META-INF/spring.factories`. Wiring it requires the caller to pre-read the
  config-file text and pass it through.
- **Stage 5 — import / SCIP** (`src/stages/imports.ts`): walks the code
  graph's `IMPORTS` edges and maps resolved root modules (`fastapi`,
  `@nestjs/core`, …) to frameworks. Wiring it requires passing the
  `KnowledgeGraph` through.

Wiring these two stages would feed their findings into
`FrameworkDetection.evidence` (the `Evidence.stage` field already reserves
`3` and `5`).

## Design

- The curated framework catalog lives at `src/catalog.ts` — a typed
  `FRAMEWORK_CATALOG` table of `FrameworkRule` entries. Add an entry there
  (and, if variants matter, a resolver in `src/variant-detectors.ts`) to
  support a new framework.
- All file reads are bounded; the detector never shells out.
- Determinism: every entrypoint returns output sorted by name, and structured
  evidence is sorted by `(stage, source, detail)` for byte-stable graphs.
- Unreadable or malformed manifests/lockfiles are skipped, never fatal.
