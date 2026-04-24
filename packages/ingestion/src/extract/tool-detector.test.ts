import assert from "node:assert/strict";
import { test } from "node:test";
import { detectMcpTools } from "./tool-detector.js";

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
