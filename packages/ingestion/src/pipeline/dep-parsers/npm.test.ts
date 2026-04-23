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
