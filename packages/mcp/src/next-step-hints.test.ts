import { strict as assert } from "node:assert";
import { test } from "node:test";
import { withNextSteps } from "./next-step-hints.js";

test("withNextSteps appends a trailing hint block when steps given", () => {
  const result = withNextSteps("hello", { foo: 1 }, ["call query", "call context"]);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  assert.match(first.text, /Suggested next tools:/);
  assert.match(first.text, /- call query/);
  assert.match(first.text, /- call context/);
});

test("withNextSteps leaves content alone when no steps", () => {
  const result = withNextSteps("hello", { foo: 1 }, []);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  assert.equal(first.text, "hello");
});

test("withNextSteps embeds structured payload plus next_steps array", () => {
  const result = withNextSteps("x", { a: "b" }, ["do thing"]);
  const sc = result.structuredContent as { a: string; next_steps: string[] };
  assert.equal(sc.a, "b");
  assert.deepEqual(sc.next_steps, ["do thing"]);
});

test("withNextSteps attaches staleness under codehub/staleness namespace", () => {
  const result = withNextSteps("x", { a: 1 }, [], {
    isStale: true,
    commitsBehind: 3,
    hint: "run analyze",
  });
  const sc = result.structuredContent as { _meta: Record<string, unknown> };
  const meta = sc._meta["codehub/staleness"] as { isStale: boolean; commitsBehind: number };
  assert.equal(meta.isStale, true);
  assert.equal(meta.commitsBehind, 3);
});

test("withNextSteps omits _meta entirely when no staleness", () => {
  const result = withNextSteps("x", { a: 1 }, ["hi"]);
  const sc = result.structuredContent as Record<string, unknown>;
  // biome-ignore lint/complexity/useLiteralKeys: dot-access disallowed on Record index signatures
  assert.equal(sc["_meta"], undefined);
});
