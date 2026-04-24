/**
 * @doc capture smoke test — verifies that the unified queries expose
 * comment captures with the `doc` tag for TS/JS, Python, Rust, Go.
 * The parse phase consumer (descriptionForDefinition) is tested via
 * the pipeline-level fixtures; here we only assert the query layer
 * actually fires.
 */

import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import { parseFixture } from "../providers/test-helpers.js";
import type { ParseCapture } from "./types.js";
import { ParsePool } from "./worker-pool.js";

describe("@doc capture across languages", () => {
  const pool = new ParsePool({ minThreads: 1, maxThreads: 1 });
  after(async () => {
    await pool.destroy();
  });

  it("TypeScript: JSDoc block produces a doc capture", async () => {
    const src = `/** Adds two numbers together. */
export function add(a: number, b: number): number { return a + b; }
`;
    const fx = await parseFixture(pool, "typescript", "math.ts", src);
    const docs = fx.captures.filter((c: ParseCapture) => c.tag === "doc");
    assert.ok(docs.length >= 1, "expected a doc capture");
    assert.ok(docs.some((d: ParseCapture) => d.text.includes("Adds two numbers")));
  });

  it("Python: docstring produces a doc capture", async () => {
    const src = `def greet(name):
    """Say hello to the supplied name."""
    return f"hi {name}"
`;
    const fx = await parseFixture(pool, "python", "greet.py", src);
    const docs = fx.captures.filter((c: ParseCapture) => c.tag === "doc");
    assert.ok(docs.length >= 1, "expected a Python docstring capture");
    assert.ok(docs.some((d: ParseCapture) => d.text.includes("Say hello")));
  });

  it("Go: godoc comment produces a doc capture", async () => {
    const src = `package hi

// Greet salutes the caller.
func Greet(name string) string {
    return "hi " + name
}
`;
    const fx = await parseFixture(pool, "go", "greet.go", src);
    const docs = fx.captures.filter((c: ParseCapture) => c.tag === "doc");
    assert.ok(docs.length >= 1, "expected a godoc capture");
    assert.ok(docs.some((d: ParseCapture) => d.text.includes("Greet salutes")));
  });

  it("Rust: triple-slash rustdoc produces a doc capture", async () => {
    const src = `/// Adds two numbers.
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
`;
    const fx = await parseFixture(pool, "rust", "math.rs", src);
    const docs = fx.captures.filter((c: ParseCapture) => c.tag === "doc");
    assert.ok(docs.length >= 1, "expected a rustdoc capture");
    assert.ok(docs.some((d: ParseCapture) => d.text.includes("Adds two numbers")));
  });
});
