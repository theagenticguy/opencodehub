/**
 * License-population tests across every manifest parser that carries a
 * license field in the source file (npm lockfile, pyproject, Cargo.lock,
 * uv.lock). Parsers for ecosystems whose manifests do not carry licenses
 * (go.mod, pom.xml standard, csproj standard) are exercised elsewhere;
 * the invariant there is `license === undefined`, already covered by
 * the existing test suite.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseNpmDeps } from "./npm.js";
import { parsePythonDeps } from "./python.js";
import { parseRustDeps } from "./rust.js";

describe("license: npm package-lock.json", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-npm-lic-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        dependencies: { "left-pad": "^1.3.0" },
      }),
    );
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
            license: "WTFPL",
          },
        },
      }),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("propagates `license` from the v2 packages map", async () => {
    const out = await parseNpmDeps({
      absPath: path.join(dir, "package-lock.json"),
      relPath: "package-lock.json",
      repoRoot: dir,
      onWarn: () => {},
    });
    const leftPad = out.find((d) => d.name === "left-pad");
    assert.ok(leftPad !== undefined, "left-pad missing from npm deps");
    assert.equal(leftPad.license, "WTFPL");
  });
});

describe("license: uv.lock", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-uv-lic-"));
    await writeFile(
      path.join(dir, "uv.lock"),
      `
[[package]]
name = "httpx"
version = "0.27.0"
license = "BSD-3-Clause"

[[package]]
name = "requests"
version = "2.31.0"

[package.optional-dependencies]
socks = ["PySocks==1.7.1"]

[[package]]
name = "pytest"
version = "8.1.1"
classifiers = [
  "License :: OSI Approved :: MIT License",
]
`,
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("picks up direct `license` and trove-classifier licenses", async () => {
    const out = await parsePythonDeps({
      absPath: path.join(dir, "uv.lock"),
      relPath: "uv.lock",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d]));
    assert.equal(byName.get("httpx")?.license, "BSD-3-Clause");
    assert.equal(byName.get("pytest")?.license, "MIT License");
    // `requests` entry carries no license in the fixture.
    assert.equal(byName.get("requests")?.license, undefined);
  });
});

describe("license: Cargo.lock v3 with license field", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-cargo-lic-"));
    await writeFile(
      path.join(dir, "Cargo.lock"),
      `
version = 3

[[package]]
name = "serde"
version = "1.0.200"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "0000000000000000000000000000000000000000000000000000000000000000"
license = "MIT OR Apache-2.0"

[[package]]
name = "anyhow"
version = "1.0.80"
source = "registry+https://github.com/rust-lang/crates.io-index"
`,
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("propagates `license` when the lockfile carries it", async () => {
    const out = await parseRustDeps({
      absPath: path.join(dir, "Cargo.lock"),
      relPath: "Cargo.lock",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d]));
    assert.equal(byName.get("serde")?.license, "MIT OR Apache-2.0");
    assert.equal(byName.get("anyhow")?.license, undefined);
  });
});
