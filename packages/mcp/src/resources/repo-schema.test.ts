/**
 * Behavioural test for the `codehub://repo/{name}/schema` MCP resource.
 *
 * Guards the D15 staleness fix: the `nodes:` roster is now single-sourced from
 * `@opencodehub/core-types` (73 logical columns) instead of the truncated
 * 26-entry local literal that silently rotted. Asserts the emitted YAML
 * advertises the full 73 node columns and 7 relation columns, and that the
 * count matches the canonical `NODE_COLUMNS` length so the two can never drift.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NODE_COLUMNS, RELATION_COLUMNS } from "@opencodehub/core-types";
import { getResourceHandler, makeFakeGraphStore, withMcpHarness } from "../test-utils.js";
import { registerRepoSchemaResource } from "./repo-schema.js";
import type { ResourceContext } from "./repos.js";

test("repo-schema: advertises the full 73 node columns and 7 relation columns", async () => {
  await withMcpHarness(
    {
      tmpPrefix: "codehub-schema-test-",
      serverCapabilities: { resources: {} },
      storeFactory: () => makeFakeGraphStore({ nodes: [], edges: [] }),
    },
    async ({ server, pool, home, repoName }) => {
      const ctx: ResourceContext = { pool, home };
      registerRepoSchemaResource(server, ctx);
      const handler = getResourceHandler(server, "repo-schema");
      const uri = new URL(`codehub://repo/${encodeURIComponent(repoName)}/schema`);
      const result = await handler(uri, { name: repoName }, {});
      const text = (result.contents[0] as { text: string }).text;

      // Count the `nodes:` list items: they are the `    - <col>` lines that
      // sit under the `  nodes:` block and before `  relations:`.
      const nodesBlock = text.slice(
        text.indexOf("  nodes:") + "  nodes:".length,
        text.indexOf("  relations:"),
      );
      const nodeEntries = nodesBlock.split("\n").filter((l) => l.startsWith("    - "));
      assert.equal(
        nodeEntries.length,
        73,
        "schema resource must advertise all 73 logical node columns (was 26 before the D15 fix)",
      );
      assert.equal(nodeEntries.length, NODE_COLUMNS.length);

      // First and last node columns pin the append-only order.
      assert.match(text, /^ {4}- id$/m);
      assert.match(text, /^ {4}- language_stats_json$/m);
      // Columns that were missing from the stale 26-entry roster now appear.
      assert.match(text, /^ {4}- severity$/m);
      assert.match(text, /^ {4}- repo_uri$/m);

      const relationsBlock = text.slice(
        text.indexOf("  relations:") + "  relations:".length,
        text.indexOf("nodeKinds:"),
      );
      const relationEntries = relationsBlock.split("\n").filter((l) => l.startsWith("    - "));
      assert.equal(relationEntries.length, RELATION_COLUMNS.length);
      assert.equal(relationEntries.length, 7);
      // Logical endpoint names (NOT the physical src/dst).
      assert.match(text, /^ {4}- from_id$/m);
      assert.match(text, /^ {4}- to_id$/m);
    },
  );
});
