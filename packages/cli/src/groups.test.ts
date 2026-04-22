import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertValidGroupName,
  deleteGroup,
  type GroupEntry,
  listGroups,
  readGroup,
  resolveGroupFile,
  writeGroup,
} from "./groups.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-cli-groups-"));
}

function entry(overrides: Partial<GroupEntry> = {}): GroupEntry {
  return {
    name: overrides.name ?? "demo",
    createdAt: overrides.createdAt ?? "2026-04-18T10:00:00Z",
    repos: overrides.repos ?? [
      { name: "alpha", path: "/tmp/alpha" },
      { name: "bravo", path: "/tmp/bravo" },
    ],
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
  };
}

test("assertValidGroupName accepts [a-z0-9_-]+ names", () => {
  assertValidGroupName("g1");
  assertValidGroupName("checkout-stack");
  assertValidGroupName("api_v2");
  assert.throws(() => assertValidGroupName("Bad Name"), /Invalid group name/);
  assert.throws(() => assertValidGroupName("../etc"), /Invalid group name/);
  assert.throws(() => assertValidGroupName(""), /Invalid group name/);
  assert.throws(() => assertValidGroupName("CAPS"), /Invalid group name/);
});

test("readGroup returns null when the file is absent", async () => {
  const home = await scratch();
  const result = await readGroup("missing", { home });
  assert.equal(result, null);
});

test("writeGroup + readGroup round-trips a 2-repo group", async () => {
  const home = await scratch();
  const g = entry({
    name: "checkout-stack",
    repos: [
      { name: "web-client", path: "/tmp/web-client" },
      { name: "api-server", path: "/tmp/api-server" },
    ],
    description: "Checkout flow",
  });
  await writeGroup(g, { home });
  const round = await readGroup("checkout-stack", { home });
  assert.ok(round);
  assert.equal(round.name, "checkout-stack");
  assert.equal(round.description, "Checkout flow");
  assert.equal(round.repos.length, 2);
  assert.deepEqual(
    round.repos.map((r) => r.name),
    ["api-server", "web-client"], // sorted by name on write
  );
});

test("writeGroup serializes repos alphabetically by name", async () => {
  const home = await scratch();
  await writeGroup(
    entry({
      name: "sorted",
      repos: [
        { name: "zulu", path: "/z" },
        { name: "alpha", path: "/a" },
        { name: "mike", path: "/m" },
      ],
    }),
    { home },
  );
  const raw = await readFile(resolveGroupFile("sorted", { home }), "utf8");
  assert.ok(raw.endsWith("\n"), "file must end with a newline");
  const alphaIdx = raw.indexOf('"alpha"');
  const mikeIdx = raw.indexOf('"mike"');
  const zuluIdx = raw.indexOf('"zulu"');
  assert.ok(alphaIdx < mikeIdx && mikeIdx < zuluIdx, "repos should be sorted");
});

test("deleteGroup removes the file and reports existence", async () => {
  const home = await scratch();
  await writeGroup(entry({ name: "doomed" }), { home });
  const first = await deleteGroup("doomed", { home });
  assert.equal(first, true);
  const second = await deleteGroup("doomed", { home });
  assert.equal(second, false);
  assert.equal(await readGroup("doomed", { home }), null);
});

test("listGroups returns an empty array when the directory is missing", async () => {
  const home = await scratch();
  const result = await listGroups({ home });
  assert.deepEqual(result, []);
});

test("listGroups returns every group sorted by name", async () => {
  const home = await scratch();
  await writeGroup(entry({ name: "zulu" }), { home });
  await writeGroup(entry({ name: "alpha" }), { home });
  await writeGroup(entry({ name: "mike" }), { home });
  const round = await listGroups({ home });
  assert.deepEqual(
    round.map((g) => g.name),
    ["alpha", "mike", "zulu"],
  );
});

test("writeGroup + readGroup reject invalid names", async () => {
  const home = await scratch();
  await assert.rejects(writeGroup(entry({ name: "Bad Name" }), { home }), /Invalid group name/);
  await assert.rejects(readGroup("Bad Name", { home }), /Invalid group name/);
  await assert.rejects(deleteGroup("Bad Name", { home }), /Invalid group name/);
});
