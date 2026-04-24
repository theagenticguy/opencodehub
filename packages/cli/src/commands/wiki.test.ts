/**
 * `codehub wiki` CLI tests.
 *
 * Focus: the `--llm` gating contract between the CLI and
 * `@opencodehub/analysis`. Pipeline-level assertions (page content, output
 * layout, determinism) live in `@opencodehub/analysis`' wiki tests; here we
 * only cover the CLI surface.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runWiki } from "./wiki.js";

test("runWiki: --llm + --offline rejects with a clear error before opening the store", async () => {
  await assert.rejects(
    () =>
      runWiki({
        output: "/tmp/does-not-matter",
        llm: true,
        offline: true,
      }),
    /summarizer requires network|remove --offline or drop --llm/,
  );
});
