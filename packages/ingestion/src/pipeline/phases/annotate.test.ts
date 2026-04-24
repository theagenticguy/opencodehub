import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SCHEMA_VERSION } from "@opencodehub/core-types";
import { runIngestion } from "../orchestrator.js";

describe("annotatePhase (via full pipeline)", () => {
  it("surfaces schemaVersion, byKind, and byRelation on the orchestrator result", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-annotate-"));
    try {
      await fs.writeFile(path.join(repo, "a.ts"), "export function hello() { return 1; }\n");
      const result = await runIngestion(repo, { skipGit: true });
      assert.equal(result.stats.schemaVersion, SCHEMA_VERSION);
      const byKind = result.stats.byKind;
      const byRelation = result.stats.byRelation;
      assert.ok(byKind !== undefined);
      assert.ok(byRelation !== undefined);
      const fileCount: number | undefined = byKind["File"];
      assert.ok((fileCount ?? 0) >= 1);
      // CONTAINS edges always land because structure runs.
      const containsCount: number | undefined = byRelation["CONTAINS"];
      assert.ok((containsCount ?? 0) >= 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps byKind / byRelation ordering stable across runs", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-annotate-det-"));
    try {
      await fs.writeFile(path.join(repo, "a.ts"), "export function hello() { return 1; }\n");
      await fs.writeFile(path.join(repo, "b.ts"), "export function there() { return 2; }\n");
      const one = await runIngestion(repo, { skipGit: true });
      const two = await runIngestion(repo, { skipGit: true });
      assert.deepEqual(Object.keys(one.stats.byKind ?? {}), Object.keys(two.stats.byKind ?? {}));
      assert.deepEqual(
        Object.keys(one.stats.byRelation ?? {}),
        Object.keys(two.stats.byRelation ?? {}),
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
