/**
 * Table-driven pin for the `scip-index` language registry.
 *
 * `LANG_REGISTRY` is the single source of truth for the three per-kind
 * mappings the phase used to keep in parallel switch statements
 * (`scipLangToOchLang`, `kindToTool`, `kindToProvenance`). This one fixture
 * loop asserts the full mapping for every `IndexerKind`, so a drift in any
 * arm fails here instead of relying on transitive phase-test coverage.
 *
 * Exhaustiveness over `IndexerKind` is enforced at compile time by the
 * `Record<IndexerKind, LangEntry>` type on `LANG_REGISTRY` and the
 * `Record<IndexerKind, ...>` annotation on `EXPECTED` below — tsc errors if
 * a kind is added or removed without updating both.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type {
  IndexerKind,
  ScipIndexerName,
  ScipUnofficialIndexerName,
} from "@opencodehub/scip-ingest";
import { LANG_REGISTRY } from "./scip-index.js";

interface ExpectedEntry {
  readonly ochLang: string;
  readonly tool: string;
  readonly provenance: ScipIndexerName | ScipUnofficialIndexerName | null;
  readonly tier: "first-party" | "scip-unofficial";
}

// Pinned mapping for all 12 IndexerKinds. The `Record<IndexerKind, ...>`
// annotation makes a missing/extra kind a compile error. php + dart are the
// Tier-1.5 (`scip-unofficial`) kinds — distinct provenance class + tier.
const EXPECTED: Record<IndexerKind, ExpectedEntry> = {
  typescript: {
    ochLang: "typescript",
    tool: "scip-typescript",
    provenance: "scip-typescript",
    tier: "first-party",
  },
  python: {
    ochLang: "python",
    tool: "scip-python",
    provenance: "scip-python",
    tier: "first-party",
  },
  go: { ochLang: "go", tool: "scip-go", provenance: "scip-go", tier: "first-party" },
  rust: {
    ochLang: "rust",
    tool: "rust-analyzer",
    provenance: "rust-analyzer",
    tier: "first-party",
  },
  java: { ochLang: "java", tool: "scip-java", provenance: "scip-java", tier: "first-party" },
  clang: { ochLang: "c", tool: "scip-clang", provenance: "scip-clang", tier: "first-party" },
  "cobol-proleap": {
    ochLang: "cobol",
    tool: "scip-cobol-proleap",
    provenance: null,
    tier: "first-party",
  },
  ruby: { ochLang: "ruby", tool: "scip-ruby", provenance: "scip-ruby", tier: "first-party" },
  dotnet: {
    ochLang: "csharp",
    tool: "scip-dotnet",
    provenance: "scip-dotnet",
    tier: "first-party",
  },
  kotlin: {
    ochLang: "kotlin",
    tool: "scip-kotlin",
    provenance: "scip-kotlin",
    tier: "first-party",
  },
  php: { ochLang: "php", tool: "scip-php", provenance: "scip-php", tier: "scip-unofficial" },
  dart: { ochLang: "dart", tool: "scip-dart", provenance: "scip-dart", tier: "scip-unofficial" },
};

describe("LANG_REGISTRY", () => {
  it("maps every IndexerKind to the expected {ochLang, tool, provenance}", () => {
    for (const [kind, expected] of Object.entries(EXPECTED) as [IndexerKind, ExpectedEntry][]) {
      assert.deepEqual(
        LANG_REGISTRY[kind],
        expected,
        `LANG_REGISTRY[${kind}] drifted from the pinned mapping`,
      );
    }
  });

  it("has exactly one entry per IndexerKind (no extra/missing keys)", () => {
    assert.deepEqual(Object.keys(LANG_REGISTRY).sort(), Object.keys(EXPECTED).sort());
  });
});
