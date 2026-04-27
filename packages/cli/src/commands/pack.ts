/**
 * `codehub pack [path]` — produce a single-file repo snapshot suitable
 * for dropping into an LLM context window, via the `repomix` CLI.
 *
 * Repomix is invoked with `--style xml --compress` by default so the
 * output is Anthropic-friendly and tree-sitter-signature-compressed. The
 * command is an OUTPUT-side convenience; OpenCodeHub does NOT use
 * repomix for indexing or embedding (see ADR 0004).
 *
 * This is a thin wrapper — we shell to `npx repomix@<pin>` so operators
 * can override by running repomix directly. The wrapper exists to make
 * the output path discoverable and to put the produced file under
 * `.codehub/pack/` so it's ignored by the standard gitignore pattern.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface PackOptions {
  /** Output style: xml (default, Anthropic-friendly), markdown, json, or plain. */
  readonly style?: "xml" | "markdown" | "json" | "plain";
  /** When true (default) apply `--compress` for tree-sitter signature compression. */
  readonly compress?: boolean;
  /** When true, strip comments in the packed output. */
  readonly removeComments?: boolean;
  /** Custom output file path. Defaults to `<repo>/.codehub/pack/repo.<ext>`. */
  readonly outputPath?: string;
  /** Pin for `npx repomix@<pin>`. Defaults to the latest verified-compatible version. */
  readonly repomixVersion?: string;
  /** Timeout in ms. Defaults to 5 minutes. */
  readonly timeoutMs?: number;
}

const DEFAULT_REPOMIX_VERSION = "1.14.0";

export interface PackResult {
  readonly outputPath: string;
  readonly bytes: number;
  readonly durationMs: number;
}

export async function runPack(path: string, opts: PackOptions = {}): Promise<PackResult> {
  const start = Date.now();
  const repoPath = resolve(path);
  const style = opts.style ?? "xml";
  const compress = opts.compress ?? true;
  const version = opts.repomixVersion ?? DEFAULT_REPOMIX_VERSION;
  const outputPath = opts.outputPath
    ? resolve(opts.outputPath)
    : join(repoPath, ".codehub", "pack", `repo.${extForStyle(style)}`);

  await mkdir(dirname(outputPath), { recursive: true });

  const args = [`repomix@${version}`, "--style", style, "--output", outputPath];
  if (compress) args.push("--compress");
  if (opts.removeComments) args.push("--remove-comments");

  await new Promise<void>((res, rej) => {
    const child = spawn("npx", args, {
      cwd: repoPath,
      env: { ...process.env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (err.code === "ENOENT") {
        rej(new Error("codehub pack: `npx` not found on PATH. Install Node.js 20+."));
      } else {
        rej(err);
      }
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) res();
      else rej(new Error(`codehub pack: repomix exited ${code}`));
    });
  });

  if (!existsSync(outputPath)) {
    throw new Error(`codehub pack: repomix did not produce ${outputPath}`);
  }
  const bytes = statSync(outputPath).size;
  return { outputPath, bytes, durationMs: Date.now() - start };
}

function extForStyle(style: "xml" | "markdown" | "json" | "plain"): string {
  switch (style) {
    case "xml":
      return "xml";
    case "markdown":
      return "md";
    case "json":
      return "json";
    case "plain":
      return "txt";
  }
}
