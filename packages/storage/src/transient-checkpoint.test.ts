/**
 * Tests for `isTransientCheckpointError` — the matcher that gates the
 * bulk-load retry in {@link GraphDbStore.bulkLoad}.
 *
 * The lbug native binding can fail the WAL→checkpoint rename under load with
 * an "Error renaming file <db>.wal to <db>.wal.checkpoint" IO exception even
 * though the write is durably in the WAL. That specific failure is safe to
 * retry (replace-mode bulkLoad is idempotent); everything else must rethrow.
 * These tests pin the matcher to the real lbug message and guard against it
 * widening to swallow unrelated failures.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientCheckpointError, retryTransientCheckpoint } from "./graphdb-adapter.js";

/** The canonical transient WAL→checkpoint rename error. */
const checkpointErr = () =>
  new Error(
    "IO exception: Error renaming file graph.lbug.wal to graph.lbug.wal.checkpoint. " +
      "ErrorMessage: No such file or directory",
  );
/** Zero-delay backoff so retry tests don't sleep. */
const noBackoff = () => Promise.resolve();

test("matches the real lbug WAL→checkpoint rename failure", () => {
  const real =
    "IO exception: Error renaming file /tmp/x/.codehub/graph.lbug.wal to " +
    "/tmp/x/.codehub/graph.lbug.wal.checkpoint. ErrorMessage: No such file or directory";
  assert.equal(isTransientCheckpointError(new Error(real)), true);
});

test("matches regardless of the OS-specific errno suffix", () => {
  // Linux/macOS phrase the trailing errno differently; the matcher keys on
  // the stable token trio (renaming + .wal + checkpoint), not the suffix.
  const variant =
    "IO exception: Error renaming file graph.lbug.wal to graph.lbug.wal.checkpoint. " +
    "ErrorMessage: Permission denied";
  assert.equal(isTransientCheckpointError(new Error(variant)), true);
});

test("accepts a non-Error thrown value (string)", () => {
  const s = "Error renaming file a.wal to a.wal.checkpoint. boom";
  assert.equal(isTransientCheckpointError(s), true);
});

test("does NOT match an unrelated IO error", () => {
  assert.equal(
    isTransientCheckpointError(new Error("IO exception: disk full while writing CodeNode")),
    false,
  );
});

test("does NOT match a generic checkpoint mention without a WAL rename", () => {
  // A CHECKPOINT statement error that isn't the rename race must rethrow.
  assert.equal(
    isTransientCheckpointError(new Error("CHECKPOINT failed: transaction conflict")),
    false,
  );
});

test("does NOT match a query/constraint error", () => {
  assert.equal(
    isTransientCheckpointError(
      new Error("Runtime exception: primary key violation on CodeNode.id"),
    ),
    false,
  );
});

test("does NOT match undefined / null", () => {
  assert.equal(isTransientCheckpointError(undefined), false);
  assert.equal(isTransientCheckpointError(null), false);
});

// ---------------------------------------------------------------------------
// retryTransientCheckpoint — the policy that wraps bulkLoad
// ---------------------------------------------------------------------------

test("recovers when the transient error clears before maxAttempts", async () => {
  let calls = 0;
  const result = await retryTransientCheckpoint(
    async () => {
      calls++;
      if (calls < 3) throw checkpointErr(); // fail attempts 1 and 2
      return "ok";
    },
    3,
    noBackoff,
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3, "should have retried twice then succeeded on the 3rd attempt");
});

test("succeeds on the first attempt without retrying", async () => {
  let calls = 0;
  const result = await retryTransientCheckpoint(
    async () => {
      calls++;
      return 42;
    },
    3,
    noBackoff,
  );
  assert.equal(result, 42);
  assert.equal(calls, 1, "no retry when the first attempt succeeds");
});

test("rethrows the transient error after exhausting maxAttempts", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryTransientCheckpoint(
        async () => {
          calls++;
          throw checkpointErr();
        },
        3,
        noBackoff,
      ),
    /renaming/,
  );
  assert.equal(calls, 3, "should attempt exactly maxAttempts times before giving up");
});

test("rethrows a non-transient error immediately without retrying", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryTransientCheckpoint(
        async () => {
          calls++;
          throw new Error("primary key violation on CodeNode.id");
        },
        3,
        noBackoff,
      ),
    /primary key/,
  );
  assert.equal(calls, 1, "a non-transient error must NOT be retried");
});
