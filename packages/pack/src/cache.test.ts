/**
 * Tests for channel-aware cache-prefix enforcement (Move 4).
 *
 * Covers:
 *   A. Channel → needs-markers mapping (opt-in vs automatic).
 *   B. buildCachePoint marker shapes per channel.
 *   C. parseCacheChannel narrowing + rejection of unknown values.
 *   D. cacheBreakpointSentinel determinism + empty for automatic channels.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildCachePoint,
  CACHE_CHANNELS,
  type CacheChannel,
  cacheBreakpointSentinel,
  cacheChannelNeedsMarkers,
  DEFAULT_CACHE_CHANNEL,
  parseCacheChannel,
} from "./cache.js";

const OPT_IN: readonly CacheChannel[] = ["bedrock", "vertex"];
const AUTOMATIC: readonly CacheChannel[] = ["anthropic", "claude-on-aws", "foundry", "auto"];

test("A. opt-in channels need markers; automatic channels do not", () => {
  for (const c of OPT_IN) {
    assert.equal(cacheChannelNeedsMarkers(c), true, `${c} should need markers`);
  }
  for (const c of AUTOMATIC) {
    assert.equal(cacheChannelNeedsMarkers(c), false, `${c} should not need markers`);
  }
});

test("A. the default channel is auto and is marker-free", () => {
  assert.equal(DEFAULT_CACHE_CHANNEL, "auto");
  assert.equal(cacheChannelNeedsMarkers(DEFAULT_CACHE_CHANNEL), false);
});

test("A. every enumerated channel has a defined needs-markers verdict", () => {
  for (const c of CACHE_CHANNELS) {
    assert.equal(typeof cacheChannelNeedsMarkers(c), "boolean");
  }
});

test("B. bedrock builds the Bedrock cachePoint block", () => {
  assert.deepEqual(buildCachePoint("bedrock"), { cachePoint: { type: "default" } });
});

test("B. vertex builds the cache_control ephemeral block", () => {
  assert.deepEqual(buildCachePoint("vertex"), { cache_control: { type: "ephemeral" } });
});

test("B. automatic channels build no marker (null)", () => {
  for (const c of AUTOMATIC) {
    assert.equal(buildCachePoint(c), null, `${c} should build no marker`);
  }
});

test("C. parseCacheChannel narrows every valid value", () => {
  for (const c of CACHE_CHANNELS) {
    assert.equal(parseCacheChannel(c), c);
  }
});

test("C. parseCacheChannel rejects unknown values", () => {
  assert.equal(parseCacheChannel("openai"), undefined);
  assert.equal(parseCacheChannel(""), undefined);
  assert.equal(parseCacheChannel("BEDROCK"), undefined);
});

test("D. sentinel is empty for automatic channels, non-empty for opt-in", () => {
  for (const c of AUTOMATIC) {
    assert.equal(cacheBreakpointSentinel(c), "", `${c} should have empty sentinel`);
  }
  for (const c of OPT_IN) {
    assert.ok(cacheBreakpointSentinel(c).length > 0, `${c} should have a sentinel`);
    assert.ok(
      cacheBreakpointSentinel(c).includes("opencodehub:cachePoint"),
      `${c} sentinel should be self-describing`,
    );
  }
});

test("D. sentinel is byte-stable per channel (deterministic)", () => {
  for (const c of CACHE_CHANNELS) {
    assert.equal(cacheBreakpointSentinel(c), cacheBreakpointSentinel(c));
  }
  // The bedrock sentinel embeds the exact marker JSON with fixed key order.
  assert.equal(
    cacheBreakpointSentinel("bedrock"),
    '<!-- opencodehub:cachePoint channel=bedrock {"cachePoint":{"type":"default"}} -->',
  );
});
