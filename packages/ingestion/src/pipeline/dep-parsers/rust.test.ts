import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseRustDeps } from "./rust.js";

describe("parseRustDeps — Cargo.lock with multi-version packages", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-rs-lock-"));
    await writeFile(
      path.join(dir, "Cargo.lock"),
      [
        "version = 3",
        "",
        "[[package]]",
        'name = "serde"',
        'version = "1.0.200"',
        "",
        "[[package]]",
        'name = "syn"',
        'version = "1.0.109"',
        "",
        "[[package]]",
        'name = "syn"',
        'version = "2.0.66"',
        "",
      ].join("\n"),
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits a separate dep per (name, version) coordinate", async () => {
    const out = await parseRustDeps({
      absPath: path.join(dir, "Cargo.lock"),
      relPath: "Cargo.lock",
      repoRoot: dir,
      onWarn: () => {},
    });
    assert.equal(out.length, 3);
    const synVersions = out
      .filter((d) => d.name === "syn")
      .map((d) => d.version)
      .sort();
    assert.deepEqual(synVersions, ["1.0.109", "2.0.66"]);
    const serde = out.find((d) => d.name === "serde");
    assert.ok(serde);
    assert.equal(serde.version, "1.0.200");
    assert.equal(serde.ecosystem, "cargo");
  });
});

describe("parseRustDeps — Cargo.toml direct deps", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-rs-toml-"));
    await writeFile(
      path.join(dir, "Cargo.toml"),
      [
        "[package]",
        'name = "demo"',
        'version = "0.1.0"',
        "",
        "[dependencies]",
        'serde = "1"',
        'tokio = { version = "1.38", features = ["full"] }',
        "",
        "[dev-dependencies]",
        'proptest = "1"',
        "",
      ].join("\n"),
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("captures string + table-form specifiers across dep tables", async () => {
    const out = await parseRustDeps({
      absPath: path.join(dir, "Cargo.toml"),
      relPath: "Cargo.toml",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d.version]));
    assert.equal(byName.get("serde"), "1");
    assert.equal(byName.get("tokio"), "1.38");
    assert.equal(byName.get("proptest"), "1");
  });
});
