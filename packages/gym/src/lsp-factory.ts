/**
 * LSP client factory for the gym runner.
 *
 * `defaultLspFactory` maps a corpus-declared `language` to the matching
 * `@opencodehub/lsp-oracle` client class, adapting each concrete class to
 * the smaller `LspClientLike` surface the runner actually needs. Tests
 * supply their own factory that returns mock clients — the runner never
 * talks to a real LSP subprocess under `node --test`.
 */

import type {
  CallerSite,
  FilePosition,
  ImplementationSite,
  QueryCallersInput,
  ReferenceSite,
} from "@opencodehub/lsp-oracle";
import {
  GoplsClient,
  PyrightClient,
  RustAnalyzerClient,
  TypeScriptClient,
} from "@opencodehub/lsp-oracle";
import type { ManifestLanguage } from "./manifest.js";

export type QueryReferencesInput = FilePosition;
export type QueryImplementationsInput = FilePosition;
export type { CallerSite, ImplementationSite, QueryCallersInput, ReferenceSite };

/**
 * Minimum surface the runner needs from an LSP client. Every
 * `@opencodehub/lsp-oracle` client already exposes this shape; the mock
 * factory used by `runner.test.ts` implements it directly.
 */
export interface LspClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  queryReferences(input: QueryReferencesInput): Promise<readonly ReferenceSite[]>;
  queryImplementations(input: QueryImplementationsInput): Promise<readonly ImplementationSite[]>;
  queryCallers(input: QueryCallersInput): Promise<readonly CallerSite[]>;
  /**
   * Optional per-language warmup. TypeScript + rust-analyzer require it
   * (cold indexes return empty results for cross-file queries); pyright
   * and gopls index automatically during `start()` and can skip it.
   */
  warmup?(files: readonly string[]): Promise<void>;
}

export interface LspFactory {
  create(language: ManifestLanguage, fixtureRoot: string): LspClientLike;
}

export const defaultLspFactory: LspFactory = {
  create(language, fixtureRoot) {
    switch (language) {
      case "python":
        return new PyrightClient({ workspaceRoot: fixtureRoot });
      case "typescript":
        return new TypeScriptClient({ workspaceRoot: fixtureRoot });
      case "go":
        return new GoplsClient({ workspaceRoot: fixtureRoot });
      case "rust":
        // rust-analyzer's warmup signature (`(timeoutMs?: number)`) differs
        // from the `(files: string[])` shape LspClientLike expects. Wrap
        // it so the runner's generic `warmup(files)` call routes to the
        // priming-wait path without passing the files through.
        return new RustAnalyzerAdapter(fixtureRoot);
      default: {
        const exhaustive: never = language;
        throw new Error(`lsp-factory: unsupported language ${String(exhaustive)}`);
      }
    }
  },
};

class RustAnalyzerAdapter implements LspClientLike {
  private readonly inner: RustAnalyzerClient;

  constructor(fixtureRoot: string) {
    this.inner = new RustAnalyzerClient({ workspaceRoot: fixtureRoot });
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  queryReferences(input: QueryReferencesInput): Promise<readonly ReferenceSite[]> {
    return Promise.resolve(this.inner.queryReferences(input));
  }

  queryImplementations(input: QueryImplementationsInput): Promise<readonly ImplementationSite[]> {
    return Promise.resolve(this.inner.queryImplementations(input));
  }

  queryCallers(input: QueryCallersInput): Promise<readonly CallerSite[]> {
    return Promise.resolve(this.inner.queryCallers(input));
  }

  async warmup(_files: readonly string[]): Promise<void> {
    await this.inner.warmup();
  }
}
