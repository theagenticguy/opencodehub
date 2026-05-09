/**
 * Tests for `generateSkills`.
 *
 * Post AC-A-6e the generator consumes a typed-finder surface
 * (`Pick<IGraphStore, "listNodesByKind" | "listNodes" |
 * "listNodesByEntryPoint" | "listEdgesByType">`). The fake store below
 * implements those four methods over an in-memory fixture so the tests
 * exercise the real code path down to the markdown renderer and the
 * filesystem writer without standing up DuckDB.
 */

import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  CodeRelation,
  EdgeId,
  GraphNode,
  NodeId,
  NodeKind,
  RelationType,
} from "@opencodehub/core-types";
import { generateSkills, type SkillsGenStore, sanitizeSlug } from "./skills-gen.js";

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

interface FakeCommunity {
  readonly id: string;
  readonly name: string;
  readonly symbolCount: number;
  readonly inferredLabel?: string;
  readonly keywords?: readonly string[];
}

interface FakeNode {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine?: number;
}

interface FakeProcess {
  readonly id: string;
  readonly entryPointId: string;
}

interface FakeEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
}

interface Fixture {
  readonly communities: readonly FakeCommunity[];
  readonly nodes: readonly FakeNode[];
  readonly processes: readonly FakeProcess[];
  readonly edges: readonly FakeEdge[];
}

// ---------------------------------------------------------------------------
// Fake store — implements the four typed finders the generator needs over an
// in-memory fixture. The legacy SQL-dispatch fake was retired with AC-A-6e;
// matching the production interface keeps tests honest about which finders
// the generator actually calls.
// ---------------------------------------------------------------------------

function makeFakeStore(fixture: Fixture): SkillsGenStore {
  // Promote fixture rows into the typed graph shape the finders return.
  const communityNodes: GraphNode[] = fixture.communities.map(
    (c) =>
      ({
        id: c.id as NodeId,
        kind: "Community",
        name: c.name,
        filePath: "",
        symbolCount: c.symbolCount,
        ...(c.inferredLabel !== undefined ? { inferredLabel: c.inferredLabel } : {}),
        keywords: c.keywords ?? [],
      }) as unknown as GraphNode,
  );
  const processNodes: GraphNode[] = fixture.processes.map(
    (p, i) =>
      ({
        id: `Process:test:${i}` as NodeId,
        kind: "Process",
        name: `process-${i}`,
        filePath: "",
        entryPointId: p.entryPointId,
      }) as unknown as GraphNode,
  );
  const memberNodes: GraphNode[] = fixture.nodes.map(
    (n) =>
      ({
        id: n.id as NodeId,
        kind: n.kind as NodeKind,
        name: n.name,
        filePath: n.filePath,
        ...(n.startLine !== undefined ? { startLine: n.startLine } : {}),
      }) as unknown as GraphNode,
  );
  const allNodesById = new Map<string, GraphNode>();
  for (const arr of [communityNodes, processNodes, memberNodes]) {
    for (const n of arr) allNodesById.set(n.id, n);
  }

  // Promote fixture edges into typed `CodeRelation` rows.
  const edges: CodeRelation[] = fixture.edges.map((e, i) => ({
    id: `edge:${i}` as EdgeId,
    from: e.fromId as NodeId,
    to: e.toId as NodeId,
    type: e.type as RelationType,
    confidence: 1,
  }));

  return {
    listNodesByKind: async <K extends NodeKind>(kind: K) => {
      if (kind === "Community") return communityNodes as unknown as readonly GraphNode[] as never;
      if (kind === "Process") return processNodes as unknown as readonly GraphNode[] as never;
      return [] as never;
    },
    listNodes: async (opts) => {
      if (opts?.ids === undefined) return [];
      const out: GraphNode[] = [];
      for (const id of opts.ids) {
        const hit = allNodesById.get(id);
        if (hit) out.push(hit);
      }
      return out;
    },
    listNodesByEntryPoint: async () => [],
    listEdgesByType: async (type: RelationType, opts) => {
      const fromFilter = opts?.fromIds ? new Set(opts.fromIds.map((s) => String(s))) : undefined;
      const toFilter = opts?.toIds ? new Set(opts.toIds.map((s) => String(s))) : undefined;
      return edges.filter((e) => {
        if (e.type !== type) return false;
        if (fromFilter && !fromFilter.has(e.from)) return false;
        if (toFilter && !toFilter.has(e.to)) return false;
        return true;
      });
    },
  };
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-skills-"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fnNode(id: string, overrides: Partial<FakeNode> = {}): FakeNode {
  return {
    id: `Function:${id}.ts:${id}`,
    name: id,
    kind: "Function",
    filePath: `${id}.ts`,
    startLine: 1,
    ...overrides,
  };
}

function community(id: string, overrides: Partial<FakeCommunity> = {}): FakeCommunity {
  return {
    id: `Community:<global>:community-${id}`,
    name: `community-${id}`,
    symbolCount: 10,
    ...overrides,
  };
}

function memberEdge(symbol: FakeNode, c: FakeCommunity): FakeEdge {
  return { fromId: symbol.id, toId: c.id, type: "MEMBER_OF" };
}

/** Tiny helper to dodge biome's non-null-assertion rule in fixture wiring. */
function at<T>(arr: readonly T[], idx: number): T {
  const v = arr[idx];
  if (v === undefined) throw new Error(`fixture index ${idx} out of range (len=${arr.length})`);
  return v;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("generateSkills emits one SKILL.md per significant community", async () => {
  const repoPath = await scratch();

  // Community A — 5 symbols, labeled "auth-session".
  const commA = community("a", {
    symbolCount: 5,
    inferredLabel: "auth-session",
    keywords: ["auth", "session", "token"],
  });
  const aMembers = [
    fnNode("login"),
    fnNode("logout"),
    fnNode("issueToken", { startLine: 10 }),
    fnNode("revokeToken"),
    fnNode("refreshSession"),
  ];

  // Community B — 10 symbols, labeled "payments-checkout".
  const commB = community("b", {
    symbolCount: 10,
    inferredLabel: "payments-checkout",
    keywords: ["payment", "checkout"],
  });
  const bMembers = Array.from({ length: 10 }, (_, i) =>
    fnNode(`pay${i}`, { startLine: (i + 1) * 5 }),
  );

  const fixture: Fixture = {
    communities: [commA, commB],
    nodes: [...aMembers, ...bMembers],
    processes: [{ id: "Process:a.ts:process-login", entryPointId: at(aMembers, 0).id }],
    edges: [
      ...aMembers.map((m) => memberEdge(m, commA)),
      ...bMembers.map((m) => memberEdge(m, commB)),
      // Give community B some out-degree so the fallback path is exercised.
      { fromId: at(bMembers, 2).id, toId: at(bMembers, 3).id, type: "CALLS" },
      { fromId: at(bMembers, 2).id, toId: at(bMembers, 4).id, type: "CALLS" },
      { fromId: at(bMembers, 5).id, toId: at(bMembers, 6).id, type: "CALLS" },
    ],
  };

  const store = makeFakeStore(fixture);
  const count = await generateSkills(store, repoPath);
  assert.equal(count, 2);

  const skillsDir = join(repoPath, ".codehub", "skills");
  const dirs = (await readdir(skillsDir)).sort();
  assert.deepEqual(dirs, ["auth-session", "payments-checkout"]);

  const authBody = await readFile(join(skillsDir, "auth-session", "SKILL.md"), "utf8");
  assert.ok(authBody.startsWith("---\nname: auth-session\n"));
  assert.ok(authBody.includes("description: auth-session. auth, session, token."));
  assert.ok(authBody.includes("# auth-session"));
  assert.ok(authBody.includes("5 symbols"));
  // `login` is a Process entry-point head, so it must be listed as an EP.
  assert.ok(authBody.includes("`login`"));
  assert.ok(authBody.includes("## Entry points"));
  assert.ok(authBody.includes("## Members"));

  const payBody = await readFile(join(skillsDir, "payments-checkout", "SKILL.md"), "utf8");
  // No Process heads → top-5 by out-degree fallback. pay2 has 2 calls, pay5 has 1.
  assert.ok(payBody.includes("`pay2`"));
  assert.ok(payBody.includes("`pay5`"));
});

test("communities below the min-symbol floor are skipped", async () => {
  const repoPath = await scratch();
  const small = community("tiny", { symbolCount: 3 });
  const big = community("big", { symbolCount: 5, inferredLabel: "big-cluster" });
  const tinyMembers = [fnNode("t1"), fnNode("t2"), fnNode("t3")];
  const bigMembers = [fnNode("b1"), fnNode("b2"), fnNode("b3"), fnNode("b4"), fnNode("b5")];
  const fixture: Fixture = {
    communities: [small, big],
    nodes: [...tinyMembers, ...bigMembers],
    processes: [],
    edges: [
      ...tinyMembers.map((m) => memberEdge(m, small)),
      ...bigMembers.map((m) => memberEdge(m, big)),
    ],
  };
  const count = await generateSkills(makeFakeStore(fixture), repoPath);
  assert.equal(count, 1);

  const dirs = await readdir(join(repoPath, ".codehub", "skills"));
  assert.deepEqual(dirs, ["big-cluster"]);
});

test("slug collisions are resolved with -2, -3 suffixes", async () => {
  const repoPath = await scratch();
  const commA = community("a", { symbolCount: 6, inferredLabel: "payments" });
  const commB = community("b", { symbolCount: 6, inferredLabel: "payments" });
  const commC = community("c", { symbolCount: 6, inferredLabel: "Payments!" });
  const aMembers = Array.from({ length: 6 }, (_, i) => fnNode(`a${i}`));
  const bMembers = Array.from({ length: 6 }, (_, i) => fnNode(`b${i}`));
  const cMembers = Array.from({ length: 6 }, (_, i) => fnNode(`c${i}`));
  const fixture: Fixture = {
    communities: [commA, commB, commC],
    nodes: [...aMembers, ...bMembers, ...cMembers],
    processes: [],
    edges: [
      ...aMembers.map((m) => memberEdge(m, commA)),
      ...bMembers.map((m) => memberEdge(m, commB)),
      ...cMembers.map((m) => memberEdge(m, commC)),
    ],
  };
  const count = await generateSkills(makeFakeStore(fixture), repoPath);
  assert.equal(count, 3);
  const dirs = (await readdir(join(repoPath, ".codehub", "skills"))).sort();
  assert.deepEqual(dirs, ["payments", "payments-2", "payments-3"]);
});

test("writing to a read-only dir logs and continues without aborting", async () => {
  // Skip on root-like environments where chmod 0o555 on a dir is still writable.
  if (process.getuid?.() === 0) return;

  const repoPath = await scratch();
  // Pre-create .codehub/skills as read-only so the generator must create
  // per-skill subdirs inside a locked parent — this should fail cleanly.
  const skillsDir = join(repoPath, ".codehub", "skills");
  await mkdir(skillsDir, { recursive: true });
  try {
    await chmod(skillsDir, 0o555);
  } catch {
    return; // platform doesn't support POSIX perms; skip quietly
  }

  // Verify the chmod actually took effect — otherwise the rest of the test
  // is silently a no-op.
  const info = await stat(skillsDir);
  if ((info.mode & 0o200) !== 0) {
    // Directory is still writable despite chmod — bail so the assertion
    // below doesn't become a false negative.
    await chmod(skillsDir, 0o755);
    return;
  }

  const commA = community("a", { symbolCount: 5, inferredLabel: "locked" });
  const aMembers = Array.from({ length: 5 }, (_, i) => fnNode(`a${i}`));
  const fixture: Fixture = {
    communities: [commA],
    nodes: aMembers,
    processes: [],
    edges: aMembers.map((m) => memberEdge(m, commA)),
  };

  const logged: string[] = [];
  let threw = false;
  try {
    const count = await generateSkills(makeFakeStore(fixture), repoPath, {
      log: (m) => logged.push(m),
    });
    assert.equal(count, 0);
  } catch {
    threw = true;
  }
  // Restore permissions so mkdtemp cleanup works in CI.
  await chmod(skillsDir, 0o755);

  assert.equal(threw, false, "generateSkills must not throw on per-skill write failure");
  assert.ok(
    logged.some((m) => m.includes("failed to write SKILL.md")),
    `expected at least one failure log, got: ${JSON.stringify(logged)}`,
  );
});

test("sanitizeSlug strips punctuation and lowercases", () => {
  assert.equal(sanitizeSlug("Auth Session!"), "auth-session");
  assert.equal(sanitizeSlug("--edge--case--"), "edge-case");
  assert.equal(sanitizeSlug("123-valid"), "123-valid");
  assert.equal(sanitizeSlug(""), "community");
  assert.equal(sanitizeSlug("!!!"), "community");
});
