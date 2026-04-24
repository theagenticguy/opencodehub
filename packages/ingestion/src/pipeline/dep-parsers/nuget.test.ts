import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseNugetDeps } from "./nuget.js";

describe("parseNugetDeps — .csproj PackageReference entries", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-nug-"));
    await writeFile(
      path.join(dir, "App.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog" Version="3.1.1" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Dapper">
      <Version>2.1.24</Version>
    </PackageReference>
  </ItemGroup>
</Project>
`,
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("captures attribute-form and child-element-form versions", async () => {
    const out = await parseNugetDeps({
      absPath: path.join(dir, "App.csproj"),
      relPath: "App.csproj",
      repoRoot: dir,
      onWarn: () => {},
    });
    const byName = new Map(out.map((d) => [d.name, d.version]));
    assert.equal(byName.get("Newtonsoft.Json"), "13.0.3");
    assert.equal(byName.get("Serilog"), "3.1.1");
    assert.equal(byName.get("Dapper"), "2.1.24");
    const nj = out.find((d) => d.name === "Newtonsoft.Json");
    assert.ok(nj);
    assert.equal(nj.ecosystem, "nuget");
  });
});
