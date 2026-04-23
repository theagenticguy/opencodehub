import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileNode, FindingNode, ToolNode } from "./nodes.js";

test("v2: ToolNode accepts inputSchemaJson", () => {
  const n: ToolNode = {
    id: "Tool:t1",
    kind: "Tool",
    name: "t1",
    filePath: "src/tools.ts",
    toolName: "t1",
    inputSchemaJson: "{}",
  } as ToolNode;
  assert.equal(n.inputSchemaJson, "{}");
});

test("v2: FindingNode accepts partialFingerprint + baselineState + suppressedJson", () => {
  const n: Partial<FindingNode> = {
    partialFingerprint: "abc",
    baselineState: "new",
    suppressedJson: '{"kind":"external","justification":"test"}',
  };
  assert.equal(n.baselineState, "new");
  assert.equal(n.partialFingerprint, "abc");
  assert.ok(n.suppressedJson?.includes("external"));
});

test("v2: FileNode accepts coveragePercent + coveredLines", () => {
  const n: Partial<FileNode> = { coveragePercent: 0.85, coveredLines: [1, 2, 3] };
  assert.deepEqual(n.coveredLines, [1, 2, 3]);
  assert.equal(n.coveragePercent, 0.85);
});
