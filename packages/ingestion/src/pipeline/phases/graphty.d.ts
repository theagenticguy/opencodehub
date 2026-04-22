/**
 * Ambient declarations for `@graphty/algorithms`.
 *
 * The package's hand-written top-level `dist/algorithms.d.ts` re-exports
 * internal modules with extensionless paths that do not resolve under
 * `moduleResolution: NodeNext`. The runtime bundle exports every symbol we
 * need correctly (verified by direct import at Node), so we declare the
 * narrow surface we consume here and let the TypeScript compiler trust us.
 * If the upstream package ships correct NodeNext-compatible typings this
 * file can be deleted without code changes.
 */

declare module "@graphty/algorithms" {
  export interface GraphConfig {
    readonly directed?: boolean;
    readonly allowSelfLoops?: boolean;
    readonly allowParallelEdges?: boolean;
  }

  export class Graph {
    constructor(config?: Partial<GraphConfig>);
    addNode(id: string, data?: Record<string, unknown>): void;
    addEdge(source: string, target: string, weight?: number, data?: Record<string, unknown>): void;
    hasNode(id: string): boolean;
    hasEdge(source: string, target: string): boolean;
    nodeCount(): number;
    edgeCount(): number;
  }

  export interface LeidenOptions {
    readonly resolution?: number;
    readonly randomSeed?: number;
    readonly maxIterations?: number;
    readonly threshold?: number;
  }

  export interface LeidenResult {
    readonly communities: Map<string, number>;
    readonly modularity: number;
    readonly iterations: number;
  }

  export function leiden(graph: Graph, options?: LeidenOptions): LeidenResult;
}
