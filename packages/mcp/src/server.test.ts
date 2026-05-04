/**
 * Server-wide wiring tests.
 *
 * These sit above `tool-handlers.test.ts` (which exercises individual
 * tool handlers against a fake store) and assert ambient guarantees
 * about the shape of the built server itself — specifically, that it
 * advertises the right capability set and registers the right set of
 * prompts.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: private SDK field access in tests

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildServer } from "./server.js";

async function withEmptyHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(resolve(tmpdir(), "codehub-mcp-server-test-"));
  try {
    const regDir = resolve(home, ".codehub");
    await mkdir(regDir, { recursive: true });
    await writeFile(resolve(regDir, "registry.json"), "{}");
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("buildServer registers zero prompts — ListPrompts returns an empty set", async () => {
  await withEmptyHome(async (home) => {
    const running = buildServer({ home, silentEmbedderProbe: true });
    try {
      const withPrivate = running.server as unknown as {
        _registeredPrompts?: Record<string, unknown>;
      };
      const prompts = withPrivate._registeredPrompts ?? {};
      assert.deepEqual(Object.keys(prompts), []);
    } finally {
      await running.shutdown();
    }
  });
});
