import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  deriveRepoUri,
  normalizeRepoUri,
  RepoResolveError,
  readRegistry,
  resolveRepo,
} from "./repo-resolver.js";

async function withTmpHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeRegistry(home: string, data: Record<string, unknown>): Promise<void> {
  const dir = resolve(home, ".codehub");
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "registry.json"), JSON.stringify(data, null, 2));
}

test("readRegistry returns {} when file absent", async () => {
  await withTmpHome(async (home) => {
    const reg = await readRegistry({ home });
    assert.deepEqual(reg, {});
  });
});

test("readRegistry skips malformed entries but keeps valid ones", async () => {
  await withTmpHome(async (home) => {
    await writeRegistry(home, {
      good: {
        name: "good",
        path: "/tmp/good",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
      bad: { name: "bad" }, // missing path/indexedAt
    });
    const reg = await readRegistry({ home });
    assert.deepEqual(Object.keys(reg), ["good"]);
  });
});

test("resolveRepo throws NO_INDEX when registry is empty", async () => {
  await withTmpHome(async (home) => {
    await assert.rejects(
      () => resolveRepo(undefined, { home }),
      (err: unknown) => err instanceof RepoResolveError && err.code === "NO_INDEX",
    );
  });
});

test("resolveRepo returns the only repo when exactly one is registered", async () => {
  await withTmpHome(async (home) => {
    await writeRegistry(home, {
      solo: {
        name: "solo",
        path: "/tmp/solo",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
    });
    const r = await resolveRepo(undefined, { home, skipMeta: true });
    assert.equal(r.name, "solo");
  });
});

test("resolveRepo throws AMBIGUOUS_REPO when >1 repo registered and no name given", async () => {
  await withTmpHome(async (home) => {
    await writeRegistry(home, {
      beta: {
        name: "beta",
        path: "/tmp/beta",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
      alpha: {
        name: "alpha",
        path: "/tmp/alpha",
        indexedAt: "2026-04-18",
        nodeCount: 10,
        edgeCount: 20,
      },
    });
    await assert.rejects(
      () => resolveRepo(undefined, { home, skipMeta: true }),
      (err: unknown) => {
        if (!(err instanceof RepoResolveError)) return false;
        if (err.code !== "AMBIGUOUS_REPO") return false;
        // Hint must name both registered repos so the agent can pick.
        return err.hint.includes("alpha") && err.hint.includes("beta");
      },
    );
  });
});

test("resolveRepo resolves by explicit name when >1 repo registered", async () => {
  await withTmpHome(async (home) => {
    await writeRegistry(home, {
      beta: {
        name: "beta",
        path: "/tmp/beta",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
      alpha: {
        name: "alpha",
        path: "/tmp/alpha",
        indexedAt: "2026-04-18",
        nodeCount: 10,
        edgeCount: 20,
      },
    });
    const r = await resolveRepo("beta", { home, skipMeta: true });
    assert.equal(r.name, "beta");
  });
});

test("resolveRepo throws NOT_FOUND for unknown name", async () => {
  await withTmpHome(async (home) => {
    await writeRegistry(home, {
      alpha: {
        name: "alpha",
        path: "/tmp/alpha",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
    });
    await assert.rejects(
      () => resolveRepo("zeta", { home }),
      (err: unknown) => err instanceof RepoResolveError && err.code === "NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// repo_uri alias + structured AMBIGUOUS_REPO payload.
// ---------------------------------------------------------------------------

test("deriveRepoUri passes through URI-shaped names and hashes local-only paths", () => {
  assert.equal(
    deriveRepoUri({
      name: "github.com/org/repo",
      path: "/any/where",
      indexedAt: "",
      nodeCount: 0,
      edgeCount: 0,
    }),
    "github.com/org/repo",
  );
  const derived = deriveRepoUri({
    name: "bare-name",
    path: "/tmp/bare-name",
    indexedAt: "",
    nodeCount: 0,
    edgeCount: 0,
  });
  assert.match(derived, /^local:[0-9a-f]{12}$/);
  // Deterministic — same path always yields the same URI.
  const again = deriveRepoUri({
    name: "bare-name",
    path: "/tmp/bare-name",
    indexedAt: "",
    nodeCount: 0,
    edgeCount: 0,
  });
  assert.equal(derived, again);
});

test("normalizeRepoUri strips protocol, .git, and lowercases host", () => {
  assert.equal(normalizeRepoUri("https://GitHub.com/Org/Repo.git"), "github.com/Org/Repo");
  assert.equal(normalizeRepoUri("git@github.com:Org/Repo.git"), "github.com/Org/Repo");
  assert.equal(normalizeRepoUri("github.com/Org/Repo"), "github.com/Org/Repo");
});

test("resolveRepo accepts repo_uri alias for a URI-named registry entry", async () => {
  await withTmpHome(async (home) => {
    await writeRegistry(home, {
      "github.com/org/frontend": {
        name: "github.com/org/frontend",
        path: "/tmp/frontend",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
      "github.com/org/backend": {
        name: "github.com/org/backend",
        path: "/tmp/backend",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
    });
    const r = await resolveRepo(
      { repo_uri: "https://github.com/org/frontend.git" },
      { home, skipMeta: true },
    );
    assert.equal(r.name, "github.com/org/frontend");
  });
});

test("resolveRepo prefers repo_uri when both repo and repo_uri are provided", async () => {
  await withTmpHome(async (home) => {
    await writeRegistry(home, {
      "github.com/org/frontend": {
        name: "github.com/org/frontend",
        path: "/tmp/frontend",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
      "github.com/org/backend": {
        name: "github.com/org/backend",
        path: "/tmp/backend",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
    });
    const r = await resolveRepo(
      // `repo` names backend but `repo_uri` names frontend — uri wins.
      { repo: "github.com/org/backend", repo_uri: "github.com/org/frontend" },
      { home, skipMeta: true },
    );
    assert.equal(r.name, "github.com/org/frontend");
  });
});

test("resolveRepo resolves a local: repo_uri via path hashing", async () => {
  await withTmpHome(async (home) => {
    await writeRegistry(home, {
      alpha: {
        name: "alpha",
        path: "/tmp/alpha",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
      beta: {
        name: "beta",
        path: "/tmp/beta",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
    });
    const wanted = deriveRepoUri({
      name: "alpha",
      path: "/tmp/alpha",
      indexedAt: "",
      nodeCount: 0,
      edgeCount: 0,
    });
    const r = await resolveRepo({ repo_uri: wanted }, { home, skipMeta: true });
    assert.equal(r.name, "alpha");
  });
});

test("resolveRepo AMBIGUOUS_REPO carries structured choices[] and totalMatches", async () => {
  await withTmpHome(async (home) => {
    await writeRegistry(home, {
      beta: {
        name: "beta",
        path: "/tmp/beta",
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 2,
      },
      alpha: {
        name: "alpha",
        path: "/tmp/alpha",
        indexedAt: "2026-04-18",
        nodeCount: 10,
        edgeCount: 20,
      },
    });
    await assert.rejects(
      () => resolveRepo(undefined, { home, skipMeta: true }),
      (err: unknown) => {
        if (!(err instanceof RepoResolveError)) return false;
        if (err.code !== "AMBIGUOUS_REPO") return false;
        if (err.ambiguous === undefined) return false;
        if (err.ambiguous.totalMatches !== 2) return false;
        if (err.ambiguous.choices.length !== 2) return false;
        const uris = err.ambiguous.choices.map((c) => c.repo_uri).sort();
        // Both local: entries — hashed from each distinct path.
        return uris.every((u) => u.startsWith("local:"));
      },
    );
  });
});

test("resolveRepo AMBIGUOUS_REPO includes all matches when N ≤ 10", async () => {
  await withTmpHome(async (home) => {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < 7; i += 1) {
      entries[`r${i}`] = {
        name: `r${i}`,
        path: `/tmp/r${i}`,
        indexedAt: "2026-04-18",
        nodeCount: 1,
        edgeCount: 0,
      };
    }
    await writeRegistry(home, entries);
    await assert.rejects(
      () => resolveRepo(undefined, { home, skipMeta: true }),
      (err: unknown) => {
        if (!(err instanceof RepoResolveError)) return false;
        if (err.code !== "AMBIGUOUS_REPO") return false;
        if (err.ambiguous === undefined) return false;
        // The resolver always emits the FULL list; the envelope-builder
        // applies the 10-entry cap (see error-envelope.test.ts).
        return err.ambiguous.totalMatches === 7 && err.ambiguous.choices.length === 7;
      },
    );
  });
});
