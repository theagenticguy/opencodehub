/**
 * Thin async wrapper around `write-file-atomic` that encodes our invariants:
 *   - always UTF-8
 *   - always fsync the temp file before rename
 *   - always a trailing newline (makes diffs readable across editors)
 *
 * `write-file-atomic` already handles the pid/ts-suffixed temp file, fsync, and
 * atomic rename. We centralize the import so the rest of the package depends on
 * a single import shape — and so tests can swap in an in-memory implementation
 * via dependency injection if they want.
 */

import { default as wfa } from "write-file-atomic";

export interface WriteAtomicOptions {
  readonly mode?: number;
  /** If true, do not add a trailing newline. Defaults to false. */
  readonly raw?: boolean;
}

/**
 * Write `contents` to `path` atomically. The parent directory must already
 * exist — callers that cannot guarantee that should `mkdir -p` first.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
  opts: WriteAtomicOptions = {},
): Promise<void> {
  const payload = opts.raw === true || contents.endsWith("\n") ? contents : `${contents}\n`;
  const writeOpts: { encoding: BufferEncoding; fsync: boolean; mode?: number } = {
    encoding: "utf8",
    fsync: true,
  };
  if (opts.mode !== undefined) {
    writeOpts.mode = opts.mode;
  }
  await wfa(path, payload, writeOpts);
}
