# @opencodehub/policy

Parses, validates, and evaluates `opencodehub.policy.yaml` — the repo-root
policy file consumed by `codehub verdict`.

## Surface

```ts
import { evaluatePolicy, loadPolicy } from "@opencodehub/policy";

const policy = await loadPolicy("/repo/opencodehub.policy.yaml");
if (policy) {
  const decision = evaluatePolicy(policy, ctx);
  // decision.status is "pass" | "warn" | "block"
}
```

- `loadPolicy(path)` returns `undefined` when the file is missing or the YAML
  body parses to an empty document (the default starter at repo root has every
  rule commented out — this stays `undefined`).
- Malformed YAML or a Zod validation failure throws a typed error with the
  precise Zod message, so `codehub verdict` can surface it rather than
  silently pass.

## Rules (v1)

Three rule types, discriminated on `type`:

| `type`                | Behavior                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `license_allowlist`   | Block when any license in `deny` is observed in the audit input.         |
| `blast_radius_max`    | Block when the diff's blast-radius tier exceeds `max_tier`.              |
| `ownership_required`  | Block when a touched path under `paths` lacks an approval from an owner. |

Violations are sorted by `ruleId` for deterministic CI output.

## Design

- **Pure evaluator** — no DuckDB, no filesystem beyond the one YAML read.
  Inputs (`PolicyContext`) are pre-computed by the caller.
- **Zod-only** validation, matching `packages/sarif`.
- **Self-hosted OSS** — no calls to any OpenCodeHub-operated service.

See ADR 0007 and spec 002 for scope rationale.
