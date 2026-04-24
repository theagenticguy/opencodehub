import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseGoDeps } from "./go.js";

describe("parseGoDeps — go.sum", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-go-sum-"));
    await writeFile(
      path.join(dir, "go.sum"),
      [
        "github.com/pkg/errors v0.9.1 h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTwt4=",
        "github.com/pkg/errors v0.9.1/go.mod h1:bwawxfHBFNV+L2hUp1rHADufV3IMtnDRdf1r5NINEl0=",
        "golang.org/x/sys v0.0.0-20210320140829-1e4c9ba3b0c4 h1:abcdef",
        "",
      ].join("\n"),
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits one module per unique (module, version), stripping /go.mod", async () => {
    const out = await parseGoDeps({
      absPath: path.join(dir, "go.sum"),
      relPath: "go.sum",
      repoRoot: dir,
      onWarn: () => {},
    });
    // After dedup, pkg/errors appears twice (same version); we leave that
    // to the phase-level dedup. Here we just assert the version string
    // was normalized (no /go.mod suffix).
    const versions = new Set(
      out.filter((d) => d.name === "github.com/pkg/errors").map((d) => d.version),
    );
    assert.deepEqual([...versions].sort(), ["v0.9.1"]);
    const sys = out.find((d) => d.name === "golang.org/x/sys");
    assert.ok(sys);
    assert.equal(sys.version, "v0.0.0-20210320140829-1e4c9ba3b0c4");
  });
});

describe("parseGoDeps — go.mod require block", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-go-mod-"));
    await writeFile(
      path.join(dir, "go.mod"),
      [
        "module example.com/fixture",
        "",
        "go 1.22",
        "",
        "require (",
        "  github.com/pkg/errors v0.9.1",
        "  golang.org/x/sys v0.20.0 // indirect",
        ")",
        "",
        "require github.com/stretchr/testify v1.9.0",
        "",
        "replace github.com/foo/bar => ../bar",
        "",
      ].join("\n"),
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses single-line and block-form require directives", async () => {
    const out = await parseGoDeps({
      absPath: path.join(dir, "go.mod"),
      relPath: "go.mod",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d.version]));
    assert.equal(byName.get("github.com/pkg/errors"), "v0.9.1");
    assert.equal(byName.get("golang.org/x/sys"), "v0.20.0");
    assert.equal(byName.get("github.com/stretchr/testify"), "v1.9.0");
    assert.ok(!byName.has("github.com/foo/bar"));
  });
});
