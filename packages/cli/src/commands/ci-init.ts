/**
 * `codehub ci-init` — emit opinionated CI workflow files for GitHub Actions
 * and/or GitLab CI.
 *
 * Platform detection:
 *   - probes `.github/workflows/` (GitHub) and `.gitlab-ci.yml` (GitLab)
 *   - if both are absent, defaults to `github`
 *   - if both are present, defaults to `both`
 *   - `--platform <p>` always overrides detection
 *
 * Templates live under `src/commands/ci-templates/*.yml` and are copied into
 * `dist/commands/ci-templates/` as a post-build step. Variables are
 * substituted with plain `String.prototype.replaceAll` — no handlebars.
 *
 * Idempotence: re-running with identical args produces byte-identical files.
 * Re-running against an existing file refuses unless `--force` is set, and
 * the error lists every conflict.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CiInitCliOptions {
  readonly repo?: string;
  readonly platform?: "github" | "gitlab" | "both";
  readonly force?: boolean;
  readonly mainBranch?: string;
}

interface TemplateSpec {
  readonly templateFile: string;
  readonly outputPath: (repoRoot: string) => string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, "ci-templates");

const GITHUB_TEMPLATES: readonly TemplateSpec[] = [
  {
    templateFile: "github-verdict.yml",
    outputPath: (root) => join(root, ".github", "workflows", "opencodehub-verdict.yml"),
  },
  {
    templateFile: "github-nightly.yml",
    outputPath: (root) => join(root, ".github", "workflows", "opencodehub-nightly.yml"),
  },
  {
    templateFile: "github-weekly.yml",
    outputPath: (root) => join(root, ".github", "workflows", "opencodehub-weekly.yml"),
  },
  {
    templateFile: "github-rescan.yml",
    outputPath: (root) => join(root, ".github", "workflows", "opencodehub-rescan.yml"),
  },
];

const GITLAB_TEMPLATES: readonly TemplateSpec[] = [
  {
    templateFile: "gitlab-ci.yml",
    outputPath: (root) => join(root, ".gitlab-ci.yml"),
  },
];

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectPlatform(repoRoot: string): Promise<"github" | "gitlab" | "both"> {
  const hasGithub = await pathExists(join(repoRoot, ".github", "workflows"));
  const hasGitlab = await pathExists(join(repoRoot, ".gitlab-ci.yml"));
  if (hasGithub && hasGitlab) return "both";
  if (hasGitlab) return "gitlab";
  return "github";
}

export function interpolate(
  template: string,
  vars: { readonly MAIN_BRANCH: string; readonly REPO_NAME: string },
): string {
  return (
    template
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal token to substitute
      .replaceAll("${MAIN_BRANCH}", vars.MAIN_BRANCH)
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal token to substitute
      .replaceAll("${REPO_NAME}", vars.REPO_NAME)
  );
}

function selectTemplates(platform: "github" | "gitlab" | "both"): readonly TemplateSpec[] {
  if (platform === "github") return GITHUB_TEMPLATES;
  if (platform === "gitlab") return GITLAB_TEMPLATES;
  return [...GITHUB_TEMPLATES, ...GITLAB_TEMPLATES];
}

interface RenderPlan {
  readonly outputPath: string;
  readonly contents: string;
}

export async function buildPlan(
  repoRoot: string,
  platform: "github" | "gitlab" | "both",
  mainBranch: string,
  repoName: string,
): Promise<readonly RenderPlan[]> {
  const specs = selectTemplates(platform);
  const out: RenderPlan[] = [];
  for (const spec of specs) {
    const raw = await readFile(join(TEMPLATES_DIR, spec.templateFile), "utf8");
    const rendered = interpolate(raw, { MAIN_BRANCH: mainBranch, REPO_NAME: repoName });
    out.push({ outputPath: spec.outputPath(repoRoot), contents: rendered });
  }
  return out;
}

export async function runCiInit(opts: CiInitCliOptions): Promise<void> {
  const repoRoot = resolve(opts.repo ?? process.cwd());
  const mainBranch = opts.mainBranch ?? "main";
  const repoName = basename(repoRoot);
  const platform = opts.platform ?? (await detectPlatform(repoRoot));
  const force = opts.force === true;

  const plan = await buildPlan(repoRoot, platform, mainBranch, repoName);

  if (!force) {
    const conflicts: string[] = [];
    for (const item of plan) {
      if (await pathExists(item.outputPath)) {
        conflicts.push(item.outputPath);
      }
    }
    if (conflicts.length > 0) {
      const lines = conflicts.map((p) => `  - ${p}`).join("\n");
      throw new Error(
        `codehub ci-init: refusing to overwrite ${conflicts.length} existing file(s):\n${lines}\nRe-run with --force to overwrite.`,
      );
    }
  }

  for (const item of plan) {
    await mkdir(dirname(item.outputPath), { recursive: true });
    await writeFile(item.outputPath, item.contents, "utf8");
  }

  console.warn(
    `codehub ci-init: wrote ${plan.length} workflow file(s) for platform=${platform} (main branch: ${mainBranch}).`,
  );
}
