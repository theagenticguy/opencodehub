/**
 * Happy-path test for `codehub setup --embeddings` wiring.
 *
 * Uses the public `runSetupEmbeddings` entry and a stub fetch + an override
 * pin manifest so we never hit the real HuggingFace CDN.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadableStream } from "node:stream/web";
import { describe, it } from "node:test";

import { ARCTIC_EMBED_XS_PINS } from "@opencodehub/embedder";

import { runSetupEmbeddings } from "./setup.js";

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function makeResponse(body: Uint8Array): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(body);
      controller.close();
    },
  });
  return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
    status: 200,
  });
}

describe("runSetupEmbeddings", () => {
  it("downloads every file for the fp32 variant and reports the summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "och-cli-setup-emb-"));
    try {
      // Build a tiny per-file body keyed by pin name; substitute our SHAs into
      // the manifest so the downloader's verification passes.
      const bodies = new Map<string, Uint8Array>();
      const originals = ARCTIC_EMBED_XS_PINS.fp32.files;
      const replaced = originals.map((f, idx) => {
        const body = new TextEncoder().encode(`pin-${idx}-${f.name}`);
        bodies.set(f.url, body);
        return {
          name: f.name,
          url: f.url,
          sizeBytes: body.length,
          sha256: sha256(body),
        };
      });

      const mutable = ARCTIC_EMBED_XS_PINS as unknown as {
        fp32: { variant: "fp32"; files: readonly (typeof replaced)[number][] };
      };
      const saved = mutable.fp32;
      mutable.fp32 = { variant: "fp32", files: replaced };

      const logs: string[] = [];
      try {
        const result = await runSetupEmbeddings({
          variant: "fp32",
          modelDir: dir,
          fetchImpl: async (input) => {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : (input as unknown as { url: string }).url;
            const body = bodies.get(url);
            if (body === undefined) {
              return new Response(null, { status: 404 });
            }
            return makeResponse(body);
          },
          log: (m) => {
            logs.push(m);
          },
          warn: (m) => {
            logs.push(m);
          },
        });
        assert.equal(result.downloaded, replaced.length);
        assert.equal(result.skipped, 0);
        assert.equal(result.modelDir, dir);
        // Every file lands on disk.
        for (const f of replaced) {
          const written = await readFile(join(dir, f.name));
          assert.equal(written.byteLength, f.sizeBytes);
        }
        // Success log includes the user-facing next-step hint.
        const combined = logs.join("\n");
        assert.match(combined, /Done/);
        assert.match(combined, /codehub analyze --embeddings/);
      } finally {
        mutable.fp32 = saved;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
