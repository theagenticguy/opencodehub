# @opencodehub/frameworks

5-stage framework detection for OpenCodeHub. Identifies the languages,
runtimes, and frameworks present in a repository without executing any
project code.

## Surface

```ts
import { detectFrameworks } from "@opencodehub/frameworks";

const result = await detectFrameworks("/path/to/repo");
// result.detected: FrameworkHit[]  — name, confidence, evidence stage
```

Detection runs five stages in order, stopping as soon as a stage produces
high-confidence hits:

| Stage | Method |
|---|---|
| 1. Manifest | `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, … |
| 2. Lockfile | `pnpm-lock.yaml`, `poetry.lock`, `Cargo.lock`, … |
| 3. Config AST | `next.config.*`, `vite.config.*`, `astro.config.*`, … |
| 4. Folder | `src/app/`, `pages/`, `components/`, … |
| 5. Import / SCIP | Symbol-level import analysis from the code graph |

## Design

- The curated framework registry lives at
  `packages/frameworks/src/registry/` — add an entry there to support a
  new framework.
- All file reads are bounded; the detector never shells out.
- `zod` validates registry entries at module load time so a malformed
  entry fails fast rather than silently producing wrong results.
