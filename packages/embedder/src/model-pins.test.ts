/**
 * Sanity tests for the pinned-weights manifest. No network access; these
 * assertions guard against accidental manifest edits that would break
 * `codehub setup --embeddings`.
 */

import { equal, match, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import { embedderModelId, F2LLM_V2_80M_PINS, F2LLM_V2_80M_REPO } from "./model-pins.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
// The exported ONNX + tokenizer artifacts are hosted as GitHub release assets
// on the opencodehub repo (NOT upstream Hugging Face — the export bakes
// pooling + L2 norm into the graph and does not exist upstream).
const RELEASE_URL_RE = new RegExp(
  `^https://github\\.com/theagenticguy/opencodehub/releases/download/${F2LLM_V2_80M_REPO.release}/`,
);

describe("model-pins", () => {
  it("repo metadata is Apache-2.0 and attributes the upstream + release", () => {
    equal(F2LLM_V2_80M_REPO.license, "Apache-2.0");
    equal(F2LLM_V2_80M_REPO.upstream, "codefuse-ai/F2LLM-v2-80M");
    equal(F2LLM_V2_80M_REPO.release, "embed-v1");
  });

  it("fp32 variant ships one ONNX + two tokenizer files", () => {
    const names = F2LLM_V2_80M_PINS.fp32.files.map((f) => f.name);
    equal(F2LLM_V2_80M_PINS.fp32.files.length, 3);
    ok(names.includes("model.onnx"));
    ok(names.includes("tokenizer.json"));
    ok(names.includes("tokenizer_config.json"));
    // The export omits config.json / special_tokens_map.json — pooling + norm
    // are in-graph, so they are not fetched.
    ok(!names.includes("config.json"));
    ok(!names.includes("special_tokens_map.json"));
  });

  it("int8 variant swaps the ONNX file and reuses tokenizer pins", () => {
    const names = F2LLM_V2_80M_PINS.int8.files.map((f) => f.name);
    equal(F2LLM_V2_80M_PINS.int8.files.length, 3);
    ok(names.includes("model_int8.onnx"));
    ok(!names.includes("model.onnx"));
    ok(names.includes("tokenizer.json"));
    ok(names.includes("tokenizer_config.json"));
  });

  it("every pinned file has a 64-char sha256 and GitHub release URL", () => {
    for (const variant of ["fp32", "int8"] as const) {
      for (const f of F2LLM_V2_80M_PINS[variant].files) {
        match(f.sha256, SHA256_RE, `${variant}/${f.name} sha256`);
        match(f.url, RELEASE_URL_RE, `${variant}/${f.name} url`);
        ok(f.sizeBytes > 0, `${variant}/${f.name} sizeBytes`);
      }
    }
  });

  it("pins the exact fp32 model + tokenizer sizes and hashes", () => {
    const model = F2LLM_V2_80M_PINS.fp32.files.find((f) => f.name === "model.onnx");
    ok(model !== undefined);
    equal(model.sizeBytes, 320708733);
    equal(model.sha256, "9347f761e1420e61c477b56616b3b4f2d2ee80d94747fd6cdde9a03b4c9176bc");

    const tok = F2LLM_V2_80M_PINS.fp32.files.find((f) => f.name === "tokenizer.json");
    ok(tok !== undefined);
    equal(tok.sizeBytes, 11423359);
    equal(tok.sha256, "7dd49a6a008054ecbf11f1568ea9244e99ca8a44fe47e883d1bb9915c3042705");

    const tokCfg = F2LLM_V2_80M_PINS.fp32.files.find((f) => f.name === "tokenizer_config.json");
    ok(tokCfg !== undefined);
    equal(tokCfg.sizeBytes, 378);
    equal(tokCfg.sha256, "3dbc087db36f09c0c359618cbfcebb4b3aed6d8438951c037789b5a0fdc099af");
  });

  it("pins the exact int8 model size and hash", () => {
    const model = F2LLM_V2_80M_PINS.int8.files.find((f) => f.name === "model_int8.onnx");
    ok(model !== undefined);
    equal(model.sizeBytes, 80699171);
    equal(model.sha256, "302845905e9273a1dd0fb4c670dcd12d16ad35e9522f518aa45a74da4d6ec5b8");
  });

  it("embedderModelId produces the string used by the storage layer", () => {
    equal(embedderModelId("fp32"), "f2llm-v2-80m/fp32");
    equal(embedderModelId("int8"), "f2llm-v2-80m/int8");
  });
});
