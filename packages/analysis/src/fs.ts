/**
 * Node-backed implementation of {@link FsAbstraction}.
 *
 * Writes go through a temp-file + rename sequence so partial writes can never
 * leave the target truncated or half-written. `fs.rename` is atomic on POSIX
 * and on Windows when source and destination live on the same filesystem,
 * which is the common case since we always create the temp file inside the
 * target's directory.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FsAbstraction } from "./types.js";

export function createNodeFs(): FsAbstraction {
  return {
    async readFile(absPath) {
      return readFile(absPath, "utf8");
    },
    async writeFileAtomic(absPath, content) {
      const dir = dirname(absPath);
      await mkdir(dir, { recursive: true });
      const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, content, { encoding: "utf8" });
      await rename(tmp, absPath);
    },
  };
}
