/**
 * Scanner specification types.
 *
 * Every scanner wrapped by @opencodehub/scanners is described by a static
 * `ScannerSpec` and a runtime `ScannerWrapper`. The spec is pure data
 * (serializable to JSON); the wrapper carries the `run` function that
 * spawns the external binary and emits a SARIF v2.1.0 log.
 *
 * Hard license rule (Apache-2.0 host): every scanner runs as a separate
 * operating-system process. No scanner's source is ever linked into the
 * JS runtime — GPL/BUSL scanners are explicitly excluded from P1 so this
 * package stays Apache-2.0 clean.
 */

import type { SarifLog } from "@opencodehub/sarif";

/** Static metadata for a scanner — pinned versions + install hints. */
export interface ScannerSpec {
  /** Short machine id, e.g. "semgrep". Used in CLI flags and tool.driver.name. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /**
   * Languages the scanner supports. `"all"` means polyglot (semgrep,
   * betterleaks, osv-scanner). A readonly array lists specific
   * `LanguageId`-like strings (used by the project-profile gate).
   */
  readonly languages: readonly string[] | "all";
  /** Infrastructure-as-code types the scanner covers (terraform, dockerfile, k8s). */
  readonly iacTypes: readonly string[];
  /** True if the scanner natively writes SARIF 2.1.0; false requires wrapper conversion. */
  readonly sarifNative: boolean;
  /** Shell command to install the scanner (documentation only; wrappers never run this). */
  readonly installCmd: string;
  /** Pinned stable version for v1.0. */
  readonly version: string;
  /** True if the scanner can run without any network access. */
  readonly offlineCapable: boolean;
  /** Priority tier: 1 = ship-by-default, 2 = opt-in via ProjectProfile. */
  readonly priority: 1 | 2;
  /** Short license marker for the scanner binary (documentation only). */
  readonly license: string;
  /** Beta scanner (pre-1.0, breaking changes expected).flag. */
  readonly beta?: boolean;
  /** Never auto-runs; must be explicitly selected.flag for clamav. */
  readonly optIn?: boolean;
}

/** Arguments passed to every wrapper's `run` function. */
export interface ScannerRunContext {
  /** Absolute path of the project root to scan. */
  readonly projectPath: string;
  /** Hard wall-clock timeout in milliseconds. Wrappers should pass this to `execFile`. */
  readonly timeoutMs: number;
  /**
   * Emit a progress / warning message. Tests and the runner consume these;
   * the wrapper is the only call site for this callback (apart from the
   * runner itself which wraps errors).
   */
  readonly onWarn?: (message: string) => void;
}

/** Result of a single scanner invocation. */
export interface ScannerRunResult {
  readonly spec: ScannerSpec;
  /** SARIF v2.1.0 log produced by the scanner. Empty runs are still valid SARIF. */
  readonly sarif: SarifLog;
  /** Human-readable note when the run was skipped (binary missing, timeout). */
  readonly skipped?: string;
  /** Wall-clock duration in ms. */
  readonly durationMs: number;
}

/** A wrapper that invokes the external scanner and returns a SarifLog. */
export interface ScannerWrapper {
  readonly spec: ScannerSpec;
  run(ctx: ScannerRunContext): Promise<ScannerRunResult>;
}

/**
 * Empty SARIF log attributed to a specific scanner — used when the
 * binary is missing, the invocation times out, or the scanner crashed.
 * Keeping the run present (with zero results) means the merged SARIF
 * correctly records which scanners ran, even when they found nothing.
 */
export function emptySarifFor(spec: ScannerSpec): SarifLog {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: spec.id,
            version: spec.version,
          },
        },
        results: [],
      },
    ],
  };
}
