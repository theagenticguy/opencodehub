/**
 * Tests for stage 2 — lockfile resolver.
 *
 * Covers one positive fixture per supported format plus one malformed-input
 * fixture per format that must return `[]` without throwing.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { indexResolutions, parseLockfile } from "./lockfile.js";

describe("lockfile resolver — package-lock.json (npm v3)", () => {
  it("extracts dep versions from lockfileVersion 3 packages map", () => {
    const text = JSON.stringify({
      name: "acme",
      lockfileVersion: 3,
      packages: {
        "": { name: "acme", version: "0.0.1" },
        "node_modules/react": { version: "18.3.1", resolved: "https://x/react" },
        "node_modules/react-dom": { version: "18.3.1" },
        "node_modules/fastify": { version: "4.28.0" },
      },
    });
    const out = parseLockfile("package-lock.json", text);
    const byName = indexResolutions(out);
    assert.equal(byName.get("react"), "18.3.1");
    assert.equal(byName.get("react-dom"), "18.3.1");
    assert.equal(byName.get("fastify"), "4.28.0");
  });

  it("falls back to lockfileVersion 1 dependencies map", () => {
    const text = JSON.stringify({
      name: "legacy",
      lockfileVersion: 1,
      dependencies: {
        express: { version: "4.19.0" },
        "body-parser": { version: "1.20.0" },
      },
    });
    const byName = indexResolutions(parseLockfile("package-lock.json", text));
    assert.equal(byName.get("express"), "4.19.0");
    assert.equal(byName.get("body-parser"), "1.20.0");
  });

  it("returns [] on malformed JSON", () => {
    const out = parseLockfile("package-lock.json", "{ not json");
    assert.deepEqual(out, []);
  });
});

describe("lockfile resolver — pnpm-lock.yaml", () => {
  it("extracts dep versions from v9 packages key", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  /react@18.3.1:",
      "    resolution: {integrity: sha512-abc}",
      "  /fastapi@0.110.0(python@3.12):",
      "    resolution: {integrity: sha512-xyz}",
      "  '@nestjs/core@10.3.0':",
      "    resolution: {integrity: sha512-def}",
    ].join("\n");
    const byName = indexResolutions(parseLockfile("pnpm-lock.yaml", text));
    assert.equal(byName.get("react"), "18.3.1");
    assert.equal(byName.get("fastapi"), "0.110.0");
    assert.equal(byName.get("@nestjs/core"), "10.3.0");
  });

  it("returns [] on malformed YAML", () => {
    const out = parseLockfile("pnpm-lock.yaml", "packages: {\n  broken: [");
    assert.deepEqual(out, []);
  });
});

describe("lockfile resolver — Gemfile.lock", () => {
  it("extracts 4-space-indented `name (version)` lines from GEM specs", () => {
    const text = [
      "GEM",
      "  remote: https://rubygems.org/",
      "  specs:",
      "    rails (7.1.3)",
      "    actioncable (7.1.3)",
      "    actionview (= 7.1.3)",
      "    sinatra (3.1.0)",
      "",
      "PLATFORMS",
      "  ruby",
    ].join("\n");
    const byName = indexResolutions(parseLockfile("Gemfile.lock", text));
    assert.equal(byName.get("rails"), "7.1.3");
    assert.equal(byName.get("sinatra"), "3.1.0");
  });

  it("returns [] when no specs lines are present", () => {
    const out = parseLockfile("Gemfile.lock", "GEM\n  remote: nothing\n");
    assert.deepEqual(out, []);
  });
});

describe("lockfile resolver — poetry.lock (TOML)", () => {
  it("extracts [[package]] entries", () => {
    const text = [
      "# poetry.lock auto-generated",
      "[[package]]",
      'name = "fastapi"',
      'version = "0.110.0"',
      "",
      "[[package]]",
      'name = "django"',
      'version = "5.0.4"',
    ].join("\n");
    const byName = indexResolutions(parseLockfile("poetry.lock", text));
    assert.equal(byName.get("fastapi"), "0.110.0");
    assert.equal(byName.get("django"), "5.0.4");
  });

  it("returns [] on malformed TOML", () => {
    const out = parseLockfile("poetry.lock", "[[package]\nname =");
    assert.deepEqual(out, []);
  });
});

describe("lockfile resolver — uv.lock (TOML)", () => {
  it("extracts [[package]] entries", () => {
    const text = [
      "version = 1",
      "",
      "[[package]]",
      'name = "flask"',
      'version = "3.0.2"',
      "",
      "[[package]]",
      'name = "sqlalchemy"',
      'version = "2.0.29"',
    ].join("\n");
    const byName = indexResolutions(parseLockfile("uv.lock", text));
    assert.equal(byName.get("flask"), "3.0.2");
    assert.equal(byName.get("sqlalchemy"), "2.0.29");
  });
});

describe("lockfile resolver — Cargo.lock (TOML)", () => {
  it("extracts [[package]] entries", () => {
    const text = [
      "# Cargo.lock auto-generated",
      "[[package]]",
      'name = "tokio"',
      'version = "1.37.0"',
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.197"',
    ].join("\n");
    const byName = indexResolutions(parseLockfile("Cargo.lock", text));
    assert.equal(byName.get("tokio"), "1.37.0");
    assert.equal(byName.get("serde"), "1.0.197");
  });
});

describe("lockfile resolver — yarn.lock", () => {
  it("extracts entries from classic yarn lockfile lines", () => {
    const text = [
      "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT DIRECTLY.",
      "# yarn lockfile v1",
      "",
      '"react@^18.0.0":',
      '  version "18.3.1"',
      '  resolved "https://registry.yarnpkg.com/react/-/react-18.3.1.tgz"',
      "",
      '"nestjs@>=10.0.0":',
      '  version "10.3.0"',
    ].join("\n");
    const byName = indexResolutions(parseLockfile("yarn.lock", text));
    assert.equal(byName.get("react"), "18.3.1");
    assert.equal(byName.get("nestjs"), "10.3.0");
  });
});

describe("lockfile resolver — unknown filename", () => {
  it("returns [] on unsupported lockfile filenames", () => {
    const out = parseLockfile("unsupported.lock", "irrelevant");
    assert.deepEqual(out, []);
  });
});

describe("lockfile resolver — indexResolutions", () => {
  it("later entries win per dep (mirrors hoisting)", () => {
    const byName = indexResolutions([
      { file: "package-lock.json", dep: "react", version: "17.0.2" },
      { file: "package-lock.json", dep: "react", version: "18.3.1" },
    ]);
    assert.equal(byName.get("react"), "18.3.1");
  });
});
