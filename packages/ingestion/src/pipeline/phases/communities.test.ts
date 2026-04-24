import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runIngestion } from "../orchestrator.js";

describe("communitiesPhase (via full pipeline)", () => {
  it("emits Community nodes and MEMBER_OF edges for a connected callable cluster", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-comm-"));
    try {
      await fs.writeFile(
        path.join(repo, "graph.ts"),
        [
          // 3 mutually-calling functions — should cluster together.
          "export function alpha() { beta(); gamma(); }",
          "export function beta() { alpha(); gamma(); }",
          "export function gamma() { alpha(); beta(); }",
          // 3 unrelated functions that call each other in a separate cluster.
          "export function loadX() { loadY(); loadZ(); }",
          "export function loadY() { loadX(); loadZ(); }",
          "export function loadZ() { loadX(); loadY(); }",
          "",
        ].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const communities = [...result.graph.nodes()].filter((n) => n.kind === "Community");
      const memberEdges = [...result.graph.edges()].filter((e) => e.type === "MEMBER_OF");
      assert.ok(communities.length >= 1, "expected at least one Community node");
      assert.ok(memberEdges.length >= 1, "expected at least one MEMBER_OF edge");
      for (const e of memberEdges) assert.equal(e.confidence, 1.0);
      for (const c of communities) {
        // Stability check: community ids are anchored at the `<global>` file.
        assert.ok(c.filePath === "<global>");
        assert.ok(c.id.startsWith("Community:<global>:community-"));
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("is deterministic across two full runs (identical community assignments)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-comm-det-"));
    try {
      await fs.writeFile(
        path.join(repo, "mod.ts"),
        [
          "export function a() { b(); }",
          "export function b() { a(); c(); }",
          "export function c() { b(); }",
          // Second cluster: grown to 3 members so it survives the
          // `members.length < 3` filter and still participates in the
          // determinism check.
          "export function x() { y(); z(); }",
          "export function y() { x(); z(); }",
          "export function z() { x(); y(); }",
          "",
        ].join("\n"),
      );
      const one = await runIngestion(repo, { skipGit: true });
      const two = await runIngestion(repo, { skipGit: true });
      const members1 = [...one.graph.edges()]
        .filter((e) => e.type === "MEMBER_OF")
        .map((e) => `${e.from}->${e.to}`)
        .sort();
      const members2 = [...two.graph.edges()]
        .filter((e) => e.type === "MEMBER_OF")
        .map((e) => `${e.from}->${e.to}`)
        .sort();
      assert.deepEqual(members1, members2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
