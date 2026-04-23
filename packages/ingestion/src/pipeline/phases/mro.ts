/**
 * MRO phase — emit `METHOD_OVERRIDES` / `METHOD_IMPLEMENTS` edges by
 * linearising each class's ancestor chain with its language-specific
 * strategy.
 *
 * Strategy-per-language table:
 *  - `python` → `c3` (raises on ambiguity; caught + skipped per-class).
 *  - `typescript`, `tsx`, `javascript`, `rust` → `first-wins`.
 *  - `java`, `csharp` → `single-inheritance`; interfaces drive
 *    `METHOD_IMPLEMENTS` edges separately.
 *  - `go` → `none`; no class-based inheritance. Skipped entirely.
 *
 * Determinism: parents and methods are iterated in sorted-id order, so the
 * edge set is byte-identical across runs.
 */

import type { NodeId } from "@opencodehub/core-types";
import { getProvider } from "../../providers/registry.js";
import { MroConflictError } from "../../providers/resolution/c3.js";
import { getMroStrategy } from "../../providers/resolution/mro.js";
import type { LanguageId } from "../../providers/types.js";
import type { PipelineContext, PipelinePhase } from "../types.js";
import { CROSS_FILE_PHASE_NAME } from "./cross-file.js";
import {
  buildFilePathLookup,
  partitionPriorEdges,
  resolveIncrementalView,
} from "./incremental-helper.js";
import { INCREMENTAL_SCOPE_PHASE_NAME } from "./incremental-scope.js";
import { STRUCTURE_PHASE_NAME } from "./structure.js";

export const MRO_PHASE_NAME = "mro";

export interface MroOutput {
  readonly overridesCount: number;
  readonly implementsCount: number;
  readonly conflictCount: number;
}

/**
 * Kinds that own methods and participate in the MRO walk.
 */
const OWNER_KINDS: ReadonlySet<string> = new Set(["Class", "Interface", "Struct", "Trait"]);

export const mroPhase: PipelinePhase<MroOutput> = {
  name: MRO_PHASE_NAME,
  deps: [CROSS_FILE_PHASE_NAME, STRUCTURE_PHASE_NAME, INCREMENTAL_SCOPE_PHASE_NAME],
  async run(ctx) {
    return runMro(ctx);
  },
};

function runMro(ctx: PipelineContext): MroOutput {
  // ---- : incremental carry-forward. -----------------------------
  //
  // When the incremental view is active we replay every prior-graph
  // METHOD_OVERRIDES / METHOD_IMPLEMENTS edge whose both endpoints live
  // outside the closure. The closure already pulled in a 1-hop heritage
  // expansion (incremental-scope.ts lines 31-32), so any class whose
  // ancestor moved is already in scope and will re-linearise below. Carry-
  // forward for the rest keeps the graph hash byte-identical to a full
  // run at the same commit (see `incremental-determinism.test.ts`).
  const view = resolveIncrementalView(ctx);
  if (
    view.active &&
    view.previousGraph?.edges !== undefined &&
    view.previousGraph.nodes !== undefined
  ) {
    const filePathByNodeId = buildFilePathLookup(view.previousGraph.nodes);
    const carried = partitionPriorEdges(
      view.previousGraph.edges,
      filePathByNodeId,
      view.closure,
      new Set(["METHOD_OVERRIDES", "METHOD_IMPLEMENTS"]),
    );
    for (const e of carried) {
      ctx.graph.addEdge({
        from: e.from,
        to: e.to,
        type: e.type,
        confidence: e.confidence,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
      });
    }
  }

  // ---- Collect owner nodes + their methods + their heritage. -------------
  //
  // We always collect metadata for EVERY owner in the graph — linearisation
  // walks ancestor chains that may reach owners outside the closure, and
  // those still need their methods + heritage loaded so the walk terminates
  // correctly. The incremental gate applies at edge-emission time.
  const ownerIds: NodeId[] = [];
  const ownerFilePath = new Map<NodeId, string>();
  for (const n of ctx.graph.nodes()) {
    if (OWNER_KINDS.has(n.kind)) {
      ownerIds.push(n.id as NodeId);
      ownerFilePath.set(n.id as NodeId, n.filePath);
    }
  }
  ownerIds.sort();

  // Per-owner method map: name → method node id (one entry per name; if a
  // class declares two overloads with the same name the last id wins for the
  // MRO walk, which matches the `HAS_METHOD` edge set emitted at parse time).
  const methodsByOwner = new Map<NodeId, Map<string, NodeId>>();
  const extendsByOwner = new Map<NodeId, NodeId[]>();
  const implementsByOwner = new Map<NodeId, NodeId[]>();
  for (const id of ownerIds) {
    methodsByOwner.set(id, new Map());
    extendsByOwner.set(id, []);
    implementsByOwner.set(id, []);
  }

  const nodeKindById = new Map<string, string>();
  const nodeNameById = new Map<string, string>();
  for (const n of ctx.graph.nodes()) {
    nodeKindById.set(n.id, n.kind);
    nodeNameById.set(n.id, n.name);
  }

  for (const edge of ctx.graph.edges()) {
    if (edge.type === "HAS_METHOD") {
      const owner = edge.from as NodeId;
      const methodId = edge.to as NodeId;
      const name = nodeNameById.get(methodId);
      if (name === undefined) continue;
      const map = methodsByOwner.get(owner);
      if (map !== undefined) map.set(name, methodId);
    } else if (edge.type === "EXTENDS") {
      const list = extendsByOwner.get(edge.from as NodeId);
      if (list !== undefined) list.push(edge.to as NodeId);
    } else if (edge.type === "IMPLEMENTS") {
      const list = implementsByOwner.get(edge.from as NodeId);
      if (list !== undefined) list.push(edge.to as NodeId);
    }
  }
  for (const list of extendsByOwner.values()) list.sort();
  for (const list of implementsByOwner.values()) list.sort();

  // ---- Linearize each owner using its provider's MRO strategy. -----------
  const linearizationCache = new Map<NodeId, readonly string[]>();

  function linearizeFor(id: NodeId): readonly string[] {
    const cached = linearizationCache.get(id);
    if (cached !== undefined) return cached;
    // Placeholder to break cycles — the strategies do not recurse into
    // indirect ancestors through this lookup, but belt-and-suspenders.
    linearizationCache.set(id, [id as string]);
    const filePath = ownerFilePath.get(id) ?? "";
    const lang = inferLanguageFromFile(filePath);
    if (lang === undefined) {
      linearizationCache.set(id, [id as string]);
      return [id as string];
    }
    const provider = getProvider(lang);
    const strategy = getMroStrategy(provider.mroStrategy);
    if (provider.mroStrategy === "none") {
      linearizationCache.set(id, [id as string]);
      return [id as string];
    }
    const bases = extendsByOwner.get(id) ?? [];
    try {
      const linearization = strategy.linearize(id as string, bases as string[], (baseId) =>
        linearizeFor(baseId as NodeId),
      );
      linearizationCache.set(id, linearization);
      return linearization;
    } catch (err) {
      if (err instanceof MroConflictError) {
        ctx.onProgress?.({
          phase: MRO_PHASE_NAME,
          kind: "warn",
          message: `mro: conflict linearising ${id}: ${err.message}`,
        });
        linearizationCache.set(id, [id as string]);
        conflictCount += 1;
        return [id as string];
      }
      throw err;
    }
  }

  let conflictCount = 0;
  let overridesCount = 0;
  let implementsCount = 0;

  for (const id of ownerIds) {
    const ownerPath = ownerFilePath.get(id) ?? "";
    const lang = inferLanguageFromFile(ownerPath);
    if (lang === undefined) continue;
    const provider = getProvider(lang);
    if (provider.mroStrategy === "none") continue;

    const ownerMethods = methodsByOwner.get(id) ?? new Map();
    if (ownerMethods.size === 0) continue;

    // Incremental gate: owners outside the closure keep their prior-graph
    // MRO edges (carried forward above). Correctness for the in-closure
    // case holds because incremental-scope already widened the closure by
    // one heritage hop.
    if (view.active && !view.closure.has(ownerPath)) continue;

    // Sort method names for deterministic iteration.
    const sortedNames = [...ownerMethods.keys()].sort();

    // `METHOD_OVERRIDES`: walk the class's linearization; the first ancestor
    // with a matching method wins. Skip the class itself (index 0).
    const linearization = linearizeFor(id);
    for (const name of sortedNames) {
      const childMethodId = ownerMethods.get(name);
      if (childMethodId === undefined) continue;
      for (let i = 1; i < linearization.length; i += 1) {
        const ancestor = linearization[i] as NodeId | undefined;
        if (ancestor === undefined) continue;
        // Skip interface/trait ancestors — they produce METHOD_IMPLEMENTS
        // instead. We detect by kind.
        const ancestorKind = nodeKindById.get(ancestor);
        if (ancestorKind === "Interface" || ancestorKind === "Trait") continue;
        const ancestorMethods = methodsByOwner.get(ancestor);
        if (ancestorMethods === undefined) continue;
        const parentMethodId = ancestorMethods.get(name);
        if (parentMethodId === undefined) continue;
        ctx.graph.addEdge({
          from: childMethodId,
          to: parentMethodId,
          type: "METHOD_OVERRIDES",
          confidence: 0.9,
          reason: "mro-linearization",
        });
        overridesCount += 1;
        break; // first hit wins in the linearization.
      }
    }

    // `METHOD_IMPLEMENTS`: direct `IMPLEMENTS` edges identify interfaces /
    // traits whose contract the class claims. For each same-name method on
    // those interfaces emit the edge.
    const interfaces = implementsByOwner.get(id) ?? [];
    for (const name of sortedNames) {
      const childMethodId = ownerMethods.get(name);
      if (childMethodId === undefined) continue;
      for (const ifaceId of interfaces) {
        const ifaceMethods = methodsByOwner.get(ifaceId);
        if (ifaceMethods === undefined) continue;
        const interfaceMethodId = ifaceMethods.get(name);
        if (interfaceMethodId === undefined) continue;
        ctx.graph.addEdge({
          from: childMethodId,
          to: interfaceMethodId,
          type: "METHOD_IMPLEMENTS",
          confidence: 0.95,
          reason: "interface-contract",
        });
        implementsCount += 1;
      }
    }
  }

  return { overridesCount, implementsCount, conflictCount };
}

function inferLanguageFromFile(filePath: string): LanguageId | undefined {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return undefined;
  const ext = filePath.slice(idx).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx":
      return "javascript";
    case ".py":
    case ".pyi":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".cs":
      return "csharp";
    case ".c":
    case ".h":
      // .h is ambiguous between C/C++; default to C. A dedicated C++ header
      // detector can upgrade the classification later.
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
    case ".hh":
    case ".hxx":
      return "cpp";
    case ".rb":
      return "ruby";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".swift":
      return "swift";
    case ".php":
    case ".php3":
    case ".php4":
    case ".php5":
    case ".php7":
    case ".phtml":
      return "php";
    case ".dart":
      return "dart";
    default:
      return undefined;
  }
}
