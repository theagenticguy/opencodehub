import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { after, describe, it } from "node:test";
import type { ParseTask } from "./types.js";
import { chunkTasks, ParsePool } from "./worker-pool.js";

// A small synthetic TypeScript fixture covering class + function + call.
const TS_FIXTURE = `
export class Greeter {
  greet(name: string): string {
    return "hello " + name;
  }
}

export function run(): void {
  const g = new Greeter();
  g.greet("world");
}
`;

describe("chunkTasks", () => {
  function makeTask(name: string, bytes: number): ParseTask {
    return {
      filePath: name,
      content: Buffer.alloc(bytes, 97), // filled with 'a'
      language: "typescript",
    };
  }

  it("dispatches 3 batches for [5MB, 5MB, 15MB] with 10MB/2-cap", () => {
    const tasks = [
      makeTask("a.ts", 5 * 1024 * 1024),
      makeTask("b.ts", 5 * 1024 * 1024),
      makeTask("c.ts", 15 * 1024 * 1024),
    ];
    const batches = chunkTasks(tasks, 10 * 1024 * 1024, 2);
    // Each task meets or exceeds the 10MB budget when combined with the
    // running total, so each ends up in its own batch.
    assert.equal(batches.length, 3);
    assert.deepEqual(
      batches.map((b) => b.map((t) => t.filePath)),
      [["a.ts"], ["b.ts"], ["c.ts"]],
    );
  });

  it("respects file cap independent of bytes", () => {
    const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`f${i}.ts`, 1024));
    const batches = chunkTasks(tasks, 100 * 1024 * 1024, 2);
    assert.equal(batches.length, 3);
    assert.equal(batches[0]?.length, 2);
    assert.equal(batches[1]?.length, 2);
    assert.equal(batches[2]?.length, 1);
  });

  it("places a single oversized task in its own batch", () => {
    const tasks = [
      makeTask("small.ts", 100),
      makeTask("huge.ts", 50 * 1024 * 1024),
      makeTask("tail.ts", 100),
    ];
    const batches = chunkTasks(tasks, 10 * 1024 * 1024, 200);
    assert.equal(batches.length, 3);
    assert.equal(batches[0]?.map((t) => t.filePath).join(","), "small.ts");
    assert.equal(batches[1]?.map((t) => t.filePath).join(","), "huge.ts");
    assert.equal(batches[2]?.map((t) => t.filePath).join(","), "tail.ts");
  });

  it("returns empty list for empty input", () => {
    assert.deepEqual(chunkTasks([], 1024, 10), []);
  });
});

describe("ParsePool (end-to-end)", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 2 });
  after(async () => {
    await pool.destroy();
  });

  it("extracts class/function/call captures from a TS fixture", async () => {
    const task: ParseTask = {
      filePath: "fixture.ts",
      content: Buffer.from(TS_FIXTURE, "utf8"),
      language: "typescript",
    };
    const results = await pool.dispatch([task]);
    assert.equal(results.length, 1);
    const [r] = results;
    if (r === undefined) throw new Error("no result");

    const tags = new Set(r.captures.map((c) => c.tag));
    assert.ok(tags.has("definition.class"), `missing definition.class, got ${[...tags].join(",")}`);
    assert.ok(
      tags.has("definition.function"),
      `missing definition.function, got ${[...tags].join(",")}`,
    );
    assert.ok(tags.has("reference.call"), `missing reference.call, got ${[...tags].join(",")}`);

    // Validate the class captures the Greeter identifier via a @name capture
    const nameCaptures = r.captures.filter((c) => c.tag === "name");
    const nameTexts = new Set(nameCaptures.map((c) => c.text));
    assert.ok(
      nameTexts.has("Greeter"),
      `name 'Greeter' should appear; got ${[...nameTexts].join(",")}`,
    );
    assert.ok(nameTexts.has("run"), `name 'run' should appear; got ${[...nameTexts].join(",")}`);
  });

  it("produces deterministic sorted output across runs", async () => {
    const tasks: ParseTask[] = [
      {
        filePath: "b.ts",
        content: Buffer.from("export const X = 1;\n", "utf8"),
        language: "typescript",
      },
      {
        filePath: "a.ts",
        content: Buffer.from("export function f(): number { return 1; }\n", "utf8"),
        language: "typescript",
      },
      {
        filePath: "c.ts",
        content: Buffer.from("export class C {}\n", "utf8"),
        language: "typescript",
      },
    ];

    const first = await pool.dispatch(tasks);
    const second = await pool.dispatch(tasks);

    // Sorted by filePath
    assert.deepEqual(
      first.map((r) => r.filePath),
      ["a.ts", "b.ts", "c.ts"],
    );
    assert.deepEqual(
      second.map((r) => r.filePath),
      ["a.ts", "b.ts", "c.ts"],
    );

    // Captures identical run-to-run (strip timing for comparison)
    const strip = (r: (typeof first)[number]) => ({
      filePath: r.filePath,
      language: r.language,
      byteLength: r.byteLength,
      captures: r.captures,
    });
    assert.deepEqual(first.map(strip), second.map(strip));
  });
});
