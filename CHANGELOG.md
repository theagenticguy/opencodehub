# Changelog

## [Unreleased]

### Fixed

- **cli:** `scan` ingests SARIF into the scanned repo, not CWD.
- **cli:** `doctor` resolves native bindings from owner workspaces.
- **smoke-mcp:** asserts 29 tools, matching the v1.0 server surface.

### Docs

- **repo:** README v1.0 status, 29-tool surface, parse-runtime section,
  and accurate 17-package list (drops `eval` / `gym`, adds
  `cobol-proleap`, `frameworks`, `pack`, `policy`, `wiki`).
- **adr:** cross-link the two concurrently-numbered ADR 0013 files,
  flip 0011 + 0013-m7 status to Accepted, and scrub session-local
  spec coordinates from ADR text.
- **repo:** sync `CHANGELOG`, `USECASE`, `AGENTS`, and `OBJECTIVES`
  with v1 reality (tool count, language count, package set).

## [0.1.1](https://github.com/theagenticguy/opencodehub/compare/root-v0.1.0...root-v0.1.1) (2026-04-22)


### Bug Fixes

* **ci:** build workspace dist before typecheck so cross-package .d.ts resolves ([2935965](https://github.com/theagenticguy/opencodehub/commit/29359651d5e1a88226c86057082870d3e2f2a3fb))
* **ci:** pin osv-scanner reusable workflow to v2.3.5 ([fb7f137](https://github.com/theagenticguy/opencodehub/commit/fb7f137424d162478fdfce27ef8046465d0769a8))
