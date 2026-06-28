/**
 * npm parser tests — cover each of the three input kinds the parser
 * accepts (package-lock, pnpm-lock, bare package.json).
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseNpmDeps } from "./npm.js";

describe("parseNpmDeps — package-lock.json (lockfileVersion 2)", () => {
  let dir: string;
  let relLockPath: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-npm-lock-"));
    // package.json is required by the snyk parser for lockfiles.
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        dependencies: { "left-pad": "^1.3.0" },
      }),
    );
    // Minimal valid lockfileVersion 2 document.
    await writeFile(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 2,
        requires: true,
        packages: {
          "": {
            name: "fixture",
            version: "1.0.0",
            dependencies: { "left-pad": "^1.3.0" },
          },
          "node_modules/left-pad": {
            version: "1.3.0",
            resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
          },
        },
        dependencies: {
          "left-pad": {
            version: "1.3.0",
            resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
          },
        },
      }),
    );
    relLockPath = "package-lock.json";
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits the locked version of left-pad", async () => {
    const warnings: string[] = [];
    const out = await parseNpmDeps({
      absPath: path.join(dir, relLockPath),
      relPath: relLockPath,
      repoRoot: dir,
      onWarn: (m) => warnings.push(m),
    });
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join("\n")}`);
    const leftPad = out.find((d) => d.name === "left-pad");
    assert.ok(leftPad, "left-pad not emitted");
    assert.equal(leftPad.version, "1.3.0");
    assert.equal(leftPad.ecosystem, "npm");
    assert.equal(leftPad.lockfileSource, "package-lock.json");
  });
});

describe("parseNpmDeps — package-lock.json (lockfileVersion 3 + scoped + license)", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-npm-lock3-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "2.0.0" }),
    );
    // v3 lockfiles drop the legacy top-level `dependencies` mirror entirely
    // and key everything under `packages`. Includes a scoped package and a
    // `license` field to exercise the license join.
    await writeFile(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "2.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "fixture", version: "2.0.0" },
          "node_modules/left-pad": { version: "1.3.0", license: "WTFPL" },
          "node_modules/@scope/util": { version: "4.5.6", license: "MIT" },
          // Nested transitive (deduped npm layout) — still a resolved pkg.
          "node_modules/left-pad/node_modules/semver": { version: "7.6.0" },
        },
      }),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits every resolved package incl. scoped, nested, and license", async () => {
    const warnings: string[] = [];
    const out = await parseNpmDeps({
      absPath: path.join(dir, "package-lock.json"),
      relPath: "package-lock.json",
      repoRoot: dir,
      onWarn: (m) => warnings.push(m),
    });
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join("\n")}`);
    const byName = new Map(out.map((d) => [d.name, d]));
    assert.equal(byName.get("left-pad")?.version, "1.3.0");
    assert.equal(byName.get("left-pad")?.license, "WTFPL");
    assert.equal(byName.get("@scope/util")?.version, "4.5.6");
    assert.equal(byName.get("@scope/util")?.license, "MIT");
    // nested transitive captured by node_modules path tail
    assert.equal(byName.get("semver")?.version, "7.6.0");
    // root project itself must NOT appear as a dependency
    assert.equal(byName.has("fixture"), false);
  });
});

describe("parseNpmDeps — package-lock.json (legacy lockfileVersion 1)", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-npm-lock1-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    // v1 has no `packages` map — only the nested `dependencies` tree.
    await writeFile(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 1,
        requires: true,
        dependencies: {
          "left-pad": { version: "1.3.0" },
          minimist: {
            version: "1.2.8",
            dependencies: { "nested-dep": { version: "0.0.1" } },
          },
        },
      }),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("walks the nested dependencies tree", async () => {
    const out = await parseNpmDeps({
      absPath: path.join(dir, "package-lock.json"),
      relPath: "package-lock.json",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d]));
    assert.equal(byName.get("left-pad")?.version, "1.3.0");
    assert.equal(byName.get("minimist")?.version, "1.2.8");
    assert.equal(byName.get("nested-dep")?.version, "0.0.1");
  });
});

describe("parseNpmDeps — pnpm-lock.yaml (v9 modern keys)", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-pnpm9-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    // v9 keys are `name@version` / `@scope/name@version`, optionally with a
    // `(peerHash)` suffix under both `packages:` and `snapshots:`.
    await writeFile(
      path.join(dir, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  left-pad@1.3.0:",
        "    resolution: {integrity: sha512-fake==}",
        "",
        "  '@scope/util@4.5.6':",
        "    resolution: {integrity: sha512-fake==}",
        "",
        "  react-dom@18.2.0(react@18.2.0):",
        "    resolution: {integrity: sha512-fake==}",
        "",
        "snapshots:",
        "",
        "  left-pad@1.3.0: {}",
        "",
        "  '@scope/util@4.5.6': {}",
        "",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses modern keys incl. scoped and peer-suffixed versions", async () => {
    const warnings: string[] = [];
    const out = await parseNpmDeps({
      absPath: path.join(dir, "pnpm-lock.yaml"),
      relPath: "pnpm-lock.yaml",
      repoRoot: dir,
      onWarn: (m) => warnings.push(m),
    });
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join("\n")}`);
    const byName = new Map(out.map((d) => [d.name, d]));
    assert.equal(byName.get("left-pad")?.version, "1.3.0");
    assert.equal(byName.get("@scope/util")?.version, "4.5.6");
    // peer suffix stripped to the bare version
    assert.equal(byName.get("react-dom")?.version, "18.2.0");
  });
});

describe("parseNpmDeps — pnpm-lock.yaml (legacy v6 slash keys)", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-pnpm6-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    // v5/v6 keys are `/name/version` / `/@scope/name/version`, with optional
    // `_peer` or `(peer)` suffix.
    await writeFile(
      path.join(dir, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '6.0'",
        "",
        "packages:",
        "",
        "  /left-pad/1.3.0:",
        "    resolution: {integrity: sha512-fake==}",
        "",
        "  /@scope/util/4.5.6:",
        "    resolution: {integrity: sha512-fake==}",
        "",
        "  /react-dom/18.2.0_react@18.2.0:",
        "    resolution: {integrity: sha512-fake==}",
        "",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses legacy slash keys incl. scoped and peer suffix", async () => {
    const out = await parseNpmDeps({
      absPath: path.join(dir, "pnpm-lock.yaml"),
      relPath: "pnpm-lock.yaml",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d]));
    assert.equal(byName.get("left-pad")?.version, "1.3.0");
    assert.equal(byName.get("@scope/util")?.version, "4.5.6");
    assert.equal(byName.get("react-dom")?.version, "18.2.0");
  });
});

describe("parseNpmDeps — lockfile without sibling package.json", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-nolock-"));
    await writeFile(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, packages: {} }),
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("warns about the missing manifest and returns []", async () => {
    const warnings: string[] = [];
    const out = await parseNpmDeps({
      absPath: path.join(dir, "package-lock.json"),
      relPath: "package-lock.json",
      repoRoot: dir,
      onWarn: (m) => warnings.push(m),
    });
    assert.deepEqual([...out], []);
    assert.ok(
      warnings.some((w) => w.includes("lacks sibling package.json")),
      `expected sibling-manifest warning, got: ${warnings.join("\n")}`,
    );
  });
});

describe("parseNpmDeps — bare package.json fallback", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-npm-bare-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.0.1",
        dependencies: {
          express: "^4.18.2",
        },
        devDependencies: {
          typescript: "5.4.0",
        },
      }),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("captures both production and dev deps with their raw specifiers", async () => {
    const out = await parseNpmDeps({
      absPath: path.join(dir, "package.json"),
      relPath: "package.json",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d]));
    assert.equal(byName.get("express")?.version, "^4.18.2");
    assert.equal(byName.get("typescript")?.version, "5.4.0");
  });
});

describe("parseNpmDeps — malformed input", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-npm-bad-"));
    await writeFile(path.join(dir, "package.json"), "{not valid json");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("warns and returns [] rather than throwing", async () => {
    const warnings: string[] = [];
    const out = await parseNpmDeps({
      absPath: path.join(dir, "package.json"),
      relPath: "package.json",
      repoRoot: dir,
      onWarn: (m) => warnings.push(m),
    });
    assert.deepEqual([...out], []);
    assert.ok(warnings.length > 0);
  });
});

describe("parseNpmDeps — ignores unrelated basenames", () => {
  it("returns [] for README.md", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "och-npm-noop-"));
    try {
      await writeFile(path.join(tmp, "README.md"), "# hi");
      const out = await parseNpmDeps({
        absPath: path.join(tmp, "README.md"),
        relPath: "README.md",
        repoRoot: tmp,
        onWarn: () => {},
      });
      assert.deepEqual([...out], []);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
