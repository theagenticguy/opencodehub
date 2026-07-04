/**
 * Conventional Commits (https://www.conventionalcommits.org/)
 * Enforced locally via lefthook `commit-msg` and on PRs via
 * .github/workflows/commitlint.yml.
 *
 * Allowed types (extend `scope-enum` when new workspace packages land or
 * Dependabot starts grouping under a new scope):
 *   feat, fix, chore, docs, refactor, perf, test, build, ci, style, revert, release
 *
 * Bot scopes: Dependabot uses `deps` for production-dep bumps,
 * `deps-dev` for devDependency-only bumps, and `github_actions` for
 * GitHub Actions bumps. All three are enumerated so the auto-generated
 * PRs pass commitlint without manual rewrites.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "chore",
        "docs",
        "refactor",
        "perf",
        "test",
        "build",
        "ci",
        "style",
        "revert",
        "release",
      ],
    ],
    "scope-enum": [
      2,
      "always",
      [
        "analysis",
        "cli",
        "cobol-proleap",
        "core-ops",
        "core-types",
        "embedder",
        "eval",
        "frameworks",
        "ingestion",
        "mcp",
        "pack",
        "policy",
        "sarif",
        "scanners",
        "scip-ingest",
        "search",
        "storage",
        "summarizer",
        "wiki",
        "plugin",
        "deps",
        // Dependabot emits `deps-dev` for devDependency-only updates and
        // `github_actions` for GitHub Actions bumps. Including both here
        // lets commitlint pass on the auto-generated PRs without manual
        // rewrites. See `.github/dependabot.yml` for the group config.
        "deps-dev",
        "github_actions",
        "ci",
        "docs",
        "repo",
        "release",
        "",
      ],
    ],
    "subject-case": [2, "never", ["start-case", "pascal-case", "upper-case"]],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [2, "always", 100],
  },
};
