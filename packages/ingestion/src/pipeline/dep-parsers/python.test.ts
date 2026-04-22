import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parsePythonDeps } from "./python.js";

describe("parsePythonDeps — pyproject.toml (PEP 621 + Poetry)", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-py-pyproj-"));
    await writeFile(
      path.join(dir, "pyproject.toml"),
      [
        "[project]",
        'name = "fixture"',
        'version = "0.1.0"',
        "dependencies = [",
        '  "requests==2.31.0",',
        '  "httpx>=0.27",',
        '  "click[cli]>=8.1",',
        "]",
        "",
        "[project.optional-dependencies]",
        'dev = ["pytest>=8"]',
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'typer = "^0.12"',
        "",
      ].join("\n"),
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("captures PEP 621 deps, optional groups, and legacy poetry tables", async () => {
    const out = await parsePythonDeps({
      absPath: path.join(dir, "pyproject.toml"),
      relPath: "pyproject.toml",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d.version]));
    assert.equal(byName.get("requests"), "==2.31.0");
    assert.equal(byName.get("httpx"), ">=0.27");
    assert.equal(byName.get("click"), ">=8.1");
    assert.equal(byName.get("pytest"), ">=8");
    assert.equal(byName.get("typer"), "^0.12");
    assert.ok(!byName.has("python"), "python language pin must be skipped");
  });
});

describe("parsePythonDeps — requirements.txt tolerance", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-py-req-"));
    await writeFile(
      path.join(dir, "requirements.txt"),
      [
        "# a comment",
        "",
        "requests==2.31.0  # pinned",
        "flask>=2,<3",
        "numpy ; python_version >= '3.10'",
        "-e git+https://github.com/pallets/click.git#egg=click",
        "-r other.txt",
        "--hash=sha256:abc",
        "django==4.2 --hash=sha256:deadbeef",
      ].join("\n"),
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses valid specs and skips directives", async () => {
    const out = await parsePythonDeps({
      absPath: path.join(dir, "requirements.txt"),
      relPath: "requirements.txt",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d.version]));
    assert.equal(byName.get("requests"), "==2.31.0");
    assert.equal(byName.get("flask"), ">=2,<3");
    assert.equal(byName.get("numpy"), "UNKNOWN");
    assert.equal(byName.get("click"), "UNKNOWN");
    // django has a hash suffix — we only keep the version specifier.
    assert.equal(byName.get("django"), "==4.2--hash=sha256:deadbeef");
  });
});

describe("parsePythonDeps — uv.lock TOML", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-py-uv-"));
    await writeFile(
      path.join(dir, "uv.lock"),
      [
        "version = 1",
        "",
        "[[package]]",
        'name = "requests"',
        'version = "2.31.0"',
        "",
        "[[package]]",
        'name = "urllib3"',
        'version = "2.2.1"',
        "",
      ].join("\n"),
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits one dep per [[package]] entry", async () => {
    const out = await parsePythonDeps({
      absPath: path.join(dir, "uv.lock"),
      relPath: "uv.lock",
      repoRoot: dir,
      onWarn: () => {},
    });
    assert.equal(out.length, 2);
    const byName = new Map(out.map((d) => [d.name, d.version]));
    assert.equal(byName.get("requests"), "2.31.0");
    assert.equal(byName.get("urllib3"), "2.2.1");
  });
});
