/**
 * @opencodehub/scanners — Priority-1 + Priority-2 scanner wrappers.
 *
 * Every scanner is invoked as an external OS subprocess; this package
 * contains zero scanner source code. hadolint (GPL-3.0) and tflint
 * (MPL-2.0 + BUSL-1.1) are license-incompatible — their wrappers MUST
 * NOT import or link any scanner source.
 *
 * Public surface:
 *   - Catalog: `P1_SPECS`, `P2_SPECS`, `ALL_SPECS`, `filterSpecsByLanguages`,
 *     `filterSpecsByProfile`, `findSpec`.
 *   - Runner: `runScanners(path, wrappers, opts)` — concurrent runner.
 *   - P1 wrappers: createSemgrepWrapper / createBetterleaksWrapper /
 *     createOsvScannerWrapper / createBanditWrapper / createBiomeWrapper /
 *     createPipAuditWrapper / createNpmAuditWrapper.
 *   - P2 wrappers: createTrivyWrapper / createCheckovWrapper /
 *     createHadolintWrapper / createTflintWrapper / createSpectralWrapper.
 *   - Converters: pipAuditJsonToSarif / npmAuditJsonToSarif.
 *   - `createDefaultWrappers(specs, deps?, ctx?)` — materialize wrappers
 *     from specs for the runner.
 */

export type { ProjectProfileGate } from "./catalog.js";
export {
  ALL_SPECS,
  BANDIT_SPEC,
  BETTERLEAKS_SPEC,
  BIOME_SPEC,
  CHECKOV_SPEC,
  filterSpecsByLanguages,
  filterSpecsByProfile,
  findSpec,
  HADOLINT_SPEC,
  NPM_AUDIT_SPEC,
  OSV_SCANNER_SPEC,
  P1_SPECS,
  P2_SPECS,
  PIP_AUDIT_SPEC,
  SEMGREP_SPEC,
  SPECTRAL_SPEC,
  TFLINT_SPEC,
  TRIVY_SPEC,
} from "./catalog.js";
export type { NpmAuditConvertOptions } from "./converters/npm-audit-to-sarif.js";
export { npmAuditJsonToSarif } from "./converters/npm-audit-to-sarif.js";
export type { PipAuditConvertOptions } from "./converters/pip-audit-to-sarif.js";
export { pipAuditJsonToSarif } from "./converters/pip-audit-to-sarif.js";
export { runBinary, tryParseJson, which } from "./exec.js";
export type {
  RunScannersOptions,
  RunScannersResult,
  ScannerStatus,
} from "./runner.js";
export { runScanners } from "./runner.js";
export type {
  ScannerRunContext,
  ScannerRunResult,
  ScannerSpec,
  ScannerWrapper,
} from "./spec.js";
export { emptySarifFor } from "./spec.js";
export { createBanditWrapper } from "./wrappers/bandit.js";
export { createBetterleaksWrapper } from "./wrappers/betterleaks.js";
export { createBiomeWrapper } from "./wrappers/biome.js";
export type { CheckovWrapperOptions } from "./wrappers/checkov.js";
export { createCheckovWrapper } from "./wrappers/checkov.js";
export type { HadolintWrapperOptions } from "./wrappers/hadolint.js";
export { createHadolintWrapper } from "./wrappers/hadolint.js";
export { createNpmAuditWrapper } from "./wrappers/npm-audit.js";
export { createOsvScannerWrapper } from "./wrappers/osv-scanner.js";
export type { PipAuditWrapperOptions } from "./wrappers/pip-audit.js";
export { createPipAuditWrapper } from "./wrappers/pip-audit.js";
export { createSemgrepWrapper } from "./wrappers/semgrep.js";
export type { WrapperDeps } from "./wrappers/shared.js";
export type { SpectralWrapperOptions } from "./wrappers/spectral.js";
export { createSpectralWrapper } from "./wrappers/spectral.js";
export { createTflintWrapper } from "./wrappers/tflint.js";
export { createTrivyWrapper } from "./wrappers/trivy.js";

import {
  BANDIT_SPEC,
  BETTERLEAKS_SPEC,
  BIOME_SPEC,
  CHECKOV_SPEC,
  HADOLINT_SPEC,
  NPM_AUDIT_SPEC,
  OSV_SCANNER_SPEC,
  PIP_AUDIT_SPEC,
  SEMGREP_SPEC,
  SPECTRAL_SPEC,
  TFLINT_SPEC,
  TRIVY_SPEC,
} from "./catalog.js";
import type { ScannerSpec, ScannerWrapper } from "./spec.js";
import { createBanditWrapper } from "./wrappers/bandit.js";
import { createBetterleaksWrapper } from "./wrappers/betterleaks.js";
import { createBiomeWrapper } from "./wrappers/biome.js";
import { type CheckovWrapperOptions, createCheckovWrapper } from "./wrappers/checkov.js";
import { createHadolintWrapper, type HadolintWrapperOptions } from "./wrappers/hadolint.js";
import { createNpmAuditWrapper } from "./wrappers/npm-audit.js";
import { createOsvScannerWrapper } from "./wrappers/osv-scanner.js";
import { createPipAuditWrapper, type PipAuditWrapperOptions } from "./wrappers/pip-audit.js";
import { createSemgrepWrapper } from "./wrappers/semgrep.js";
import { DEFAULT_DEPS, type WrapperDeps } from "./wrappers/shared.js";
import { createSpectralWrapper, type SpectralWrapperOptions } from "./wrappers/spectral.js";
import { createTflintWrapper } from "./wrappers/tflint.js";
import { createTrivyWrapper } from "./wrappers/trivy.js";

/**
 * Per-scanner context passed to `createDefaultWrappers`. Some wrappers
 * (checkov, hadolint, spectral, pip-audit) need extra per-run metadata
 * that the runner alone cannot provide:
 *   - checkov: which `--framework` values to enable (from iacTypes).
 *   - hadolint: the explicit Dockerfile paths (hadolint does NOT recurse).
 *   - spectral: the explicit OpenAPI / AsyncAPI file paths.
 *   - pip-audit: which requirements file to audit.
 *
 * Passing the context at wrapper-creation time keeps the `runScanners`
 * loop oblivious to scanner-specific quirks.
 */
export interface DefaultWrapperContext {
  readonly checkov?: CheckovWrapperOptions;
  readonly hadolint?: HadolintWrapperOptions;
  readonly spectral?: SpectralWrapperOptions;
  readonly pipAudit?: PipAuditWrapperOptions;
}

/**
 * Build the default wrapper list for a given set of specs. Unknown specs
 * are silently dropped — callers should only pass specs sourced from
 * `ALL_SPECS` / `filterSpecsByLanguages` / `filterSpecsByProfile`.
 *
 * @param specs - Scanner specs the caller wants to run.
 * @param deps  - Optional wrapper dependency override (used by tests).
 * @param ctx   - Optional per-scanner context (file lists, frameworks).
 */
export function createDefaultWrappers(
  specs: readonly ScannerSpec[],
  deps?: WrapperDeps,
  ctx: DefaultWrapperContext = {},
): readonly ScannerWrapper[] {
  const out: ScannerWrapper[] = [];
  for (const spec of specs) {
    const w = createWrapperFor(spec, deps, ctx);
    if (w) out.push(w);
  }
  return out;
}

function createWrapperFor(
  spec: ScannerSpec,
  deps: WrapperDeps | undefined,
  ctx: DefaultWrapperContext,
): ScannerWrapper | undefined {
  switch (spec.id) {
    case SEMGREP_SPEC.id:
      return deps ? createSemgrepWrapper(deps) : createSemgrepWrapper();
    case BETTERLEAKS_SPEC.id:
      return deps ? createBetterleaksWrapper(deps) : createBetterleaksWrapper();
    case OSV_SCANNER_SPEC.id:
      return deps ? createOsvScannerWrapper(deps) : createOsvScannerWrapper();
    case BANDIT_SPEC.id:
      return deps ? createBanditWrapper(deps) : createBanditWrapper();
    case BIOME_SPEC.id:
      return deps ? createBiomeWrapper(deps) : createBiomeWrapper();
    case PIP_AUDIT_SPEC.id:
      return createPipAuditWrapper(deps ?? DEFAULT_DEPS, ctx.pipAudit ?? {});
    case NPM_AUDIT_SPEC.id:
      return deps ? createNpmAuditWrapper(deps) : createNpmAuditWrapper();
    case TRIVY_SPEC.id:
      return deps ? createTrivyWrapper(deps) : createTrivyWrapper();
    case CHECKOV_SPEC.id:
      return createCheckovWrapper(deps ?? DEFAULT_DEPS, ctx.checkov ?? {});
    case HADOLINT_SPEC.id:
      return createHadolintWrapper(deps ?? DEFAULT_DEPS, ctx.hadolint ?? {});
    case TFLINT_SPEC.id:
      return deps ? createTflintWrapper(deps) : createTflintWrapper();
    case SPECTRAL_SPEC.id:
      return createSpectralWrapper(deps ?? DEFAULT_DEPS, ctx.spectral ?? {});
    default:
      return undefined;
  }
}
