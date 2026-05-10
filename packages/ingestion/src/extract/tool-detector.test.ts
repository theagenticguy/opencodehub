import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalizeObjectLiteral, detectMcpTools } from "./tool-detector.js";

test("detectMcpTools: tool definition under src/tools/ is detected", () => {
  const tools = detectMcpTools({
    filePath: "src/tools/my-tool.ts",
    content: [
      "export const definition = {",
      '  name: "my_tool",',
      '  description: "does things",',
      "  inputSchema: { type: 'object' },",
      "};",
    ].join("\n"),
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.toolName, "my_tool");
  assert.equal(tools[0]?.description, "does things");
  assert.equal(tools[0]?.handlerFile, "src/tools/my-tool.ts");
});

test("detectMcpTools: same content in an unrelated path is ignored", () => {
  const tools = detectMcpTools({
    filePath: "src/other.ts",
    content: [
      "export const definition = {",
      '  name: "my_tool",',
      '  description: "does things",',
      "};",
    ].join("\n"),
  });
  assert.deepEqual(tools, []);
});

test("detectMcpTools: quoted key form '\"name\"' also matches", () => {
  const tools = detectMcpTools({
    filePath: "src/tools/rpc-tool.ts",
    content: '{ "name": "rpc_ping", "description": "ping" }',
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.toolName, "rpc_ping");
});

test("detectMcpTools: description further than 5 lines away is not paired", () => {
  const tools = detectMcpTools({
    filePath: "src/tools/gap.ts",
    content: ['name: "far_tool",', "", "", "", "", "", "", 'description: "too far",'].join("\n"),
  });
  assert.deepEqual(tools, []);
});

test("detectMcpTools: multiple tools in one file are each emitted once", () => {
  const tools = detectMcpTools({
    filePath: "src/tools/catalog.ts",
    content: [
      "export const tools = [",
      '  { name: "alpha", description: "first" },',
      '  { name: "beta",  description: "second" },',
      "];",
    ].join("\n"),
  });
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.toolName, "alpha");
  assert.equal(tools[1]?.toolName, "beta");
});

test("detectMcpTools: captures inputSchema literal as canonical JSON", () => {
  const tools = detectMcpTools({
    filePath: "src/tools/schema-tool.ts",
    content: [
      "export const definition = {",
      "  name: 'my_tool',",
      "  description: 'does things',",
      "  inputSchema: {",
      "    type: 'object',",
      "    properties: { query: { type: 'string' } },",
      "    required: ['query'],",
      "  },",
      "};",
    ].join("\n"),
  });
  assert.equal(tools.length, 1);
  const schema = tools[0]?.inputSchemaJson;
  assert.ok(typeof schema === "string" && schema.length > 0);
  // Canonical form: keys sorted recursively.
  assert.equal(
    schema,
    '{"properties":{"query":{"type":"string"}},"required":["query"],"type":"object"}',
  );
});

test("canonicalizeObjectLiteral: returns undefined for template strings / barewords", () => {
  assert.equal(canonicalizeObjectLiteral("{ type: `object` }"), undefined);
  assert.equal(canonicalizeObjectLiteral("{ type: foo }"), undefined);
});

test("canonicalizeObjectLiteral: handles trailing commas + single quotes", () => {
  const out = canonicalizeObjectLiteral("{ a: 1, b: 'two', }");
  assert.equal(out, '{"a":1,"b":"two"}');
});

test("canonicalizeObjectLiteral: preserves JS escapes when transcribing", () => {
  // `\\` (one backslash) should round-trip as one backslash; `\n` should
  // stay a newline; `\"` inside a single-quoted source should survive as
  // an escaped quote in the JSON output. These cases failed under the
  // earlier `replace(/"/g, '\\"')`-only sanitization (CodeQL alert #131).
  const out = canonicalizeObjectLiteral("{ a: 'a\\\\b', b: 'c\\nd', c: 'e\\\"f' }");
  assert.equal(out, '{"a":"a\\\\b","b":"c\\nd","c":"e\\"f"}');
});
