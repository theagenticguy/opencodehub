import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadTask, TaskValidationError } from "./task.js";

describe("loadTask", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "och-eval-task-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, body: string): Promise<string> {
    const p = join(dir, name);
    await write_(p, body);
    return p;
  }
  async function write_(p: string, body: string): Promise<void> {
    await writeFile(p, body, "utf8");
  }

  it("loads a valid YAML task with an assertion oracle and applies defaults", async () => {
    const p = await write(
      "ok.yaml",
      [
        "id: add-json-flag",
        "repo: /tmp/some-repo",
        "commit: abc123",
        "instruction: Add a --json flag to status.",
        "oracle:",
        "  type: assertion",
        "  command: npm test",
        "",
      ].join("\n"),
    );
    const task = await loadTask(p);
    assert.equal(task.id, "add-json-flag");
    assert.equal(task.oracle.type, "assertion");
    if (task.oracle.type === "assertion") {
      assert.equal(task.oracle.command, "npm test");
      assert.equal(task.oracle.timeoutMs, 120_000, "default timeout applied");
    }
    assert.equal(task.harness, undefined, "harness optional");
  });

  it("loads a valid JSON task (yaml parser is a JSON superset)", async () => {
    const p = await write(
      "ok.json",
      JSON.stringify({
        id: "t",
        repo: "/r",
        commit: "c",
        instruction: "do it",
        oracle: { type: "output_hash" },
        harness: "claude",
      }),
    );
    const task = await loadTask(p);
    assert.equal(task.harness, "claude");
    assert.equal(task.oracle.type, "output_hash");
    if (task.oracle.type === "output_hash") {
      assert.equal(task.oracle.field, "final_text", "default field applied");
    }
  });

  it("throws TaskValidationError on a missing file", async () => {
    await assert.rejects(() => loadTask(join(dir, "nope.yaml")), TaskValidationError);
  });

  it("throws TaskValidationError on an empty file", async () => {
    const p = await write("empty.yaml", "");
    await assert.rejects(() => loadTask(p), TaskValidationError);
  });

  it("throws TaskValidationError on a schema violation (missing instruction)", async () => {
    const p = await write(
      "bad.yaml",
      ["id: t", "repo: /r", "commit: c", "oracle:", "  type: output_hash", ""].join("\n"),
    );
    await assert.rejects(
      () => loadTask(p),
      (err: unknown) => err instanceof TaskValidationError && /instruction/.test(err.message),
    );
  });

  it("rejects an unknown oracle type", async () => {
    const p = await write(
      "badoracle.yaml",
      ["id: t", "repo: /r", "commit: c", "instruction: x", "oracle:", "  type: telepathy", ""].join(
        "\n",
      ),
    );
    await assert.rejects(() => loadTask(p), TaskValidationError);
  });

  it("rejects unknown top-level keys (strict schema)", async () => {
    const p = await write(
      "extra.yaml",
      [
        "id: t",
        "repo: /r",
        "commit: c",
        "instruction: x",
        "oracle:",
        "  type: output_hash",
        "surprise: true",
        "",
      ].join("\n"),
    );
    await assert.rejects(() => loadTask(p), TaskValidationError);
  });
});
