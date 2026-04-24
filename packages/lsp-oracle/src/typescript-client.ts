/**
 * High-level typescript-language-server adapter.
 *
 * `TypeScriptClient` drives tsserver (via `typescript-language-server`)
 * over raw LSP stdio JSON-RPC. It owns:
 *
 *   - subprocess spawn of `typescript-language-server/lib/cli.mjs --stdio`
 *     resolved via `createRequire` so downstream users never need
 *     `typescript-language-server` on PATH
 *   - per-extension `languageId` mapping on `textDocument/didOpen`
 *     (.ts/.mts/.cts/.d.ts → `"typescript"`; .tsx → `"typescriptreact"`;
 *     .js → `"javascript"`; .jsx → `"javascriptreact"`)
 *   - a public `warmup(files)` method that sequentially `didOpen`s each
 *     file and issues a dummy references query — required because
 *     tsserver does not auto-index the workspace and cross-file
 *     reference/call-hierarchy queries only resolve against URIs the
 *     client has explicitly opened
 *   - a `getStatus()` override that reports the pinned tsserver and
 *     typescript versions read from the resolved package.json files
 *
 * The three query methods (`queryCallers`, `queryReferences`,
 * `queryImplementations`) use the base-class defaults — tsserver's
 * callHierarchy semantics match pyright's.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

import { BaseLspClient, type BaseLspClientOptions, toFileUri } from "./base-client.js";

export interface TypeScriptClientOptions extends BaseLspClientOptions {
  /**
   * Override how we invoke typescript-language-server. Defaults to the
   * binary shipped by the `typescript-language-server` npm package. Pass
   * `["typescript-language-server", "--stdio"]` to use whatever's first
   * on PATH.
   */
  readonly serverCommand?: readonly string[];
}

export interface TypeScriptClientStatus {
  readonly started: boolean;
  readonly indexingComplete: boolean;
  readonly workspaceRoot: string;
  readonly coldStartMs: number | null;
  readonly serverCommand: readonly string[];
  readonly tsserverVersion: string;
  readonly typescriptVersion: string;
}

interface ResolvedVersions {
  readonly tsserverVersion: string;
  readonly typescriptVersion: string;
  readonly serverCommand: readonly string[];
}

function readPackageVersion(pkgJsonPath: string): string {
  const raw = readFileSync(pkgJsonPath, "utf-8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`lsp-oracle: ${pkgJsonPath} missing "version" string`);
  }
  return parsed.version;
}

function resolveVersionsAndCommand(override?: readonly string[]): ResolvedVersions {
  const require = createRequire(import.meta.url);
  let tsserverVersion = "unknown";
  let typescriptVersion = "unknown";
  let serverCommand: readonly string[] = override ?? [];
  try {
    const tsserverPkgJson = require.resolve("typescript-language-server/package.json");
    tsserverVersion = readPackageVersion(tsserverPkgJson);
    if (serverCommand.length === 0) {
      const cliMjs = require.resolve("typescript-language-server/lib/cli.mjs");
      serverCommand = [process.execPath, cliMjs, "--stdio"];
    }
  } catch {
    if (serverCommand.length === 0) {
      serverCommand = ["typescript-language-server", "--stdio"];
    }
  }
  try {
    const tsPkgJson = require.resolve("typescript/package.json");
    typescriptVersion = readPackageVersion(tsPkgJson);
  } catch {
    // typescriptVersion stays "unknown"
  }
  return { tsserverVersion, typescriptVersion, serverCommand };
}

function languageIdForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return "typescriptreact";
  if (lower.endsWith(".jsx")) return "javascriptreact";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  return "typescript";
}

export class TypeScriptClient extends BaseLspClient {
  private readonly resolvedCommand: readonly string[];
  private readonly tsserverVersion: string;
  private readonly typescriptVersion: string;

  constructor(options: TypeScriptClientOptions) {
    super({
      workspaceRoot: options.workspaceRoot,
      ...(options.indexWaitMs !== undefined ? { indexWaitMs: options.indexWaitMs } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    });
    const resolved = resolveVersionsAndCommand(options.serverCommand);
    this.resolvedCommand = resolved.serverCommand;
    this.tsserverVersion = resolved.tsserverVersion;
    this.typescriptVersion = resolved.typescriptVersion;
  }

  protected override serverCommand(): { cmd: string; args: readonly string[] } {
    const [cmd, ...args] = this.resolvedCommand;
    return { cmd: cmd ?? "", args };
  }

  protected override serverEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  protected override clientName(): string {
    return "typescript-language-server";
  }

  // Default language ID for contexts where the base class asks without a
  // path (e.g. the abstract contract). Per-file routing happens in the
  // overridden `ensureOpen` below, which is the only code path that
  // consults `languageId` in practice.
  protected override languageId(): string {
    return "typescript";
  }

  protected override initializationOptions(): Record<string, unknown> {
    return {};
  }

  /**
   * Public language-ID resolver — exposed so tests and callers that need
   * to classify a file without opening it can do so without duplicating
   * the extension table.
   */
  languageIdFor(filePath: string): string {
    return languageIdForPath(filePath);
  }

  /**
   * Prime tsserver with a batch of files. Required before cross-file
   * `textDocument/references` and `callHierarchy/incomingCalls` will
   * return results — tsserver does not auto-index the workspace the way
   * pyright does.
   *
   * Monorepo correctness: tsserver materializes one Configured Project
   * per tsconfig.json. If renderer + main-process files are sent in the
   * same undifferentiated batch, tsserver picks ONE governing tsconfig
   * and the other side's files silently run against the wrong project,
   * dropping cross-file references. We therefore:
   *
   *   1. Group `files` by governing tsconfig (walk up from each file).
   *   2. Topologically sort tsconfigs by their `references` field so
   *      referenced projects are opened before the projects that depend
   *      on them.
   *   3. For each group (in topo order), `didOpen` every file with a
   *      5ms gap (tsserver drops notifications queued too tightly) and
   *      fire a dummy `textDocument/references` at (0, 0) on the first
   *      file to drain that project's load queue before the next group.
   *   4. Files with no enclosing tsconfig are batched last as an
   *      inferred-project bucket.
   *
   * When every file resolves to a single tsconfig (or none), the wire
   * shape is identical to the pre-monorepo implementation.
   */
  async warmup(files: readonly string[]): Promise<void> {
    if (files.length === 0) return;

    const discovery = new TsconfigDiscovery();
    const grouped = new Map<string | null, string[]>();
    for (const file of files) {
      const abs = path.isAbsolute(file) ? file : path.join(this.workspaceRoot, file);
      const governing = discovery.findGoverning(path.dirname(abs));
      const key = governing ?? null;
      let bucket = grouped.get(key);
      if (bucket === undefined) {
        bucket = [];
        grouped.set(key, bucket);
      }
      bucket.push(abs);
    }

    const tsconfigKeys: string[] = [];
    for (const key of grouped.keys()) {
      if (key !== null) tsconfigKeys.push(key);
    }
    const ordered = topoSortTsconfigReferences(tsconfigKeys, discovery);

    for (const tsconfig of ordered) {
      const bucket = grouped.get(tsconfig) ?? [];
      await this.warmupBucket(bucket);
    }

    const inferred = grouped.get(null);
    if (inferred !== undefined) {
      await this.warmupBucket(inferred);
    }
  }

  /**
   * Open every file in a single tsconfig-bucket (or the inferred-project
   * bucket) and drain the load queue with a dummy references query on
   * the first file. A no-op on empty buckets.
   */
  private async warmupBucket(files: readonly string[]): Promise<void> {
    if (files.length === 0) return;
    for (const abs of files) {
      await this.ensureOpen(abs);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const first = files[0];
    if (first === undefined) return;
    try {
      await this.request("textDocument/references", {
        textDocument: { uri: toFileUri(first) },
        position: { line: 0, character: 0 },
        context: { includeDeclaration: false },
      });
    } catch {
      // Dummy query errors are expected when position (0,0) isn't a
      // symbol — we only needed the round-trip for sequencing.
    }
  }

  override getStatus(): TypeScriptClientStatus {
    return {
      started: this.started,
      indexingComplete: this.indexingComplete,
      workspaceRoot: this.workspaceRoot,
      coldStartMs: this.coldStartMs,
      serverCommand: this.resolvedCommand,
      tsserverVersion: this.tsserverVersion,
      typescriptVersion: this.typescriptVersion,
    };
  }

  /**
   * Override `ensureOpen` so each `didOpen` uses the correct per-file
   * `languageId`. The base-class version calls `languageId()` once with
   * no arguments, which is right for single-language servers like pyright
   * but loses information for tsserver where .ts and .tsx map to
   * different protocol IDs.
   */
  protected override async ensureOpen(filePath: string): Promise<void> {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
    if (this.openedFiles.has(abs)) return;
    const { readFile } = await import("node:fs/promises");
    let text: string;
    try {
      text = await readFile(abs, "utf-8");
    } catch (err) {
      throw new Error(`lsp-oracle: cannot read ${abs} for didOpen: ${(err as Error).message}`);
    }
    const dispatcher = this.dispatcher;
    if (dispatcher === null) {
      throw new Error("lsp-oracle: cannot didOpen — dispatcher is not started");
    }
    dispatcher.notify("textDocument/didOpen", {
      textDocument: {
        uri: toFileUri(abs),
        languageId: languageIdForPath(abs),
        version: 1,
        text,
      },
    });
    this.openedFiles.add(abs);
  }
}

/**
 * Walks up from a directory to find the nearest `tsconfig*.json`. The
 * first match wins; results are cached per directory within a single
 * discovery instance because many files share parent directories.
 *
 * Discovery is cheap (`readdirSync` on each ancestor until root) and
 * purely synchronous — warmup is already serialized by the `await` on
 * every `ensureOpen`, so adding async fs here would only add latency.
 *
 * Malformed tsconfigs (invalid JSONC) are surfaced via `loadReferences`
 * as an empty reference list plus a stderr warning. We deliberately
 * keep the file as a valid discovery target: tsserver will still load
 * it on its own terms, and silently skipping would let a bad sibling
 * project poison an entire warmup.
 */
class TsconfigDiscovery {
  private readonly dirCache = new Map<string, string | null>();
  private readonly referencesCache = new Map<string, readonly string[]>();

  /**
   * First ancestor tsconfig (as an absolute canonical path) for `dir`,
   * or `null` if none exists up to the filesystem root.
   */
  findGoverning(dir: string): string | null {
    const canonical = path.resolve(dir);
    const cached = this.dirCache.get(canonical);
    if (cached !== undefined) return cached;

    const found = discoverGoverningTsconfig(canonical);
    this.dirCache.set(canonical, found);
    return found;
  }

  /**
   * Parse `tsconfig.references[]` into absolute canonical paths. A
   * reference `path` may point at a directory (expands to
   * `<dir>/tsconfig.json`) or at a specific `.json` file. Malformed
   * JSONC is logged and degrades to an empty reference list.
   */
  loadReferences(tsconfigAbs: string): readonly string[] {
    const cached = this.referencesCache.get(tsconfigAbs);
    if (cached !== undefined) return cached;

    let raw: string;
    try {
      raw = readFileSync(tsconfigAbs, "utf-8");
    } catch (err) {
      process.stderr.write(
        `lsp-oracle: could not read tsconfig ${tsconfigAbs}: ${(err as Error).message}\n`,
      );
      this.referencesCache.set(tsconfigAbs, []);
      return [];
    }

    const errors: ParseError[] = [];
    const parsed = parseJsonc(raw, errors, { allowTrailingComma: true }) as unknown;
    if (errors.length > 0) {
      const summary = errors.map((e) => `${printParseErrorCode(e.error)}@${e.offset}`).join(",");
      process.stderr.write(`lsp-oracle: malformed tsconfig ${tsconfigAbs} (${summary})\n`);
      this.referencesCache.set(tsconfigAbs, []);
      return [];
    }

    const refs = extractReferences(parsed, path.dirname(tsconfigAbs));
    this.referencesCache.set(tsconfigAbs, refs);
    return refs;
  }
}

function discoverGoverningTsconfig(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const hit = firstTsconfigIn(current);
    if (hit !== null) return hit;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function firstTsconfigIn(dir: string): string | null {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: string | null = null;
  for (const entry of entries) {
    if (!entry.startsWith("tsconfig") || !entry.endsWith(".json")) continue;
    const full = path.join(dir, entry);
    let isFile = false;
    try {
      isFile = statSync(full).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    // Prefer the canonical `tsconfig.json` when multiple candidates
    // exist in the same directory (e.g. both `tsconfig.json` and
    // `tsconfig.main.json`). tsserver itself resolves the same way.
    if (entry === "tsconfig.json") return full;
    if (best === null) best = full;
  }
  return best;
}

function extractReferences(parsed: unknown, tsconfigDir: string): readonly string[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const refs = (parsed as { references?: unknown }).references;
  if (!Array.isArray(refs)) return [];
  const out: string[] = [];
  for (const entry of refs) {
    if (entry === null || typeof entry !== "object") continue;
    const p = (entry as { path?: unknown }).path;
    if (typeof p !== "string" || p.length === 0) continue;
    const resolved = resolveReferenceTarget(path.resolve(tsconfigDir, p));
    if (resolved !== null) out.push(resolved);
  }
  return out;
}

function resolveReferenceTarget(candidate: string): string | null {
  try {
    const stat = statSync(candidate);
    if (stat.isDirectory()) {
      const nested = path.join(candidate, "tsconfig.json");
      try {
        if (statSync(nested).isFile()) return nested;
      } catch {
        return null;
      }
      return null;
    }
    if (stat.isFile()) return candidate;
  } catch {
    return null;
  }
  return null;
}

/**
 * Topological sort over tsconfig `references` edges. Referenced
 * tsconfigs appear BEFORE referrers. Cycle-safe: an in-progress node
 * that is re-entered is skipped, preserving termination without
 * duplicate opens. Tsconfigs that aren't keys of `seeds` but are
 * reachable via `references` are NOT added to the output — we only
 * emit configs that own files the caller asked us to warm.
 */
function topoSortTsconfigReferences(
  seeds: readonly string[],
  discovery: TsconfigDiscovery,
): readonly string[] {
  const seedSet = new Set(seeds);
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const ordered: string[] = [];

  const visit = (node: string): void => {
    if (visited.has(node) || onStack.has(node)) return;
    onStack.add(node);
    for (const ref of discovery.loadReferences(node)) {
      visit(ref);
    }
    onStack.delete(node);
    visited.add(node);
    if (seedSet.has(node)) ordered.push(node);
  };

  for (const seed of seeds) visit(seed);
  return ordered;
}
