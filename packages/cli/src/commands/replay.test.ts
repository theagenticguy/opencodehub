/**
 * Tests for `codehub replay <hash>`.
 *
 * Load-bearing invariants (success criteria E-C2 / AC-C3 / U2):
 *   - Unchanged inputs → reproduced:true, exit 0.
 *   - Tamper one BOM body byte → reproduced:false, names the drifted item,
 *     exit non-zero.
 *   - best_effort re-pack drift → reproduced:true (expectedDrift), exit 0.
 *   - strict re-pack drift → reproduced:false, exit non-zero.
 *   - No network in any path (we only read the pack dir on disk).
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildManifest, type PackManifest, serializeManifest } from "@opencodehub/pack";
import { recomputePackHash, replayVerdict, runReplay } from "./replay.js";

/**
 * Stage a real on-disk pack: write each BOM body, derive the manifest from
 * its actual file hashes, then write `manifest.json` into
 * `.codehub/packs/<packHash>/`. Returns { repoPath, hash, packDir, bodies }.
 */
async function stagePack(
  repoPath: string,
  opts: {
    determinismClass?: PackManifest["determinismClass"];
    tokenizerId?: string;
  } = {},
): Promise<{ hash: string; packDir: string; bodies: Record<string, string> }> {
  const bodies: Record<string, string> = {
    "skeleton.jsonl": '{"a":1}\n',
    "file-tree.jsonl": '{"b":2}\n',
    "deps.jsonl": '{"c":3}\n',
    "licenses.md": "# Licenses\n",
    "xrefs.jsonl": '{"d":4}\n',
    "ast-chunks.jsonl": '{"e":5}\n',
    "findings.jsonl": '{"f":6}\n',
  };
  const kinds: Record<string, PackManifest["files"][number]["kind"]> = {
    "skeleton.jsonl": "skeleton",
    "file-tree.jsonl": "file-tree",
    "deps.jsonl": "deps",
    "licenses.md": "licenses",
    "xrefs.jsonl": "xrefs",
    "ast-chunks.jsonl": "ast-chunks",
    "findings.jsonl": "findings",
  };
  const { createHash } = await import("node:crypto");
  const files = Object.entries(bodies).map(([path, body]) => ({
    kind: kinds[path] as PackManifest["files"][number]["kind"],
    path,
    fileHash: createHash("sha256").update(body).digest("hex"),
  }));
  const manifest = buildManifest({
    commit: "a".repeat(40),
    repoOriginUrl: "https://github.com/opencodehub/opencodehub.git",
    tokenizerId: opts.tokenizerId ?? "openai:o200k_base@tiktoken-0.8.0",
    determinismClass: opts.determinismClass ?? "strict",
    budgetTokens: 100_000,
    pins: { chonkieVersion: "0.0.10", duckdbVersion: "1.4.0", grammarCommits: {} },
    files,
  });
  const packDir = join(repoPath, ".codehub", "packs", manifest.packHash);
  await mkdir(packDir, { recursive: true });
  for (const [path, body] of Object.entries(bodies)) {
    await writeFile(join(packDir, path), body);
  }
  await writeFile(join(packDir, "manifest.json"), serializeManifest(manifest));
  return { hash: manifest.packHash, packDir, bodies };
}

test("runReplay reproduces an unchanged pack (exit 0)", async () => {
  const repo = await mkdtemp(join(tmpdir(), "och-replay-ok-"));
  try {
    const { hash } = await stagePack(repo);
    const r = await runReplay(hash, { repoPath: repo });
    assert.equal(r.reproduced, true);
    assert.equal(r.drifts.length, 0);
    assert.equal(replayVerdict(r).exitCode, 0);
    assert.match(replayVerdict(r).line, /reproduced/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runReplay names the drifted BOM item when one body byte is tampered (exit non-zero)", async () => {
  const repo = await mkdtemp(join(tmpdir(), "och-replay-tamper-"));
  try {
    const { hash, packDir } = await stagePack(repo);
    // Flip one byte of ast-chunks.jsonl.
    await writeFile(join(packDir, "ast-chunks.jsonl"), '{"e":99}\n');
    const r = await runReplay(hash, { repoPath: repo });
    assert.equal(r.reproduced, false);
    assert.equal(r.driftedItem, "ast-chunks.jsonl");
    assert.equal(r.expectedDrift, false);
    const v = replayVerdict(r);
    assert.equal(v.exitCode, 1);
    assert.match(v.line, /ast-chunks\.jsonl/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runReplay flags a missing BOM body as a hard drift", async () => {
  const repo = await mkdtemp(join(tmpdir(), "och-replay-missing-"));
  try {
    const { hash, packDir } = await stagePack(repo);
    await rm(join(packDir, "deps.jsonl"));
    const r = await runReplay(hash, { repoPath: repo });
    assert.equal(r.reproduced, false);
    assert.equal(r.driftedItem, "deps.jsonl");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runReplay treats a strict re-pack packHash mismatch as a hard failure", async () => {
  const repo = await mkdtemp(join(tmpdir(), "och-replay-strict-drift-"));
  try {
    const { hash } = await stagePack(repo, { determinismClass: "strict" });
    // Re-pack driver returns a manifest with a different packHash + a drifted file.
    const r = await runReplay(hash, {
      repoPath: repo,
      repack: async (m) =>
        buildManifest({
          commit: m.commit,
          repoOriginUrl: m.repoOriginUrl,
          tokenizerId: m.tokenizerId,
          determinismClass: m.determinismClass,
          budgetTokens: m.budgetTokens,
          pins: m.pins,
          files: m.files.map((f) =>
            f.path === "ast-chunks.jsonl" ? { ...f, fileHash: "9".repeat(64) } : f,
          ),
        }),
    });
    assert.equal(r.reproduced, false);
    assert.equal(r.driftedItem, "ast-chunks.jsonl");
    assert.equal(replayVerdict(r).exitCode, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runReplay treats a best_effort re-pack drift as EXPECTED (exit 0)", async () => {
  const repo = await mkdtemp(join(tmpdir(), "och-replay-besteffort-"));
  try {
    const { hash } = await stagePack(repo, {
      determinismClass: "best_effort",
      tokenizerId: "anthropic:claude@1",
    });
    const r = await runReplay(hash, {
      repoPath: repo,
      repack: async (m) =>
        buildManifest({
          commit: m.commit,
          repoOriginUrl: m.repoOriginUrl,
          tokenizerId: m.tokenizerId,
          determinismClass: m.determinismClass,
          budgetTokens: m.budgetTokens,
          pins: m.pins,
          files: m.files.map((f) =>
            f.path === "ast-chunks.jsonl" ? { ...f, fileHash: "9".repeat(64) } : f,
          ),
        }),
    });
    assert.equal(r.reproduced, true);
    assert.equal(r.expectedDrift, true);
    assert.equal(r.driftedItem, "ast-chunks.jsonl");
    const v = replayVerdict(r);
    assert.equal(v.exitCode, 0);
    assert.match(v.line, /best_effort drift/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runReplay reproduces with an identity re-pack driver (re-pack tier passes)", async () => {
  const repo = await mkdtemp(join(tmpdir(), "och-replay-repack-ok-"));
  try {
    const { hash } = await stagePack(repo);
    const r = await runReplay(hash, { repoPath: repo, repack: async (m) => m });
    assert.equal(r.reproduced, true);
    assert.equal(r.drifts.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runReplay raises a clear error when the pack dir is absent", async () => {
  const repo = await mkdtemp(join(tmpdir(), "och-replay-nopack-"));
  try {
    await assert.rejects(runReplay("c0ffee".repeat(8), { repoPath: repo }), /no pack at|code-pack/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("recomputePackHash re-derives the attested hash from manifest fields", async () => {
  const repo = await mkdtemp(join(tmpdir(), "och-replay-recompute-"));
  try {
    const { hash, packDir } = await stagePack(repo);
    const { readFile } = await import("node:fs/promises");
    const onDisk = await readFile(join(packDir, "manifest.json"), "utf8");
    // Round-trip the on-disk snake_case manifest through runReplay's parser is
    // internal; assert the public recompute path instead via a built manifest.
    const w = JSON.parse(onDisk) as Record<string, unknown>;
    assert.equal(w["pack_hash"], hash);
    // recomputePackHash must agree with the directory-name hash for an
    // untampered manifest (uses buildManifest, the trusted computation).
    const manifest = buildManifest({
      commit: "a".repeat(40),
      repoOriginUrl: "https://github.com/opencodehub/opencodehub.git",
      tokenizerId: "openai:o200k_base@tiktoken-0.8.0",
      determinismClass: "strict",
      budgetTokens: 100_000,
      pins: { chonkieVersion: "0.0.10", duckdbVersion: "1.4.0", grammarCommits: {} },
      files: [
        {
          kind: "skeleton",
          path: "skeleton.jsonl",
          fileHash: w_fileHash(onDisk, "skeleton.jsonl"),
        },
        {
          kind: "file-tree",
          path: "file-tree.jsonl",
          fileHash: w_fileHash(onDisk, "file-tree.jsonl"),
        },
        { kind: "deps", path: "deps.jsonl", fileHash: w_fileHash(onDisk, "deps.jsonl") },
        { kind: "licenses", path: "licenses.md", fileHash: w_fileHash(onDisk, "licenses.md") },
        { kind: "xrefs", path: "xrefs.jsonl", fileHash: w_fileHash(onDisk, "xrefs.jsonl") },
        {
          kind: "ast-chunks",
          path: "ast-chunks.jsonl",
          fileHash: w_fileHash(onDisk, "ast-chunks.jsonl"),
        },
        {
          kind: "findings",
          path: "findings.jsonl",
          fileHash: w_fileHash(onDisk, "findings.jsonl"),
        },
      ],
    });
    assert.equal(recomputePackHash(manifest), hash);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/** Pull a BOM body's recorded file_hash out of the on-disk snake_case manifest JSON. */
function w_fileHash(manifestJson: string, path: string): string {
  const w = JSON.parse(manifestJson) as { files: Array<{ path: string; file_hash: string }> };
  const f = w.files.find((x) => x.path === path);
  if (f === undefined) throw new Error(`no file ${path}`);
  return f.file_hash;
}
