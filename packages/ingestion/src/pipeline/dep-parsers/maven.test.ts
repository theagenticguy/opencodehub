import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseMavenDeps } from "./maven.js";

describe("parseMavenDeps — direct dependencies + scope filter", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "och-mvn-"));
    await writeFile(
      path.join(dir, "pom.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>fixture</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>6.1.6</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.2.0-jre</version>
    </dependency>
  </dependencies>
</project>
`,
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits groupId:artifactId names and drops test-scoped deps", async () => {
    const out = await parseMavenDeps({
      absPath: path.join(dir, "pom.xml"),
      relPath: "pom.xml",
      repoRoot: dir,
      onWarn: () => {},
    });
    const names = out.map((d) => d.name).sort();
    assert.deepEqual(names, ["com.google.guava:guava", "org.springframework:spring-core"]);
    const spring = out.find((d) => d.name === "org.springframework:spring-core");
    assert.ok(spring);
    assert.equal(spring.version, "6.1.6");
    assert.equal(spring.ecosystem, "maven");
  });
});
