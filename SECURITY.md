# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** via
[GitHub Security Advisories](https://github.com/theagenticguy/opencodehub/security/advisories/new).

Do not open public issues for undisclosed vulnerabilities.

We aim to acknowledge new reports within 3 business days and to ship a
fix or mitigation within 30 days for high/critical issues.

## Supply chain

- All dependencies are pinned; the lockfile is checked in and CI uses
  `pnpm install --frozen-lockfile`.
- `osv-scanner` runs on every PR via the reusable Google workflow.
- `license-checker-rseidelsohn` enforces an OSI-approved license
  allowlist (Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, CC0-1.0,
  BlueOak-1.0.0, 0BSD).
- CodeQL (JavaScript/TypeScript + Python) runs on every PR and on a
  weekly schedule.
- OpenSSF Scorecard runs on branch-protection changes and weekly.
- A CycloneDX SBOM (`SBOM.cdx.json`) is regenerated on every release
  and attached to the release artifacts.
- No code is copied from non-OSI-approved sources.

## Threat model (MVP)

- User-supplied SQL queries via the `sql` MCP tool are executed against
  a read-only connection with an injected timeout; write statements are
  rejected.
- All editor-config writes are atomic (`write-file-atomic`) and preserve
  existing entries.
- `codehub analyze --offline` opens zero sockets (enforced in CI).
