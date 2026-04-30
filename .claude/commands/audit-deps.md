---
description: License tier + dependency findings audit
allowed-tools: ["mcp__opencodehub__license_audit", "mcp__opencodehub__list_findings"]
---

Audit dependency licenses and outstanding security findings for the current repo, and give the user a one-screen verdict.

Steps:
1. Call `mcp__opencodehub__license_audit` with `{}`.
2. Call `mcp__opencodehub__list_findings` with `{ minSeverity: "warning" }`.
3. Produce a report with exactly these sections:

   **License tier**
   - Overall tier (`permissive` | `weak-copyleft` | `strong-copyleft` | `proprietary` | `unknown`).
   - One-line rationale.

   **GPL / strong-copyleft deps**
   - Bulleted list of `<package>@<version>` with license id. If none, write "None."

   **Proprietary / unknown deps**
   - Bulleted list of `<package>@<version>` with license id. If none, write "None."

   **Critical findings** (severity `error` or `critical`)
   - Bulleted list of `<rule-id> — <file>:<line> — <message>`. If none, write "None."

   **Recommendation**
   - One of: `ship`, `ship with license notice update`, `block — license incompatible`, `block — critical findings unresolved`.

Keep under 25 lines total. If either MCP call errors, report the error and stop.
