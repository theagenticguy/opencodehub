/**
 * Sanity tests for the pinned-weights manifest. No network access; these
 * assertions guard against accidental manifest edits that would break the
 * W2-A.2 downloader (`codehub setup --embeddings`).
 */

import { equal, match, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import { ARCTIC_EMBED_XS_PINS, ARCTIC_EMBED_XS_REPO, embedderModelId } from "./model-pins.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const HF_URL_RE = new RegExp(
  `^https://huggingface\\.co/Snowflake/snowflake-arctic-embed-xs/resolve/${ARCTIC_EMBED_XS_REPO.commit}/`,
);

describe("model-pins", () => {
  it("repo metadata is Apache-2.0 and pins a commit SHA", () => {
    equal(ARCTIC_EMBED_XS_REPO.license, "Apache-2.0");
    equal(ARCTIC_EMBED_XS_REPO.hfRepo, "Snowflake/snowflake-arctic-embed-xs");
    match(ARCTIC_EMBED_XS_REPO.commit, /^[0-9a-f]{40}$/);
  });

  it("fp32 variant ships one ONNX + four tokenizer files", () => {
    const names = ARCTIC_EMBED_XS_PINS.fp32.files.map((f) => f.name);
    equal(ARCTIC_EMBED_XS_PINS.fp32.files.length, 5);
    ok(names.includes("model.onnx"));
    ok(names.includes("tokenizer.json"));
    ok(names.includes("tokenizer_config.json"));
    ok(names.includes("config.json"));
    ok(names.includes("special_tokens_map.json"));
  });

  it("int8 variant swaps the ONNX file and reuses tokenizer pins", () => {
    const names = ARCTIC_EMBED_XS_PINS.int8.files.map((f) => f.name);
    ok(names.includes("model_int8.onnx"));
    ok(!names.includes("model.onnx"));
  });

  it("every pinned file has a 64-char sha256 and HF resolve URL", () => {
    for (const variant of ["fp32", "int8"] as const) {
      for (const f of ARCTIC_EMBED_XS_PINS[variant].files) {
        match(f.sha256, SHA256_RE, `${variant}/${f.name} sha256`);
        match(f.url, HF_URL_RE, `${variant}/${f.name} url`);
        ok(f.sizeBytes > 0, `${variant}/${f.name} sizeBytes`);
      }
    }
  });

  it("embedderModelId produces the string used by the storage layer", () => {
    equal(embedderModelId("fp32"), "snowflake-arctic-embed-xs/fp32");
    equal(embedderModelId("int8"), "snowflake-arctic-embed-xs/int8");
  });
});
