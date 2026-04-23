import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { parseFixture } from "./test-helpers.js";
import { tsxProvider } from "./tsx.js";

const FIXTURE = `
import React from "react";
import { Button } from "./button.js";

interface Props {
  name: string;
}

export function Greeting(props: Props) {
  return <Button label={"Hi " + props.name} />;
}

export class Page extends React.Component<Props> {
  render() {
    return <Greeting name={this.props.name} />;
  }
}
`;

describe("tsxProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fixture: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fixture = await parseFixture(pool, "tsx", "page.tsx", FIXTURE);
  });

  it("extracts class, interface, and function definitions via shared TS logic", () => {
    const defs = tsxProvider.extractDefinitions({
      filePath: fixture.filePath,
      captures: fixture.captures,
      sourceText: fixture.sourceText,
    });
    const names = new Set(defs.map((d) => d.qualifiedName));
    assert.ok(names.has("Page"));
    assert.ok(names.has("Greeting"));
    assert.ok(names.has("Props"));
  });

  it("extracts a default React import and a named Button import", () => {
    const imports = tsxProvider.extractImports({
      filePath: fixture.filePath,
      sourceText: fixture.sourceText,
    });
    const hasReactDefault = imports.some((i) => i.kind === "default" && i.localAlias === "React");
    const hasButtonNamed = imports.some(
      (i) => i.kind === "named" && i.importedNames?.includes("Button"),
    );
    assert.ok(hasReactDefault, `imports: ${JSON.stringify(imports)}`);
    assert.ok(hasButtonNamed);
  });

  it("produces heritage edges for Page extends React.Component", () => {
    const defs = tsxProvider.extractDefinitions({
      filePath: fixture.filePath,
      captures: fixture.captures,
      sourceText: fixture.sourceText,
    });
    const heritage = tsxProvider.extractHeritage({
      filePath: fixture.filePath,
      captures: fixture.captures,
      definitions: defs,
    });
    const pageExtends = heritage.find(
      (h) => h.childQualifiedName === "Page" && h.relation === "EXTENDS",
    );
    assert.ok(pageExtends, `heritage: ${JSON.stringify(heritage)}`);
    // Parent-name captures the identifier as written (may be `React.Component`
    // or `Component` depending on how the header is sliced).
    assert.ok(/Component/.test(pageExtends?.parentName));
  });
});
