import type { RelationType } from "./edges.js";
import { hash6 } from "./hash.js";
import type { NodeKind } from "./nodes.js";

export type NodeId = string & { readonly __brand: "NodeId" };
export type EdgeId = string & { readonly __brand: "EdgeId" };

const CALLABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "Function",
  "Method",
  "Constructor",
]);

export interface MakeNodeIdOptions {
  readonly parameterCount?: number;
  readonly parameterTypes?: readonly string[];
  readonly isConst?: boolean;
}

export function makeNodeId(
  kind: NodeKind,
  filePath: string,
  qualifiedName: string,
  opts: MakeNodeIdOptions = {},
): NodeId {
  let out = `${kind}:${filePath}:${qualifiedName}`;
  const needsArity = CALLABLE_KINDS.has(kind) && typeof opts.parameterCount === "number";
  if (needsArity) {
    out += `#${opts.parameterCount}`;
  }
  if (opts.parameterTypes && opts.parameterTypes.length > 0) {
    out += `~${hash6(opts.parameterTypes.join(","))}`;
  }
  if (opts.isConst === true) {
    out += "$const";
  }
  return out as NodeId;
}

export function makeEdgeId(from: NodeId, type: RelationType, to: NodeId, step?: number): EdgeId {
  const s = step ?? 0;
  return `${from}->${type}->${to}:${s}` as EdgeId;
}

export interface ParsedNodeId {
  readonly kind: NodeKind;
  readonly filePath: string;
  readonly qualifiedName: string;
  readonly parameterCount?: number;
  readonly typeHash?: string;
  readonly isConst: boolean;
}

export function parseNodeId(id: NodeId): ParsedNodeId {
  let rest = id as string;
  let isConst = false;
  if (rest.endsWith("$const")) {
    isConst = true;
    rest = rest.slice(0, -"$const".length);
  }
  let typeHash: string | undefined;
  const tildeIdx = rest.lastIndexOf("~");
  if (tildeIdx !== -1 && /^~[0-9a-f]{6}$/.test(rest.slice(tildeIdx))) {
    typeHash = rest.slice(tildeIdx + 1);
    rest = rest.slice(0, tildeIdx);
  }
  let parameterCount: number | undefined;
  const hashIdx = rest.lastIndexOf("#");
  if (hashIdx !== -1) {
    const maybeNum = rest.slice(hashIdx + 1);
    if (/^\d+$/.test(maybeNum)) {
      parameterCount = Number(maybeNum);
      rest = rest.slice(0, hashIdx);
    }
  }
  const firstColon = rest.indexOf(":");
  if (firstColon === -1) {
    throw new Error(`Invalid node id (missing kind separator): ${id}`);
  }
  const kind = rest.slice(0, firstColon) as NodeKind;
  const afterKind = rest.slice(firstColon + 1);
  const secondColon = afterKind.indexOf(":");
  if (secondColon === -1) {
    return {
      kind,
      filePath: afterKind,
      qualifiedName: "",
      ...(parameterCount !== undefined ? { parameterCount } : {}),
      ...(typeHash !== undefined ? { typeHash } : {}),
      isConst,
    };
  }
  const filePath = afterKind.slice(0, secondColon);
  const qualifiedName = afterKind.slice(secondColon + 1);
  return {
    kind,
    filePath,
    qualifiedName,
    ...(parameterCount !== undefined ? { parameterCount } : {}),
    ...(typeHash !== undefined ? { typeHash } : {}),
    isConst,
  };
}
