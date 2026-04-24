import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listGroups, readGroup } from "../groups.js";
import { upsertRegistry } from "../registry.js";
import {
  fuseGroupRuns,
  resolveGroupContractsPath,
  runGroupAdd,
  runGroupCreate,
  runGroupDelete,
  runGroupRemove,
  runGroupShow,
  runGroupStatus,
  runGroupSyncCmd,
} from "./group.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-cli-group-cmd-"));
}

async function seedRegistry(home: string, repos: readonly string[]): Promise<void> {
  for (const name of repos) {
    await upsertRegistry(
      {
        name,
        path: join(home, name),
        indexedAt: "2026-04-18T00:00:00Z",
        nodeCount: 100,
        edgeCount: 200,
        lastCommit: "deadbeef",
      },
      { home },
    );
  }
}

test("runGroupCreate writes a group when every repo is registered", async () => {
  const home = await scratch();
  await seedRegistry(home, ["repoA", "repoB"]);
  const g = await runGroupCreate("g1", ["repoA", "repoB"], {
    home,
    now: () => "2026-04-18T01:02:03Z",
  });
  assert.equal(g.name, "g1");
  assert.equal(g.repos.length, 2);
  const round = await readGroup("g1", { home });
  assert.ok(round);
  assert.deepEqual(
    round.repos.map((r) => r.name),
    ["repoA", "repoB"],
  );
});

test("runGroupCreate rejects unknown repos", async () => {
  const home = await scratch();
  await seedRegistry(home, ["repoA"]);
  await assert.rejects(runGroupCreate("g1", ["repoA", "ghost"], { home }), /unknown repo.*ghost/);
  // Nothing should be written.
  const round = await readGroup("g1", { home });
  assert.equal(round, null);
});

test("runGroupCreate requires at least one repo", async () => {
  const home = await scratch();
  await seedRegistry(home, []);
  await assert.rejects(runGroupCreate("g1", [], { home }), /at least one repo/);
});

test("listGroups reflects create", async () => {
  const home = await scratch();
  await seedRegistry(home, ["r1"]);
  await runGroupCreate("g1", ["r1"], { home });
  const all = await listGroups({ home });
  assert.equal(all.length, 1);
  assert.equal(all[0]?.name, "g1");
});

test("runGroupDelete is a no-op on missing groups and removes existing", async () => {
  const home = await scratch();
  await seedRegistry(home, ["r1"]);
  await runGroupCreate("g1", ["r1"], { home });
  await runGroupDelete("g1", { home });
  assert.equal(await readGroup("g1", { home }), null);
  // Second delete is a no-op.
  await runGroupDelete("g1", { home });
});

test("runGroupStatus surfaces per-repo status rows", async () => {
  const home = await scratch();
  await seedRegistry(home, ["r1", "r2"]);
  await runGroupCreate("g2", ["r1", "r2"], { home });
  const rows = await runGroupStatus("g2", { home });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.inRegistry, true);
    assert.equal(row.nodeCount, 100);
    assert.equal(row.edgeCount, 200);
  }
});

test("runGroupStatus flags orphans when registry entry vanishes", async () => {
  const home = await scratch();
  await seedRegistry(home, ["r1", "r2"]);
  await runGroupCreate("g3", ["r1", "r2"], { home });
  // Drop r2 from registry but leave the group intact.
  const { removeFromRegistry } = await import("../registry.js");
  await removeFromRegistry("r2", { home });
  const rows = await runGroupStatus("g3", { home });
  const r1 = rows.find((r) => r.name === "r1");
  const r2 = rows.find((r) => r.name === "r2");
  assert.equal(r1?.inRegistry, true);
  assert.equal(r2?.inRegistry, false);
});

test("runGroupAdd appends a registered repo and is idempotent", async () => {
  const home = await scratch();
  await seedRegistry(home, ["r1", "r2", "r3"]);
  await runGroupCreate("g", ["r1"], { home });
  const after = await runGroupAdd("g", "r2", { home });
  assert.deepEqual(
    after.repos.map((r) => r.name),
    ["r1", "r2"],
  );
  // Second add is a no-op.
  const again = await runGroupAdd("g", "r2", { home });
  assert.deepEqual(
    again.repos.map((r) => r.name),
    ["r1", "r2"],
  );
  // Add a third repo to prove ordering is preserved by the group writer.
  const third = await runGroupAdd("g", "r3", { home });
  assert.deepEqual(
    third.repos.map((r) => r.name),
    ["r1", "r2", "r3"],
  );
});

test("runGroupAdd rejects unknown groups and unknown repos", async () => {
  const home = await scratch();
  await seedRegistry(home, ["r1"]);
  // Unknown group.
  await assert.rejects(runGroupAdd("nope", "r1", { home }), /not found/);
  // Unknown repo.
  await runGroupCreate("g", ["r1"], { home });
  await assert.rejects(runGroupAdd("g", "ghost", { home }), /unknown repo/);
});

test("runGroupRemove drops a member and is a no-op on non-members", async () => {
  const home = await scratch();
  await seedRegistry(home, ["r1", "r2"]);
  await runGroupCreate("g", ["r1", "r2"], { home });
  const after = await runGroupRemove("g", "r2", { home });
  assert.deepEqual(
    after.repos.map((r) => r.name),
    ["r1"],
  );
  // Removing again is a no-op.
  const still = await runGroupRemove("g", "r2", { home });
  assert.deepEqual(
    still.repos.map((r) => r.name),
    ["r1"],
  );
  // Empty groups are retained (not deleted implicitly).
  const empty = await runGroupRemove("g", "r1", { home });
  assert.deepEqual(empty.repos, []);
  const round = await readGroup("g", { home });
  assert.ok(round, "empty group should still exist on disk");
});

test("runGroupRemove rejects unknown groups", async () => {
  const home = await scratch();
  await assert.rejects(runGroupRemove("nope", "r1", { home }), /not found/);
});

test("runGroupShow returns the group entry (and null for missing)", async () => {
  const home = await scratch();
  await seedRegistry(home, ["r1"]);
  await runGroupCreate("g", ["r1"], { home, description: "hello" });
  const got = await runGroupShow("g", { home });
  assert.ok(got);
  assert.equal(got.name, "g");
  assert.equal(got.description, "hello");
  const missing = await runGroupShow("nope", { home });
  assert.equal(missing, null);
});

test("fuseGroupRuns merges per-repo lists via RRF, lex ties", () => {
  const runs = [
    {
      repoName: "a",
      results: [
        { nodeId: "n1", score: 3, name: "foo", kind: "Function", filePath: "a/foo.ts" },
        { nodeId: "n2", score: 2, name: "bar", kind: "Function", filePath: "a/bar.ts" },
      ],
    },
    {
      repoName: "b",
      results: [{ nodeId: "n1", score: 4, name: "foo", kind: "Function", filePath: "b/foo.ts" }],
    },
  ];
  const fused = fuseGroupRuns(runs, 5);
  // Top hit should be `b::n1` (only ranked 1st in one run) tied with `a::n1`
  // on RRF score — both get 1/(60+1). Tie break: repoName asc → a before b.
  assert.ok(fused.length >= 2);
  const first = fused[0];
  const second = fused[1];
  assert.ok(first && second);
  // Scores for rank 1 in each run are equal.
  assert.equal(first.score, second.score);
  assert.equal(first.repoName, "a");
  assert.equal(second.repoName, "b");
});

test("runGroupSyncCmd writes contracts.json for a two-repo group and is idempotent", async () => {
  const home = await scratch();
  const producerPath = join(home, "producer-repo");
  const consumerPath = join(home, "consumer-repo");
  await mkdir(producerPath, { recursive: true });
  await mkdir(consumerPath, { recursive: true });
  await writeFile(
    join(producerPath, "server.ts"),
    "app.get('/ping', (req, res) => res.json({}));",
    "utf8",
  );
  await writeFile(
    join(consumerPath, "client.ts"),
    "export async function ping() { return fetch('/ping'); }",
    "utf8",
  );
  await upsertRegistry(
    {
      name: "producer-repo",
      path: producerPath,
      indexedAt: "2026-04-23T00:00:00Z",
      nodeCount: 1,
      edgeCount: 1,
      lastCommit: "aaaa",
    },
    { home },
  );
  await upsertRegistry(
    {
      name: "consumer-repo",
      path: consumerPath,
      indexedAt: "2026-04-23T00:00:00Z",
      nodeCount: 1,
      edgeCount: 1,
      lastCommit: "bbbb",
    },
    { home },
  );
  await runGroupCreate("pair", ["producer-repo", "consumer-repo"], { home });

  const now = () => "2026-04-23T00:00:00.000Z";
  const r1 = await runGroupSyncCmd("pair", { home, now });
  const path = resolveGroupContractsPath("pair", home);
  assert.equal(r1.registryPath, path);
  const raw1 = await readFile(path, "utf8");
  assert.ok(raw1.includes('"GET /ping"'));
  assert.ok(raw1.includes('"crossLinks"'));
  assert.equal(r1.registry.crossLinks.length, 1);
  assert.equal(r1.registry.crossLinks[0]?.producer.repo, "producer-repo");
  assert.equal(r1.registry.crossLinks[0]?.consumer.repo, "consumer-repo");

  // Second run must produce byte-identical output given a stable `now`.
  await runGroupSyncCmd("pair", { home, now });
  const raw2 = await readFile(path, "utf8");
  assert.equal(raw1, raw2);
});

test("runGroupSyncCmd rejects unknown groups", async () => {
  const home = await scratch();
  await assert.rejects(runGroupSyncCmd("ghost", { home }), /group ghost not found/);
});
