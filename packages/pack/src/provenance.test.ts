/**
 * Regression test for B1 — the MCP-vs-CLI packHash divergence
 * (injection-seam / silent-hollow class).
 *
 * The MCP `pack_codebase` tool used to call `generatePack({...}, { store })`,
 * omitting the provenance bundle (commit, repoOriginUrl, chunkerFiles,
 * grammarCommits) that the CLI wires via `resolvePackProvenance`. Because the
 * manifest preimage binds `commit` + per-file `fileHash` + `grammar_commits`,
 * the two entry points produced DIFFERENT `packHash` values for the identical
 * repo + commit, and the MCP pack shipped an empty `ast-chunks.jsonl` and a
 * byte-range-free `context-bom.json` — a hollow pack that still exited 0.
 *
 * `resolvePackProvenance` now lives in `@opencodehub/pack` so BOTH entry points
 * call it. These tests pin the contract at the source:
 *   1. resolvePackProvenance reads real commit/originUrl/files from the graph.
 *   2. a pack built WITH provenance has a different packHash than one built
 *      WITHOUT it (proving the omission was observable, not cosmetic).
 *   3. two packs built WITH the same provenance share a packHash (the CLI-path
 *      == MCP-path invariant the fix guarantees).
 *
 * The chonkie loader is a deterministic stub so the test never depends on the
 * real `@chonkiejs/core` install.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type GraphNode, sha256Hex } from "@opencodehub/core-types";
import type { IGraphStore, ListNodesOptions, Store } from "@opencodehub/storage";
import { type GeneratePackInternalOpts, generatePack } from "./index.js";
import { resolvePackProvenance } from "./provenance.js";

const COMMIT = "a".repeat(40);
const ORIGIN = "https://github.com/example/repo";

/**
 * A minimal graph stub exposing the `listNodes({kinds})` finder
 * `resolvePackProvenance` uses. Returns one `Repo` node (commit + origin) and
 * two `File` nodes whose `contentHash` matches the bytes written to disk.
 */
function makeProvenanceStore(fileHashes: Record<string, string>): IGraphStore {
  const nodes: GraphNode[] = [
    {
      id: "repo:example" as GraphNode["id"],
      kind: "Repo",
      name: "repo",
      filePath: ".",
      commitSha: COMMIT,
      originUrl: ORIGIN,
      defaultBranch: "main",
      group: null,
    } as unknown as GraphNode,
    {
      id: "file:src/a.ts" as GraphNode["id"],
      kind: "File",
      name: "a.ts",
      filePath: "src/a.ts",
      language: "typescript",
      contentHash: fileHashes["src/a.ts"],
    } as unknown as GraphNode,
    {
      id: "file:src/b.ts" as GraphNode["id"],
      kind: "File",
      name: "b.ts",
      filePath: "src/b.ts",
      language: "typescript",
      contentHash: fileHashes["src/b.ts"],
    } as unknown as GraphNode,
  ];

  const listNodes = async (opts?: ListNodesOptions): Promise<readonly GraphNode[]> => {
    const kinds = opts?.kinds;
    if (kinds === undefined) return nodes;
    return nodes.filter((n) => kinds.includes(n.kind));
  };

  // Only the finders resolvePackProvenance + the BOM bodies touch are real;
  // everything else throws so an accidental new dependency is caught loudly.
  return new Proxy({ listNodes } as unknown as IGraphStore, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (prop === "listNodesByKind") {
        return async (kind: string) => (await listNodes({ kinds: [kind] })) as unknown;
      }
      if (
        prop === "listEdges" ||
        prop === "listEdgesByType" ||
        prop === "listFindings" ||
        prop === "listDependencies" ||
        prop === "listRoutes"
      ) {
        return async () => [];
      }
      return () => {
        throw new Error(`unexpected IGraphStore.${String(prop)} call in provenance test`);
      };
    },
  });
}

const CHONKIE_STUB: GeneratePackInternalOpts["chonkieLoader"] = async () => ({
  version: "0.0.9",
  CodeChunker: {
    create: async () => ({
      chunk(text: string) {
        return [{ text, startIndex: 0, endIndex: text.length, tokenCount: 1 }];
      },
    }),
  },
});

const COMMON_OPTS = {
  repoPath: "", // filled per-run with the temp repo dir
  budgetTokens: 20_000,
  tokenizerId: "openai:o200k_base@tiktoken-0.8.0",
} as const;

async function seedRepo(): Promise<{ repoPath: string; hashes: Record<string, string> }> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "pack-prov-repo-"));
  const bytesA = new TextEncoder().encode("export const a = 1;\n");
  const bytesB = new TextEncoder().encode("export const b = 2;\n");
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, "src/a.ts"), bytesA);
  await writeFile(path.join(repoPath, "src/b.ts"), bytesB);
  return {
    repoPath,
    hashes: { "src/a.ts": sha256Hex(bytesA), "src/b.ts": sha256Hex(bytesB) },
  };
}

function composedStore(graph: IGraphStore): Store {
  return {
    graph,
    temporal: graph as unknown as Store["temporal"],
    graphFile: ":memory:",
    temporalFile: ":memory:",
    close: async () => {},
  };
}

test("resolvePackProvenance reads real commit + origin + files from the graph", async () => {
  const { repoPath, hashes } = await seedRepo();
  try {
    const graph = makeProvenanceStore(hashes);
    const prov = await resolvePackProvenance(graph, repoPath);
    assert.equal(prov.commit, COMMIT, "commit must come from the Repo node");
    assert.equal(prov.repoOriginUrl, ORIGIN, "origin must come from the Repo node");
    assert.equal(prov.chunkerFiles.length, 2, "both hash-verified files are collected");
    const paths = prov.chunkerFiles.map((f) => f.path).sort();
    assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("B1: pack WITH provenance diverges from pack WITHOUT it (the MCP hollow-pack bug)", async () => {
  const { repoPath, hashes } = await seedRepo();
  const outWith = await mkdtemp(path.join(tmpdir(), "pack-prov-with-"));
  const outWithout = await mkdtemp(path.join(tmpdir(), "pack-prov-without-"));
  try {
    const graph = makeProvenanceStore(hashes);
    const prov = await resolvePackProvenance(graph, repoPath);

    // WITH provenance — what the CLI does, and what the MCP tool does after the fix.
    const withManifest = await generatePack(
      { ...COMMON_OPTS, repoPath, outDir: outWith },
      { store: composedStore(graph), chonkieLoader: CHONKIE_STUB, ...prov },
    );

    // WITHOUT provenance — the old MCP `{ store }`-only call. commit="" and
    // chunkerFiles=[] default in, so ast-chunks is empty and the hash differs.
    const withoutManifest = await generatePack(
      { ...COMMON_OPTS, repoPath, outDir: outWithout },
      { store: composedStore(graph), chonkieLoader: CHONKIE_STUB },
    );

    assert.notEqual(
      withManifest.packHash,
      withoutManifest.packHash,
      "omitting provenance MUST change the packHash — otherwise the MCP hollow pack would be indistinguishable from a real one",
    );

    // The hollow pack carries no commit; the real one carries the indexed commit.
    assert.equal(withManifest.commit, COMMIT);
    assert.equal(withoutManifest.commit, "");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
    await rm(outWith, { recursive: true, force: true });
    await rm(outWithout, { recursive: true, force: true });
  }
});

test("B1: two packs built with the same provenance share a packHash (CLI-path == MCP-path)", async () => {
  const { repoPath, hashes } = await seedRepo();
  const outA = await mkdtemp(path.join(tmpdir(), "pack-prov-a-"));
  const outB = await mkdtemp(path.join(tmpdir(), "pack-prov-b-"));
  try {
    const graph = makeProvenanceStore(hashes);
    // Resolve provenance twice, independently, to mimic two separate entry points.
    const provCli = await resolvePackProvenance(graph, repoPath);
    const provMcp = await resolvePackProvenance(graph, repoPath);

    const a = await generatePack(
      { ...COMMON_OPTS, repoPath, outDir: outA },
      { store: composedStore(graph), chonkieLoader: CHONKIE_STUB, ...provCli },
    );
    const b = await generatePack(
      { ...COMMON_OPTS, repoPath, outDir: outB },
      { store: composedStore(graph), chonkieLoader: CHONKIE_STUB, ...provMcp },
    );

    assert.equal(a.packHash, b.packHash, "same provenance ⇒ same packHash across entry points");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
    await rm(outA, { recursive: true, force: true });
    await rm(outB, { recursive: true, force: true });
  }
});
