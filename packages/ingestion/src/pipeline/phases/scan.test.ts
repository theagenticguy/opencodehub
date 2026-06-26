import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { KnowledgeGraph } from "@opencodehub/core-types";
import { HARDCODED_IGNORES } from "../gitignore.js";
import type { PipelineContext } from "../types.js";
import { scanPhase } from "./scan.js";

const execFileAsync = promisify(execFile);

describe("scanPhase", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-scan-"));
    await fs.writeFile(path.join(repo, ".gitignore"), "ignored/\n*.log\n!keep.log\n");
    await fs.writeFile(path.join(repo, "a.ts"), "export const A = 1;\n");
    await fs.writeFile(path.join(repo, "b.py"), "def b(): return 1\n");
    await fs.writeFile(path.join(repo, "notes.log"), "log contents");
    await fs.writeFile(path.join(repo, "keep.log"), "preserved");
    await fs.mkdir(path.join(repo, "ignored"), { recursive: true });
    await fs.writeFile(path.join(repo, "ignored", "hidden.ts"), "export const X = 2;\n");
    await fs.mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "c.ts"), "export function c(){}\n");
    // Binary file: non-printable with NUL byte in first 8KB.
    await fs.writeFile(path.join(repo, "blob.bin"), new Uint8Array([0, 1, 2, 0, 3, 4, 5]));
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
    return {
      repoPath: repo,
      options: { skipGit: true },
      graph: new KnowledgeGraph(),
      phaseOutputs: new Map(),
      ...overrides,
    };
  }

  it("finds source files and honors .gitignore (with negation)", async () => {
    const out = await scanPhase.run(makeCtx(), new Map());
    const rels = out.files.map((f) => f.relPath).sort();
    assert.ok(rels.includes("a.ts"));
    assert.ok(rels.includes("b.py"));
    assert.ok(rels.includes("src/c.ts"));
    assert.ok(rels.includes("keep.log"), "keep.log must be re-included via !keep.log");
    assert.ok(!rels.includes("notes.log"), "*.log must be ignored");
    assert.ok(!rels.includes("ignored/hidden.ts"), "ignored/ dir must be skipped");
    assert.ok(!rels.some((r) => r.startsWith("node_modules")), "node_modules must be skipped");
    assert.ok(!rels.includes("blob.bin"), "binary files must be skipped");
  });

  it("skips every HARDCODED_IGNORES directory at the repo root and nested", async () => {
    // Build a repo where each hardcoded-ignore name appears both at the root
    // and one level deep, each holding a source file the scan would otherwise
    // pick up. None of those files may appear in the scan output.
    const fixture = await mkdtemp(path.join(tmpdir(), "och-scan-hardcoded-"));
    try {
      await fs.writeFile(path.join(fixture, "real.ts"), "export const R = 1;\n");
      for (const name of HARDCODED_IGNORES) {
        // Root-level: <name>/leaf.ts
        const rootDir = path.join(fixture, name);
        await fs.mkdir(rootDir, { recursive: true });
        await fs.writeFile(path.join(rootDir, "leaf.ts"), "export const X = 1;\n");
        // Nested: src/<name>/leaf.ts — proves per-segment matching at depth.
        const nestedDir = path.join(fixture, "src", name);
        await fs.mkdir(nestedDir, { recursive: true });
        await fs.writeFile(path.join(nestedDir, "leaf.ts"), "export const Y = 2;\n");
      }
      const ctx: PipelineContext = {
        repoPath: fixture,
        options: { skipGit: true },
        graph: new KnowledgeGraph(),
        phaseOutputs: new Map(),
      };
      const out = await scanPhase.run(ctx, new Map());
      const rels = out.files.map((f) => f.relPath);
      // The one legitimate source file survives.
      assert.ok(rels.includes("real.ts"), "first-party source must be kept");
      // No kept path may traverse any hardcoded-ignore directory, at any depth.
      for (const name of HARDCODED_IGNORES) {
        const offenders = rels.filter((r) => r.split("/").includes(name));
        assert.deepEqual(
          offenders,
          [],
          `no scanned path may pass through "${name}/" — found: ${offenders.join(", ")}`,
        );
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("excludes venv/ and node_modules/ specifically, at root and nested", async () => {
    // Regression guard for the operator requirement: virtualenvs (.venv AND
    // the bare `venv` name) and node_modules must never enter the index.
    const fixture = await mkdtemp(path.join(tmpdir(), "och-scan-venv-"));
    try {
      const layouts = [
        "venv/lib/site.py",
        ".venv/lib/site.py",
        "node_modules/pkg/index.js",
        "backend/venv/lib/dep.py",
        "frontend/node_modules/pkg/index.js",
      ];
      for (const rel of layouts) {
        const abs = path.join(fixture, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, "x\n");
      }
      await fs.writeFile(path.join(fixture, "app.py"), "print('hi')\n");
      const ctx: PipelineContext = {
        repoPath: fixture,
        options: { skipGit: true },
        graph: new KnowledgeGraph(),
        phaseOutputs: new Map(),
      };
      const out = await scanPhase.run(ctx, new Map());
      const rels = out.files.map((f) => f.relPath);
      assert.ok(rels.includes("app.py"), "first-party source must be kept");
      for (const seg of ["venv", ".venv", "node_modules"]) {
        assert.ok(
          !rels.some((r) => r.split("/").includes(seg)),
          `"${seg}/" content must never appear in scan output`,
        );
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("excludes a user-.gitignore'd directory end-to-end through the scan phase", async () => {
    // .gitignore honoring on analyze: a directory the repo's own .gitignore
    // excludes must not be scanned, even though it is not a hardcoded ignore.
    const fixture = await mkdtemp(path.join(tmpdir(), "och-scan-gitignore-"));
    try {
      await fs.writeFile(path.join(fixture, ".gitignore"), "generated/\nsecret.key\n");
      await fs.writeFile(path.join(fixture, "main.ts"), "export const M = 1;\n");
      await fs.writeFile(path.join(fixture, "secret.key"), "shh\n");
      await fs.mkdir(path.join(fixture, "generated", "deep"), { recursive: true });
      await fs.writeFile(path.join(fixture, "generated", "deep", "g.ts"), "export const G = 1;\n");
      const ctx: PipelineContext = {
        repoPath: fixture,
        options: { skipGit: true },
        graph: new KnowledgeGraph(),
        phaseOutputs: new Map(),
      };
      const out = await scanPhase.run(ctx, new Map());
      const rels = out.files.map((f) => f.relPath);
      assert.ok(rels.includes("main.ts"), "tracked source must be kept");
      assert.ok(!rels.includes("secret.key"), ".gitignore file pattern must be honored");
      assert.ok(
        !rels.some((r) => r.startsWith("generated/")),
        ".gitignore directory pattern must be honored at scan time",
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("emits deterministic sha256 for each file", async () => {
    const one = await scanPhase.run(makeCtx(), new Map());
    const two = await scanPhase.run(makeCtx(), new Map());
    const a1 = one.files.find((f) => f.relPath === "a.ts");
    const a2 = two.files.find((f) => f.relPath === "a.ts");
    assert.ok(a1 && a2);
    assert.equal(a1.sha256, a2.sha256);
    assert.match(a1.sha256, /^[0-9a-f]{64}$/);
  });

  it("detects language from extension", async () => {
    const out = await scanPhase.run(makeCtx(), new Map());
    const a = out.files.find((f) => f.relPath === "a.ts");
    assert.equal(a?.language, "typescript");
    const b = out.files.find((f) => f.relPath === "b.py");
    assert.equal(b?.language, "python");
  });

  it("populates grammarSha for known languages", async () => {
    const out = await scanPhase.run(makeCtx(), new Map());
    const a = out.files.find((f) => f.relPath === "a.ts");
    const b = out.files.find((f) => f.relPath === "b.py");
    assert.ok(a);
    assert.ok(b);
    assert.equal(typeof a.grammarSha, "string");
    assert.match(a.grammarSha ?? "", /^[0-9a-f]{64}$/);
    assert.equal(typeof b.grammarSha, "string");
    assert.match(b.grammarSha ?? "", /^[0-9a-f]{64}$/);
    // Same grammar package → same sha (typescript and python differ).
    assert.notEqual(a.grammarSha, b.grammarSha);
  });

  it("grammarSha is null for unknown extensions", async () => {
    const out = await scanPhase.run(makeCtx(), new Map());
    const keep = out.files.find((f) => f.relPath === "keep.log");
    assert.ok(keep);
    assert.equal(keep.language, undefined);
    assert.equal(keep.grammarSha, null);
  });

  it("enforces the file-count cap with a warning", async () => {
    const warnings: string[] = [];
    const ctx = makeCtx({
      options: { skipGit: true, maxTotalFiles: 2 },
      onProgress: (ev) => {
        if (ev.kind === "warn" && ev.message !== undefined) warnings.push(ev.message);
      },
    });
    const out = await scanPhase.run(ctx, new Map());
    assert.ok(out.files.length <= 2);
    assert.ok(warnings.some((m) => m.includes("maxTotalFiles")));
  });

  it("enforces the per-file byte cap with a warning", async () => {
    const warnings: string[] = [];
    const ctx = makeCtx({
      options: { skipGit: true, byteCapPerFile: 5 },
      onProgress: (ev) => {
        if (ev.kind === "warn" && ev.message !== undefined) warnings.push(ev.message);
      },
    });
    await scanPhase.run(ctx, new Map());
    assert.ok(warnings.some((m) => /> cap/.test(m)));
  });

  it("exports empty submodulePaths for a repo with no submodules", async () => {
    const out = await scanPhase.run(makeCtx(), new Map());
    assert.deepEqual([...out.submodulePaths], []);
  });

  it("leaves trackedPaths undefined when skipGit is set", async () => {
    // skipGit short-circuits the git probes — the tracked set is unknown, so
    // consumers must fall back to their unfiltered behavior.
    const out = await scanPhase.run(makeCtx(), new Map());
    assert.equal(out.trackedPaths, undefined);
  });

  it("leaves trackedPaths undefined in a non-git directory", async () => {
    // A plain directory (no .git) is not a git checkout — `git ls-files`
    // exits non-zero and the helper resolves to undefined, not an empty set.
    const ctx = makeCtx({ options: {} });
    const out = await scanPhase.run(ctx, new Map());
    assert.equal(out.trackedPaths, undefined);
  });
});

describe("scanPhase — tracked-path capture", () => {
  let repo: string;

  async function runGit(cwd: string, args: readonly string[]): Promise<void> {
    await execFileAsync("git", args as string[], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test Author",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "Test Author",
        GIT_COMMITTER_EMAIL: "author@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  }

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-scan-tracked-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await runGit(repo, ["config", "commit.gpgsign", "false"]);
    // tracked.ts is committed → in HEAD; untracked.ts is written but never
    // `git add`ed → on disk but absent from the tracked set.
    await fs.writeFile(path.join(repo, "tracked.ts"), "export const T = 1;\n");
    await runGit(repo, ["add", "tracked.ts"]);
    await runGit(repo, ["commit", "-q", "-m", "feat: add tracked"]);
    await fs.writeFile(path.join(repo, "untracked.ts"), "export const U = 2;\n");
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("captures HEAD-tracked paths and excludes untracked files on disk", async () => {
    const ctx: PipelineContext = {
      repoPath: repo,
      options: {},
      graph: new KnowledgeGraph(),
      phaseOutputs: new Map(),
    };
    const out = await scanPhase.run(ctx, new Map());
    assert.ok(out.trackedPaths !== undefined, "trackedPaths must be populated in a git repo");
    assert.ok(out.trackedPaths.has("tracked.ts"), "committed file must be in the tracked set");
    assert.ok(
      !out.trackedPaths.has("untracked.ts"),
      "untracked file on disk must NOT be in the tracked set",
    );
    // The set keys match scan.files relPaths exactly (forward-slash,
    // repo-relative) so the ownership phase can intersect them directly.
    const onDisk = out.files.map((f) => f.relPath);
    assert.ok(onDisk.includes("tracked.ts"));
    assert.ok(onDisk.includes("untracked.ts"), "scan walk still sees the untracked file on disk");
  });
});

describe("scanPhase — submodule enumeration", () => {
  let outerRepo: string;
  let innerRepo: string;

  async function runGit(cwd: string, args: readonly string[]): Promise<void> {
    await execFileAsync("git", args as string[], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test Author",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "Test Author",
        GIT_COMMITTER_EMAIL: "author@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  }

  before(async () => {
    // Build a tiny inner repo with one commit; then clone it as a submodule
    // inside an outer repo. This exercises the real `git ls-tree` code path
    // so the 160000-mode filter must fire for the test to pass.
    outerRepo = await mkdtemp(path.join(tmpdir(), "och-scan-sub-outer-"));
    innerRepo = await mkdtemp(path.join(tmpdir(), "och-scan-sub-inner-"));

    await runGit(innerRepo, ["init", "-q", "-b", "main"]);
    await runGit(innerRepo, ["config", "commit.gpgsign", "false"]);
    await fs.writeFile(path.join(innerRepo, "inner.ts"), "export const I = 1;\n");
    await runGit(innerRepo, ["add", "inner.ts"]);
    await runGit(innerRepo, ["commit", "-q", "-m", "inner: init"]);

    await runGit(outerRepo, ["init", "-q", "-b", "main"]);
    await runGit(outerRepo, ["config", "commit.gpgsign", "false"]);
    await runGit(outerRepo, ["config", "protocol.file.allow", "always"]);
    await fs.writeFile(path.join(outerRepo, "a.ts"), "export const A = 1;\n");
    await runGit(outerRepo, ["add", "a.ts"]);
    await runGit(outerRepo, ["commit", "-q", "-m", "outer: init"]);
    await runGit(outerRepo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      innerRepo,
      "vendor/inner",
    ]);
    await runGit(outerRepo, ["commit", "-q", "-m", "outer: add submodule"]);
  });

  after(async () => {
    await rm(outerRepo, { recursive: true, force: true });
    await rm(innerRepo, { recursive: true, force: true });
  });

  it("enumerates submodule paths from `git ls-tree` gitlink entries", async () => {
    const ctx: PipelineContext = {
      repoPath: outerRepo,
      options: {},
      graph: new KnowledgeGraph(),
      phaseOutputs: new Map(),
    };
    const out = await scanPhase.run(ctx, new Map());
    assert.deepEqual([...out.submodulePaths], ["vendor/inner"]);
  });

  it("falls back to .gitmodules textual parse when skipGit is true", async () => {
    const ctx: PipelineContext = {
      repoPath: outerRepo,
      options: { skipGit: true },
      graph: new KnowledgeGraph(),
      phaseOutputs: new Map(),
    };
    const out = await scanPhase.run(ctx, new Map());
    assert.deepEqual([...out.submodulePaths], ["vendor/inner"]);
  });
});
