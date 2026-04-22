import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { RepoResolveError, readRegistry, resolveRepo } from "./repo-resolver.js";

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
