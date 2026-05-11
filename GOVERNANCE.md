# Governance

OpenCodeHub is an Apache-2.0 open-source project. This document describes
how decisions are made and how contributors can grow their involvement.

## Roles

| Role | Description |
|---|---|
| **User** | Anyone who uses OpenCodeHub. No requirements. |
| **Contributor** | Anyone who has had a PR merged. |
| **Committer** | Trusted contributor with write access, granted by maintainers after sustained quality contributions. |
| **Maintainer** | Committers with final say on direction and releases. Listed in `CODEOWNERS`. |

## Decision making

- **Day-to-day changes** (bug fixes, docs, dependency bumps): any committer
  can merge after one approving review.
- **Significant changes** (new packages, public API additions, breaking
  changes, new dependencies): require two approving reviews, including at
  least one maintainer.
- **Direction changes** (license, governance, major architecture): require
  maintainer consensus via a GitHub Discussion open for at least 7 days
  before merging.

When reviewers disagree, maintainers have final say. Decisions are recorded
in the PR or Discussion thread so rationale is preserved.

## Becoming a committer

Open a GitHub Discussion tagged `governance` and describe your contributions.
Maintainers vote by thumb (👍 / 👎) over 7 days; a simple majority of
active maintainers approves. Committer access is revoked after 12 months
of inactivity, or at the committer's request.

## Releases

Releases are cut by maintainers via `release-please` on `main`. Version
numbers follow [Semantic Versioning](https://semver.org/). The commit log
(Conventional Commits) drives changelog generation automatically.

## Amendments

This document can be amended via a PR that stays open for 7 days with no
maintainer objection, or with explicit approval from all active maintainers.
