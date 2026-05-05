/**
 * Stage 5 — import / SCIP-resolved usage patterns.
 *
 * Walks the graph's `IMPORTS` edges; when a resolved import targets a
 * registered framework's root module (`fastapi`, `django.db`, `express`,
 * `@nestjs/core`, etc.), emits a framework detection as a structured
 * finding. If the import was produced by scip (confidence 1.0), the
 * detection is treated as deterministic; fallback parser emits
 * (confidence 0.8) are treated as heuristic at the dispatcher.
 *
 * Pure — no network, no LLM, no subprocess. Consumes only the graph.
 */

/**
 * Minimal subset of the KnowledgeGraph surface the stage reads. Callers
 * pass the real `KnowledgeGraph`; tests supply a lightweight stub.
 */
export interface ImportStageGraph {
  edges(): IterableIterator<ImportEdgeLike>;
  getNode(id: string): ImportNodeLike | undefined;
}

/** Minimal edge shape — an IMPORTS edge's {from, to, type, confidence}. */
export interface ImportEdgeLike {
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly confidence: number;
}

/** Minimal node shape — an external-stub `CodeElement` carrying the import module. */
export interface ImportNodeLike {
  readonly id: string;
  readonly kind: string;
  readonly name?: string;
  /** Content string shaped `external import: <source>:<symbol>` for external stubs. */
  readonly content?: string;
  readonly filePath?: string;
}

/** Finding from stage 5 — the dispatcher lifts this into framework evidence. */
export interface ImportFinding {
  /** Canonical framework name (`fastapi`, `django`, `express`, …). */
  readonly framework: string;
  /** Resolved module specifier the import target carried (`fastapi`, `django.db`, …). */
  readonly source: string;
  /** `deterministic` when the edge confidence is 1.0 (scip-resolved), `heuristic` otherwise. */
  readonly confidence: "deterministic" | "heuristic";
}

/**
 * Root-module → framework-name map. Keys are the module prefixes the
 * import specifier is matched against (startsWith semantics). First match
 * wins — order keys from most-specific to least-specific if collisions
 * matter (none today, but a safeguard).
 */
const ROOT_MODULE_TO_FRAMEWORK: ReadonlyMap<string, string> = new Map([
  // JavaScript / TypeScript
  ["react", "react"],
  ["react-dom", "react"],
  ["next", "nextjs"],
  ["express", "express"],
  ["@angular/core", "angular"],
  ["@angular/common", "angular"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["@nestjs/core", "nestjs"],
  ["@nestjs/common", "nestjs"],
  ["react-native", "react-native"],
  ["electron", "electron"],
  ["@tauri-apps/api", "tauri"],
  ["jest", "jest"],
  ["vitest", "vitest"],
  ["@playwright/test", "playwright"],
  // Python
  ["fastapi", "fastapi"],
  ["django", "django"],
  ["django.db", "django"],
  ["django.urls", "django"],
  ["flask", "flask"],
  // Ruby — the `rails` gem is commonly `Rails::Application`, but the
  // require specifier is `rails` or `action_controller`.
  ["rails", "rails"],
  ["action_controller", "rails"],
  ["sinatra", "sinatra"],
  // Java — Spring Boot root packages
  ["org.springframework.boot", "spring-boot"],
  ["org.springframework", "spring-boot"],
  // PHP / .NET
  ["illuminate", "laravel"],
  ["Microsoft.AspNetCore", "aspnet-core"],
]);

/**
 * Parse the external-stub `content` field. The scip/parse pipeline shapes
 * it as `external import: <source>:<symbol>`. Returns null for stubs that
 * don't match the expected format (defense against format drift).
 */
function parseExternalImportContent(content: string): { source: string; symbol: string } | null {
  const prefix = "external import: ";
  if (!content.startsWith(prefix)) return null;
  const body = content.slice(prefix.length);
  const colon = body.lastIndexOf(":");
  if (colon <= 0) return null;
  const source = body.slice(0, colon);
  const symbol = body.slice(colon + 1);
  if (source.length === 0 || symbol.length === 0) return null;
  return { source, symbol };
}

/**
 * Match a resolved module source against the framework registry. Returns
 * the framework name when a prefix match is found, else null.
 */
function matchRootModule(source: string): string | null {
  // Longest-match semantics: walk the map, pick the longest key whose
  // prefix matches. This keeps `django.db` from degrading to `django`'s
  // framework entry only when both are registered (they both map to
  // `django` so the outcome is identical either way, but the general
  // policy is portable).
  let best: { key: string; framework: string } | null = null;
  for (const [key, framework] of ROOT_MODULE_TO_FRAMEWORK) {
    if (source === key || source.startsWith(`${key}/`) || source.startsWith(`${key}.`)) {
      if (best === null || key.length > best.key.length) {
        best = { key, framework };
      }
    }
  }
  return best?.framework ?? null;
}

/**
 * Walk IMPORTS edges on the graph and emit one `ImportFinding` per
 * resolved framework root module. Duplicates across multiple import sites
 * are deduped by (framework, source) — the caller does not need repeated
 * findings for the same module.
 */
export function detectFromImports(graph: ImportStageGraph): readonly ImportFinding[] {
  const seen = new Map<string, ImportFinding>();
  for (const edge of graph.edges()) {
    if (edge.type !== "IMPORTS") continue;
    const target = graph.getNode(edge.to);
    if (target === undefined) continue;
    if (target.kind !== "CodeElement") continue;
    const content = target.content;
    if (content === undefined) continue;
    const parsed = parseExternalImportContent(content);
    if (parsed === null) continue;
    const framework = matchRootModule(parsed.source);
    if (framework === null) continue;
    const key = `${framework}\x00${parsed.source}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      framework,
      source: parsed.source,
      confidence: edge.confidence >= 1 ? "deterministic" : "heuristic",
    });
  }
  // Deterministic output — sort by (framework, source).
  return [...seen.values()].sort((a, b) => {
    if (a.framework !== b.framework) return a.framework.localeCompare(b.framework);
    return a.source.localeCompare(b.source);
  });
}

/**
 * Exported for tests and downstream callers that want to extend the root
 * module registry without forking this module.
 */
export const FRAMEWORK_ROOT_MODULES = ROOT_MODULE_TO_FRAMEWORK;
