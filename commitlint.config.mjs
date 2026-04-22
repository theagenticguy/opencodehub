/**
 * Conventional Commits (https://www.conventionalcommits.org/)
 * Enforced locally via lefthook `commit-msg` and on PRs via
 * .github/workflows/commitlint.yml.
 *
 * Allowed types (extend `scope-enum` when new workspace packages land):
 *   feat, fix, chore, docs, refactor, perf, test, build, ci, style, revert, release
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
        "core-types",
        "embedder",
        "ingestion",
        "mcp",
        "sarif",
        "scanners",
        "search",
        "storage",
        "eval",
        "plugin",
        "deps",
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
