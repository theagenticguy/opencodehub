/**
 * `codehub verdict` — 5-tier PR verdict CLI.
 */

import { join } from "node:path";
import {
  computeVerdict,
  type VerdictConfig,
  type VerdictQuery,
  type VerdictResponse,
  type VerdictTier,
} from "@opencodehub/analysis";
import {
  evaluatePolicy,
  loadPolicy,
  type Policy,
  type PolicyContext,
  type PolicyDecision,
  PolicyValidationError,
} from "@opencodehub/policy";
import type { IGraphStore } from "@opencodehub/storage";
import { openStoreForCommand } from "./open-store.js";
import { cliExitCodeForTier, renderJson, renderMarkdown, renderSummary } from "./verdict-render.js";

export type VerdictOutputFormat = "markdown" | "json" | "summary";

/**
 * Policy tier mapping: VerdictTier -> numeric blast-radius tier used by
 * policy.blast_radius_max rules. `max_tier: 2` therefore means "block
 * any diff whose verdict is dual_review or higher".
 *
 * Kept inline + exported so tests and downstream callers can assert on it.
 */
export const POLICY_TIER_FOR_VERDICT: Record<VerdictTier, number> = Object.freeze({
  auto_merge: 1,
  single_review: 2,
  dual_review: 3,
  expert_review: 4,
  block: 5,
});

export interface VerdictCliOptions {
  readonly base?: string;
  readonly head?: string;
  readonly repo?: string;
  readonly home?: string;
  readonly outputFormat?: VerdictOutputFormat;
  readonly prComment?: boolean;
  readonly exitCode?: boolean;
  readonly json?: boolean;
  readonly configOverrides?: Partial<VerdictConfig>;
  readonly storeFactory?: () => Promise<{ store: IGraphStore; repoPath: string }>;
  readonly computeVerdictFn?: (store: IGraphStore, query: VerdictQuery) => Promise<VerdictResponse>;
  /**
   * Test hook: override the policy loader. Defaults to loadPolicy against
   * `<repoPath>/opencodehub.policy.yaml`.
   */
  readonly loadPolicyFn?: (filePath: string) => Promise<Policy | undefined>;
  /**
   * Test hook: override the approvals list (e.g. coming from the PR's
   * review state). v1 does not fetch approvals from anywhere — CI callers
   * that want ownership_required rules to pass must inject them.
   */
  readonly approvals?: readonly string[];
}

export interface ResolvedVerdictMode {
  readonly format: VerdictOutputFormat;
  readonly exitCode: boolean;
}

/**
 * Resolve raw CLI flags to effective mode. `--pr-comment` implies markdown +
 * exit-code. `--json` is a backward-compat alias for `--output-format json`.
 */
export function resolveVerdictMode(opts: VerdictCliOptions): ResolvedVerdictMode {
  if (opts.prComment === true) {
    return { format: "markdown", exitCode: true };
  }
  const explicit = opts.outputFormat;
  const format: VerdictOutputFormat = explicit ?? (opts.json === true ? "json" : "summary");
  // Default exit-code policy: on for summary (interactive + CI ergonomic),
  // off for json and explicit markdown (backward compat for scripts that
  // parse the output and manage their own exit).
  const defaultExit = format === "summary";
  const exitCode = opts.exitCode === true ? true : opts.exitCode === false ? false : defaultExit;
  return { format, exitCode };
}

export async function runVerdict(opts: VerdictCliOptions = {}): Promise<void> {
  const mode = resolveVerdictMode(opts);
  const factory = opts.storeFactory ?? (() => openStoreForCommand(opts));
  const { store, repoPath } = await factory();
  const compute = opts.computeVerdictFn ?? computeVerdict;
  try {
    const query: VerdictQuery = {
      repoPath,
      ...(opts.base !== undefined ? { base: opts.base } : {}),
      ...(opts.head !== undefined ? { head: opts.head } : {}),
      ...(opts.configOverrides !== undefined ? { config: opts.configOverrides } : {}),
    };
    const verdict = await compute(store, query);

    // Fold opencodehub.policy.yaml into the decision. `loadPolicy` returns
    // undefined for the starter (all-comment) state so the default repo
    // gets unchanged behavior. A malformed policy file throws — we let the
    // error propagate so the CLI exits non-zero rather than silently pass.
    const load = opts.loadPolicyFn ?? loadPolicy;
    const policyPath = join(repoPath, "opencodehub.policy.yaml");
    const policy = await load(policyPath);
    const policyDecision =
      policy !== undefined
        ? evaluatePolicy(policy, buildPolicyContext(verdict, opts.approvals ?? []))
        : undefined;

    const baseOutput =
      mode.format === "json"
        ? renderJson(verdict)
        : mode.format === "markdown"
          ? renderMarkdown(verdict)
          : renderSummary(verdict);
    const output =
      mode.format === "json"
        ? renderJsonWithPolicy(baseOutput, policyDecision)
        : policyDecision !== undefined
          ? `${baseOutput}\n${renderPolicyBlock(policyDecision, mode.format)}`
          : baseOutput;
    process.stdout.write(`${output}\n`);
    if (mode.exitCode) {
      const tierExit = cliExitCodeForTier(verdict.verdict);
      // Policy block is strictly at least as severe as the verdict's own
      // exit code: max(tierExit, 3 when policyDecision.status === "block").
      const policyExit: 0 | 3 = policyDecision?.status === "block" ? 3 : 0;
      process.exitCode = Math.max(tierExit, policyExit) as 0 | 1 | 2 | 3;
    }
  } finally {
    await store.close();
  }
}

function buildPolicyContext(verdict: VerdictResponse, approvals: readonly string[]): PolicyContext {
  return {
    // v1 wiring: verdict does not yet compute a license audit, so we
    // surface an empty set. license_allowlist rules therefore pass until a
    // follow-up task wires SBOM license data in.
    licenseViolations: [],
    blastRadiusTier: POLICY_TIER_FOR_VERDICT[verdict.verdict],
    // v1 wiring: ownership_required rules inspect touched paths. We don't
    // have the raw changed-file list on VerdictResponse yet — the closest
    // structured data is communitiesTouched. Leave touchedPaths empty for
    // now; this means ownership_required is a no-op until the verdict
    // pipeline surfaces changed paths explicitly.
    touchedPaths: [],
    ownersByPath: new Map(),
    approvals,
  };
}

/**
 * Merge the policy decision into the JSON output. Parsing the rendered JSON
 * is marginally slower than re-stringifying `verdict`, but it keeps a single
 * source of truth for the baseline shape (`renderJson`) and survives future
 * additions to VerdictResponse without touching this file.
 */
function renderJsonWithPolicy(baseJson: string, policy: PolicyDecision | undefined): string {
  if (policy === undefined) return baseJson;
  const parsed = JSON.parse(baseJson) as Record<string, unknown>;
  parsed["policy"] = policy;
  return JSON.stringify(parsed, null, 2);
}

function renderPolicyBlock(decision: PolicyDecision, format: VerdictOutputFormat): string {
  if (format === "markdown") return renderPolicyMarkdown(decision);
  return renderPolicySummary(decision);
}

function renderPolicyMarkdown(decision: PolicyDecision): string {
  if (decision.status === "pass") {
    return "### Policy\n\nPolicy: `pass`";
  }
  const lines: string[] = ["### Policy", "", `Policy: \`${decision.status}\``, "", "Violations:"];
  for (const v of decision.violations) {
    lines.push(`- \`${v.ruleId}\`: ${v.reason}`);
  }
  return lines.join("\n");
}

function renderPolicySummary(decision: PolicyDecision): string {
  const header = `Policy: ${decision.status}`;
  if (decision.status === "pass") return header;
  const lines: string[] = [header];
  for (const v of decision.violations) {
    lines.push(`  [!!] ${v.ruleId}: ${v.reason}`);
  }
  return lines.join("\n");
}

export { PolicyValidationError };
