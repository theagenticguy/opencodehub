# @opencodehub/scanners

Subprocess wrappers for the open-source scanners that back
`codehub scan`. Every scanner runs as an external process — nothing is
linked or vendored — and returns SARIF for ingestion into the graph.

## Surface

```ts
import { ALL_SPECS, P1_SPECS, P2_SPECS, filterSpecsByProfile } from "@opencodehub/scanners";

const profile = { languages: ["python"], iacTypes: ["docker"], apiContracts: [] };
const enabled = filterSpecsByProfile(P1_SPECS, profile);
```

- Catalog lookup: `findSpec(id)` returns the `ScannerSpec` for an id
  across P1 + P2 (`packages/scanners/src/catalog.ts:336-338`).
- Profile gating: `filterSpecsByProfile` enforces the per-priority
  rules below (`packages/scanners/src/catalog.ts:396-417`).
- Missing-binary policy: license-incompatible scanners (hadolint,
  tflint) emit empty SARIF and a warning rather than crashing
  (`packages/scanners/src/catalog.ts:155-194`).

## Scanners

20 scanners total — 12 Priority-1 (default) + 8 Priority-2 (profile-gated).
Source of truth: `packages/scanners/src/catalog.ts:12-302`. P1 ordering is
fixed in `P1_SPECS` (lines 305-318); P2 ordering in `P2_SPECS` (lines 321-330).

### Priority-1 (default set)

| Id                       | Languages / scope               | SARIF native | License           |
| ------------------------ | ------------------------------- | ------------ | ----------------- |
| `semgrep`                | all                             | yes          | LGPL-2.1 (binary) |
| `betterleaks`            | all (secrets)                   | yes          | MIT               |
| `osv-scanner`            | all (deps)                      | yes          | Apache-2.0        |
| `bandit`                 | python                          | yes          | Apache-2.0        |
| `biome`                  | typescript / javascript / tsx   | yes          | MIT               |
| `pip-audit`              | python                          | no           | Apache-2.0        |
| `npm-audit`              | typescript / javascript         | no           | Artistic-2.0 bin  |
| `ruff`                   | python                          | yes          | MIT               |
| `grype`                  | all (image / SBOM)              | yes          | Apache-2.0        |
| `checkov-docker-compose` | docker-compose                  | yes          | Apache-2.0        |
| `vulture`                | python (dead code)              | no           | MIT               |

### Priority-2 (profile-gated)

| Id         | Gate                                                        | License                      |
| ---------- | ----------------------------------------------------------- | ---------------------------- |
| `trivy`    | iac contains docker / terraform / cfn / k8s / docker-compose | Apache-2.0                  |
| `checkov`  | iac contains terraform / cfn / k8s / docker                 | Apache-2.0                   |
| `hadolint` | iac contains docker                                         | GPL-3.0 — external bin only  |
| `tflint`   | iac contains terraform                                      | MPL-2.0 + BUSL — external bin |
| `spectral` | apiContracts contains openapi                               | Apache-2.0                   |
| `radon`    | languages contains python                                   | MIT                          |
| `ty`       | languages contains python (beta)                            | MIT                          |
| `clamav`   | opt-in only                                                 | GPL-2.0 — external bin only  |

## Design

- **External processes only** — every wrapper spawns the OS binary; no
  scanner code is linked or vendored. This keeps copyleft (`GPL-3.0` in
  hadolint, `MPL-2.0 + BUSL-1.1` in tflint) at arm's length
  (`packages/scanners/src/catalog.ts:1-8`).
- **Profile-driven gating** — `filterSpecsByProfile` reads
  `ProjectProfile.{languages, iacTypes, apiContracts}` and prunes the
  catalog before launch, so scans don't waste time on irrelevant tools.
- **SHA256-pinned versions** — every spec carries a `version` and an
  `installCmd`; CI installs the exact version listed.
- **`betterleaks` ships a vendored default config** at
  `packages/scanners/config/betterleaks.default.toml`. It extends the
  upstream 276 default rules and layers an `[allowlists]` block that
  drops findings on vendored deps, lockfiles, build outputs, SBOMs,
  generated SARIF, and common test-fixture directories. Users override
  by placing their own `betterleaks.toml` (or `.gitleaks.toml`) at the
  project root. The wrapper auto-detects user configs and only injects
  the vendored one when the project doesn't carry its own.
- **`optIn` and `beta` flags** — `clamav` is opt-in (off by profile);
  `ty` is marked beta. Both are excluded from the default
  `filterSpecsByProfile` output unless asked for explicitly.

See `packages/sarif/README.md` for the SARIF normaliser the wrappers
feed into, and the root README's "Supply-chain posture" section for the
license-tier rationale.
