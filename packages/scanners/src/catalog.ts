/**
 * Scanner catalog — the set of scanners @opencodehub/scanners knows about.
 *
 * License posture: every scanner is invoked as an external subprocess.
 * hadolint (GPL-3.0) and tflint (MPL-2.0 + BUSL-1.1) are license-incompatible
 * and CANNOT be linked or vendored — their wrappers spawn the OS binary and
 * return empty SARIF if the binary is missing.
 */

import type { ScannerSpec } from "./spec.js";

export const SEMGREP_SPEC: ScannerSpec = {
  id: "semgrep",
  name: "Semgrep",
  languages: "all",
  iacTypes: [],
  sarifNative: true,
  installCmd: "pip install semgrep==1.160.0",
  version: "1.160.0",
  offlineCapable: true,
  priority: 1,
  license: "LGPL-2.1 (CLI) / MIT (rules) — invoked as external binary",
};

export const BETTERLEAKS_SPEC: ScannerSpec = {
  id: "betterleaks",
  name: "Betterleaks",
  languages: "all",
  iacTypes: [],
  sarifNative: true,
  installCmd: "brew install betterleaks || download from github.com/betterleaks/betterleaks",
  version: "1.1.2",
  offlineCapable: true,
  priority: 1,
  license: "MIT",
};

export const OSV_SCANNER_SPEC: ScannerSpec = {
  id: "osv-scanner",
  name: "OSV-Scanner",
  languages: "all",
  iacTypes: [],
  sarifNative: true,
  installCmd: "go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.3.5",
  version: "2.3.5",
  offlineCapable: true,
  priority: 1,
  license: "Apache-2.0",
};

export const BANDIT_SPEC: ScannerSpec = {
  id: "bandit",
  name: "Bandit",
  languages: ["python"],
  iacTypes: [],
  sarifNative: true,
  installCmd: "pip install 'bandit[sarif]==1.9.4'",
  version: "1.9.4",
  offlineCapable: true,
  priority: 1,
  license: "Apache-2.0",
};

export const BIOME_SPEC: ScannerSpec = {
  id: "biome",
  name: "Biome",
  languages: ["typescript", "javascript", "tsx", "jsx"],
  iacTypes: [],
  sarifNative: true,
  installCmd: "pnpm add -D @biomejs/biome@2.4.0",
  version: "2.4.0",
  offlineCapable: true,
  priority: 1,
  license: "MIT",
};

// W2-I8: belt-and-suspenders Python / JS dependency auditors. Both are P1
// but language-gated. osv-scanner catches the multi-ecosystem baseline;
// these two fill the ~5% of ecosystem-specific findings.

export const PIP_AUDIT_SPEC: ScannerSpec = {
  id: "pip-audit",
  name: "pip-audit",
  languages: ["python"],
  iacTypes: [],
  sarifNative: false,
  installCmd: "pip install pip-audit==2.10.0",
  version: "2.10.0",
  offlineCapable: false,
  priority: 1,
  license: "Apache-2.0",
};

export const NPM_AUDIT_SPEC: ScannerSpec = {
  id: "npm-audit",
  name: "npm audit",
  languages: ["typescript", "javascript", "tsx", "jsx"],
  iacTypes: [],
  sarifNative: false,
  installCmd: "npm (ships with Node.js)",
  version: "npm-cli",
  offlineCapable: false,
  priority: 1,
  license: "Artistic-2.0 (npm CLI) — invoked as external binary",
};

// W2-I4: Priority-2 scanners. These ship alongside P1 but are opt-in via
// ProjectProfile gating (IaC types / container / API contracts). Users
// can also force any subset via `codehub scan --with trivy,checkov`.

export const TRIVY_SPEC: ScannerSpec = {
  id: "trivy",
  name: "Trivy",
  languages: "all",
  iacTypes: ["terraform", "cloudformation", "kubernetes", "docker", "docker-compose"],
  sarifNative: true,
  installCmd: "brew install aquasecurity/trivy/trivy",
  version: "0.67.2",
  offlineCapable: true,
  priority: 2,
  license: "Apache-2.0",
};

export const CHECKOV_SPEC: ScannerSpec = {
  id: "checkov",
  name: "Checkov",
  languages: [],
  iacTypes: ["terraform", "cloudformation", "kubernetes", "docker"],
  sarifNative: true,
  installCmd: "pip install checkov==3.2.500",
  version: "3.2.500",
  offlineCapable: true,
  priority: 2,
  license: "Apache-2.0",
};

/**
 * hadolint — Dockerfile lint. License-incompatible (GPL-3.0).
 *
 * The wrapper MUST only invoke the external `hadolint` binary; it never
 * imports or vendors hadolint source. If the binary is missing, the
 * wrapper emits an empty SARIF and a warning (never crashes).
 */
export const HADOLINT_SPEC: ScannerSpec = {
  id: "hadolint",
  name: "hadolint",
  languages: [],
  iacTypes: ["docker"],
  sarifNative: true,
  installCmd: "brew install hadolint || docker pull hadolint/hadolint",
  version: "2.14.0",
  offlineCapable: true,
  priority: 2,
  license: "GPL-3.0 — external binary only; never linked",
};

/**
 * tflint — Terraform lint. License-incompatible (MPL-2.0 + BUSL-1.1).
 *
 * External binary only; never linked or vendored. Missing binary → empty
 * SARIF + warning.
 */
export const TFLINT_SPEC: ScannerSpec = {
  id: "tflint",
  name: "tflint",
  languages: [],
  iacTypes: ["terraform"],
  sarifNative: true,
  installCmd: "brew install tflint",
  version: "0.61.0",
  offlineCapable: true,
  priority: 2,
  license: "MPL-2.0 + BUSL-1.1 — external binary only; never linked",
};

export const SPECTRAL_SPEC: ScannerSpec = {
  id: "spectral",
  name: "Spectral",
  languages: [],
  iacTypes: [],
  sarifNative: true,
  installCmd: "pnpm add -D @stoplight/spectral-cli@6.15.1",
  version: "6.15.1",
  offlineCapable: true,
  priority: 2,
  license: "Apache-2.0",
};

// Stream U — scanner catalog expansion (2026-04-20).

export const RUFF_SPEC: ScannerSpec = {
  id: "ruff",
  name: "Ruff",
  languages: ["python"],
  iacTypes: [],
  sarifNative: true,
  installCmd: "uv tool install ruff==0.15.11",
  version: "0.15.11",
  offlineCapable: true,
  priority: 1,
  license: "MIT",
};

export const GRYPE_SPEC: ScannerSpec = {
  id: "grype",
  name: "Grype",
  languages: "all",
  iacTypes: [],
  sarifNative: true,
  installCmd: "brew install anchore/grype/grype",
  version: "0.111.0",
  offlineCapable: false,
  priority: 1,
  license: "Apache-2.0",
};

export const CHECKOV_DOCKER_COMPOSE_SPEC: ScannerSpec = {
  id: "checkov-docker-compose",
  name: "Checkov (docker-compose)",
  languages: [],
  iacTypes: ["docker-compose"],
  sarifNative: true,
  installCmd: "pip install checkov==3.2.524",
  version: "3.2.524",
  offlineCapable: true,
  priority: 1,
  license: "Apache-2.0",
};

export const VULTURE_SPEC: ScannerSpec = {
  id: "vulture",
  name: "Vulture",
  languages: ["python"],
  iacTypes: [],
  sarifNative: false,
  installCmd: "pip install vulture==2.16",
  version: "2.16",
  offlineCapable: true,
  priority: 1,
  license: "MIT",
};

export const RADON_SPEC: ScannerSpec = {
  id: "radon",
  name: "Radon",
  languages: ["python"],
  iacTypes: [],
  sarifNative: false,
  installCmd: "pip install radon==6.0.1",
  version: "6.0.1",
  offlineCapable: true,
  priority: 2,
  license: "MIT",
};

export const TY_SPEC: ScannerSpec = {
  id: "ty",
  name: "ty",
  languages: ["python"],
  iacTypes: [],
  sarifNative: false,
  installCmd: "uv tool install ty==0.0.32",
  version: "0.0.32",
  offlineCapable: true,
  priority: 2,
  license: "MIT",
  beta: true,
};

export const CLAMAV_SPEC: ScannerSpec = {
  id: "clamav",
  name: "ClamAV",
  languages: "all",
  iacTypes: [],
  sarifNative: false,
  installCmd: "brew install clamav",
  version: "1.x",
  offlineCapable: true,
  priority: 2,
  license: "GPL-2.0-only — external binary only; never linked",
  optIn: true,
};

/** All Priority-1 scanners, in a stable order used by the CLI default. */
export const P1_SPECS: readonly ScannerSpec[] = [
  SEMGREP_SPEC,
  BETTERLEAKS_SPEC,
  OSV_SCANNER_SPEC,
  BANDIT_SPEC,
  BIOME_SPEC,
  PIP_AUDIT_SPEC,
  NPM_AUDIT_SPEC,
  RUFF_SPEC,
  GRYPE_SPEC,
  CHECKOV_DOCKER_COMPOSE_SPEC,
  VULTURE_SPEC,
];

/** All Priority-2 scanners, in a stable order (used by the profile gate). */
export const P2_SPECS: readonly ScannerSpec[] = [
  TRIVY_SPEC,
  CHECKOV_SPEC,
  HADOLINT_SPEC,
  TFLINT_SPEC,
  SPECTRAL_SPEC,
  RADON_SPEC,
  TY_SPEC,
  CLAMAV_SPEC,
];

/** Every scanner the catalog knows about (P1 + P2). */
export const ALL_SPECS: readonly ScannerSpec[] = [...P1_SPECS, ...P2_SPECS];

/** Look up a spec by id across P1 + P2. Returns `undefined` for unknown ids. */
export function findSpec(id: string): ScannerSpec | undefined {
  return ALL_SPECS.find((s) => s.id === id);
}

/**
 * Filter the catalog by a `ProjectProfile.languages` array. Polyglot
 * scanners (languages:"all") are always included. Language-specific
 * scanners (bandit, biome) require an overlap with `projectLanguages`.
 * Scanners with `languages: []` are excluded — they are never gated by
 * language (they are gated by IaC types / api contracts).
 *
 * `projectLanguages` is typically sourced from the ProjectProfile node
 * written by the profile ingestion phase. An empty / undefined value
 * returns only the polyglot scanners.
 */
export function filterSpecsByLanguages(
  catalog: readonly ScannerSpec[],
  projectLanguages: readonly string[] | undefined,
): readonly ScannerSpec[] {
  const langs = new Set((projectLanguages ?? []).map((l) => l.toLowerCase()));
  return catalog.filter((spec) => {
    if (spec.optIn === true) return false;
    if (spec.languages === "all") return true;
    if (spec.languages.length === 0) return false;
    for (const l of spec.languages) {
      if (langs.has(l.toLowerCase())) return true;
    }
    return false;
  });
}

/**
 * Shape of a ProjectProfile row, restricted to the fields used by the
 * catalog gate. Passing `undefined` for any field is treated as "no
 * information" — a P2 scanner whose gate depends on that field is dropped.
 */
export interface ProjectProfileGate {
  readonly languages?: readonly string[];
  readonly iacTypes?: readonly string[];
  readonly apiContracts?: readonly string[];
}

/**
 * Filter a scanner catalog by a ProjectProfile, applied per-priority:
 *
 *   - P1 language-gated scanners: include if ProjectProfile.languages
 *     overlaps with spec.languages (polyglot `languages: "all"` always in).
 *   - P2 scanners: include only if the applicable ProjectProfile field
 *     justifies running. The mapping is:
 *
 *       trivy     → iacTypes contains any of docker, terraform,
 *                   cloudformation, kubernetes, docker-compose
 *       checkov   → iacTypes contains any of terraform, cloudformation,
 *                   kubernetes, docker
 *       hadolint  → iacTypes contains "docker"
 *       tflint    → iacTypes contains "terraform"
 *       spectral  → apiContracts contains "openapi"
 *
 * Unknown scanners (outside P1 + P2) are passed through unchanged.
 */
export function filterSpecsByProfile(
  catalog: readonly ScannerSpec[],
  profile: ProjectProfileGate,
): readonly ScannerSpec[] {
  const langs = new Set((profile.languages ?? []).map((l) => l.toLowerCase()));
  const iac = new Set((profile.iacTypes ?? []).map((l) => l.toLowerCase()));
  const apis = new Set((profile.apiContracts ?? []).map((l) => l.toLowerCase()));
  return catalog.filter((spec) => {
    if (spec.optIn === true) return false;
    if (spec.priority === 2) {
      return profileAllowsP2(spec.id, iac, apis, langs);
    }
    // Priority 1: language gate, plus IaC gate for iac-typed P1 scanners.
    if (spec.id === CHECKOV_DOCKER_COMPOSE_SPEC.id) return iac.has("docker-compose");
    if (spec.languages === "all") return true;
    if (spec.languages.length === 0) return false;
    for (const l of spec.languages) {
      if (langs.has(l.toLowerCase())) return true;
    }
    return false;
  });
}

function profileAllowsP2(
  id: string,
  iac: ReadonlySet<string>,
  apis: ReadonlySet<string>,
  langs: ReadonlySet<string>,
): boolean {
  switch (id) {
    case TRIVY_SPEC.id:
      return (
        iac.has("docker") ||
        iac.has("terraform") ||
        iac.has("cloudformation") ||
        iac.has("kubernetes") ||
        iac.has("docker-compose")
      );
    case CHECKOV_SPEC.id:
      return (
        iac.has("terraform") ||
        iac.has("cloudformation") ||
        iac.has("kubernetes") ||
        iac.has("docker")
      );
    case HADOLINT_SPEC.id:
      return iac.has("docker");
    case TFLINT_SPEC.id:
      return iac.has("terraform");
    case SPECTRAL_SPEC.id:
      return apis.has("openapi");
    case RADON_SPEC.id:
    case TY_SPEC.id:
      return langs.has("python");
    default:
      return false;
  }
}
