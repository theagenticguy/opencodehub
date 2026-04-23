import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { ParsePool } from "../parse/worker-pool.js";
import { cProvider } from "./c.js";
import { parseFixture } from "./test-helpers.js";

const FIXTURE = `
#include <stdio.h>
#include "user.h"

typedef struct User {
    int id;
    char *name;
} User;

typedef enum Status {
    ACTIVE,
    INACTIVE
} Status;

static int _internal_counter = 0;

static void reset_counter(void) {
    _internal_counter = 0;
}

int register_user(const char *name) {
    User u;
    u.id = _internal_counter++;
    printf("registered %s\\n", name);
    return u.id;
}

int main(void) {
    register_user("alice");
    reset_counter();
    return 0;
}
`;

describe("cProvider (behavior)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  let fx: Awaited<ReturnType<typeof parseFixture>>;

  before(async () => {
    fx = await parseFixture(pool, "c", "user.c", FIXTURE);
  });

  it("extracts struct, enum, typedef, and functions", () => {
    const defs = cProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const names = new Set(defs.map((d) => d.qualifiedName));
    assert.ok(names.has("User"), `missing User in ${[...names].join(",")}`);
    assert.ok(names.has("Status"), `missing Status in ${[...names].join(",")}`);
    assert.ok(names.has("register_user"));
    assert.ok(names.has("main"));
  });

  it("treats static/underscore-prefixed as not exported", () => {
    const defs = cProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const reset = defs.find((d) => d.qualifiedName === "reset_counter");
    const mainD = defs.find((d) => d.qualifiedName === "main");
    assert.equal(reset?.isExported, false, "static fn should not be exported");
    assert.equal(mainD?.isExported, true);
  });

  it("parses system and user #include directives", () => {
    const imports = cProvider.extractImports({
      filePath: fx.filePath,
      sourceText: fx.sourceText,
    });
    const sources = imports.map((i) => i.source);
    assert.ok(sources.includes("stdio.h"));
    assert.ok(sources.includes("user.h"));
  });

  it("emits no heritage edges", () => {
    const heritage = cProvider.extractHeritage({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: [],
    });
    assert.equal(heritage.length, 0);
  });

  it("extracts function call sites", () => {
    const defs = cProvider.extractDefinitions({
      filePath: fx.filePath,
      captures: fx.captures,
      sourceText: fx.sourceText,
    });
    const calls = cProvider.extractCalls({
      filePath: fx.filePath,
      captures: fx.captures,
      definitions: defs,
    });
    const names = new Set(calls.map((c) => c.calleeName));
    assert.ok(names.has("register_user") || names.has("reset_counter"));
  });
});
