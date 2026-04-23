import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT_CONTEXT_FILES,
  DEFAULT_STANZA,
  replaceOrAppendStanza,
  STANZA_HEADING,
  writeAgentContextFiles,
  writeStanza,
} from "./agent-context.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-cli-agent-"));
}

test("writeStanza creates a new file when none exists", async () => {
  const dir = await scratch();
  const target = join(dir, "AGENTS.md");
  const result = await writeStanza(target);
  assert.equal(result.action, "created");
  const contents = await readFile(target, "utf8");
  assert.ok(contents.startsWith(STANZA_HEADING));
  assert.ok(contents.includes("list_repos"));
});

test("writeStanza replaces a pre-existing OpenCodeHub section in place", async () => {
  const dir = await scratch();
  const target = join(dir, "CLAUDE.md");
  const prior = [
    "# Project CLAUDE.md",
    "",
    "Some project rules above.",
    "",
    STANZA_HEADING,
    "",
    "outdated old stanza",
    "",
    "## Unrelated Section",
    "",
    "keep me",
    "",
  ].join("\n");
  await writeFile(target, prior, "utf8");

  const result = await writeStanza(target);
  assert.equal(result.action, "replaced");

  const out = await readFile(target, "utf8");
  assert.ok(out.includes("# Project CLAUDE.md"), "preserves content above the section");
  assert.ok(out.includes("## Unrelated Section"), "preserves sibling sections");
  assert.ok(out.includes("keep me"), "preserves content after the section");
  assert.ok(out.includes("list_repos"), "inserted the new stanza");
  assert.ok(!out.includes("outdated old stanza"), "dropped the old body");
});

test("writeStanza appends when file exists but has no OpenCodeHub section", async () => {
  const dir = await scratch();
  const target = join(dir, "AGENTS.md");
  await writeFile(target, "# Project AGENTS\n\nSome existing content.\n", "utf8");
  const result = await writeStanza(target);
  assert.equal(result.action, "appended");
  const out = await readFile(target, "utf8");
  assert.ok(out.startsWith("# Project AGENTS"));
  assert.ok(out.includes(STANZA_HEADING));
});

test("replaceOrAppendStanza keeps line breaks tidy when appending to empty", () => {
  const { replaced, output } = replaceOrAppendStanza("", DEFAULT_STANZA.trimEnd());
  assert.equal(replaced, false);
  assert.ok(output.startsWith(STANZA_HEADING));
  assert.ok(output.endsWith("\n"));
});

test("writeAgentContextFiles stamps both AGENTS.md and CLAUDE.md", async () => {
  const dir = await scratch();
  const results = await writeAgentContextFiles(dir);
  assert.equal(results.length, AGENT_CONTEXT_FILES.length);
  for (const file of AGENT_CONTEXT_FILES) {
    const contents = await readFile(join(dir, file), "utf8");
    assert.ok(contents.includes("list_repos"));
  }
});
