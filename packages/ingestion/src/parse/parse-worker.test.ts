import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import type { LanguageId } from "@opencodehub/core-types";
import { MAX_FILE_BYTES, parseOne } from "./parse-worker.js";
import type { ParseCapture, ParseTask } from "./types.js";
import { WasmRuntimeUnavailableError } from "./wasm-runtime.js";

function task(content: Buffer, language: LanguageId = "typescript"): ParseTask {
  return { filePath: "src/sample.ts", content, language };
}

describe("parseOne — oversize skip", () => {
  it("skips a file over the byte cap without invoking the parser", async () => {
    let parserCalled = false;
    const oversize = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61); // 'a'
    const result = await parseOne(task(oversize), async () => {
      parserCalled = true;
      return [];
    });

    assert.equal(parserCalled, false, "parser must not run on an oversize file");
    assert.deepEqual(result.captures, []);
    assert.equal(result.byteLength, oversize.byteLength);
    assert.ok(result.warnings !== undefined && result.warnings.length === 1);
    assert.match(result.warnings[0] as string, /byte cap/);
    assert.match(result.warnings[0] as string, /skipping parse/);
  });

  it("parses a file exactly at the byte cap", async () => {
    const captures: readonly ParseCapture[] = [
      {
        tag: "definition.function",
        text: "atCap",
        startLine: 1,
        endLine: 1,
        startCol: 0,
        endCol: 5,
        nodeType: "function_declaration",
      },
    ];
    const atCap = Buffer.alloc(MAX_FILE_BYTES, 0x61);
    const result = await parseOne(task(atCap), async () => captures);

    assert.deepEqual(result.captures, captures);
    // A successful parse with no skip/error attaches no warnings array.
    assert.equal(result.warnings, undefined);
  });
});

describe("parseOne — error to warning mapping", () => {
  it("maps a synchronous parse throw to an empty-captures result + warning", async () => {
    const result = await parseOne(task(Buffer.from("const x = 1;\n")), () => {
      throw new Error("grammar exploded");
    });

    assert.deepEqual(result.captures, [], "captures must be empty on parse failure");
    assert.ok(result.warnings !== undefined && result.warnings.length === 1);
    assert.equal(result.warnings[0], "grammar exploded");
    assert.ok(result.parseTimeMs >= 0);
  });

  it("maps a rejected parse promise to a warning rather than crashing", async () => {
    const result = await parseOne(task(Buffer.from("x")), async () => {
      throw new Error("async parse failure");
    });

    assert.deepEqual(result.captures, []);
    assert.equal(result.warnings?.[0], "async parse failure");
  });

  it("stringifies a non-Error throw into the warning", async () => {
    const result = await parseOne(task(Buffer.from("x")), () => {
      throw "plain string failure";
    });

    assert.equal(result.warnings?.[0], "plain string failure");
  });

  it("RETHROWS a global WasmRuntimeUnavailableError instead of mapping it to a warning", async () => {
    // A global runtime death is broken-for-every-file; it must abort the run,
    // not become a per-file warning that hides behind a 0-symbol skeleton graph.
    await assert.rejects(
      parseOne(task(Buffer.from("x")), async () => {
        throw new WasmRuntimeUnavailableError("vendor/wasms missing");
      }),
      /vendor\/wasms missing/,
    );
  });

  it("keeps an ordinary per-file Error as a warning (not the global sentinel)", async () => {
    const result = await parseOne(task(Buffer.from("x")), () => {
      throw new Error("one bad file");
    });
    assert.deepEqual(result.captures, []);
    assert.equal(result.warnings?.[0], "one bad file");
  });
});

describe("parseOne — happy path", () => {
  it("returns the parser captures and records byte length", async () => {
    const captures: readonly ParseCapture[] = [
      {
        tag: "reference.call",
        text: "doThing",
        startLine: 2,
        endLine: 2,
        startCol: 4,
        endCol: 11,
        nodeType: "call_expression",
      },
    ];
    const content = Buffer.from("function f() {\n  doThing();\n}\n");
    const result = await parseOne(task(content), async () => captures);

    assert.deepEqual(result.captures, captures);
    assert.equal(result.byteLength, content.byteLength);
    assert.equal(result.language, "typescript");
    assert.equal(result.filePath, "src/sample.ts");
    assert.equal(result.warnings, undefined);
  });
});
