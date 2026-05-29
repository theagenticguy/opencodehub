/**
 * Vendored Leiden community-detection + minimal Graph, ported verbatim from
 * `@graphty/algorithms@1.7.1` (MIT). We vendor only the `Graph` class,
 * `graphToMap`, the `SeededRandom`/`shuffle` helpers, and the `leiden`
 * entry point — the exact closure the communities phase needs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@graphty/algorithms` hard-declares `pupt` as a dependency, which in turn
 * hard-declares `@homebridge/node-pty-prebuilt-multiarch`, whose `install`
 * lifecycle script runs `prebuild-install --verbose` and fetches a native
 * binary from `github.com/.../releases`. graphty's compiled library never
 * imports `pupt`, so that chain is pure upstream dependency bloat — but a
 * downstream `npm install -g @opencodehub/ingestion` still resolves the
 * published tarball's deps fresh from the registry and runs that fetch.
 * `overrides` in ingestion's own published package.json do NOT suppress it:
 * npm honours `overrides` only for the root project, and a globally-installed
 * tarball is a dependency of npm's synthetic root, not the root itself
 * (verified empirically). Vendoring the small, pure-TS Leiden closure removes
 * `@graphty/algorithms` from the published dependency tree entirely, killing
 * the node-pty fetch at the install surface while preserving byte-identical
 * community assignments (the port is line-for-line faithful to the upstream
 * compiled output and is covered by a parity test).
 *
 * DETERMINISM
 * -----------
 * `leiden` is parameterised with a fixed seed by the communities phase. The
 * partition is sensitive to node insertion order, edge enumeration order, and
 * edge weights — all of which this port preserves exactly: `Graph.nodes()`
 * yields in insertion order, `Graph.edges()` enumerates the adjacency list in
 * insertion order skipping the mirror half of undirected edges, and
 * `SeededRandom` is the same linear-congruential generator graphty ships.
 *
 * Upstream: https://github.com/graphty-org/algorithms (MIT, (c) 2024 Adam Powers)
 * Source modules vendored: core/graph.js, utils/graph-converters.js
 * (graphToMap only), utils/math-utilities.js (SeededRandom + shuffle),
 * algorithms/community/leiden.js.
 */

// ----------------------------------------------------------------------------
// MIT License
//
// Copyright (c) 2024 Adam Powers
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// ----------------------------------------------------------------------------

type NodeKey = string;

interface GraphConfig {
  directed: boolean;
  allowSelfLoops: boolean;
  allowParallelEdges: boolean;
}

interface GraphNode {
  id: NodeKey;
}

interface GraphEdge {
  source: NodeKey;
  target: NodeKey;
  weight: number;
}

/**
 * Minimal port of graphty's core Graph. Only the surface the Leiden path
 * touches is retained (construct, addNode, addEdge, hasEdge, nodes(),
 * edges(), isDirected), preserving the exact iteration order the upstream
 * class produced.
 */
export class Graph {
  private readonly config: GraphConfig;
  private readonly nodeMap: Map<NodeKey, GraphNode>;
  private readonly adjacencyList: Map<NodeKey, Map<NodeKey, GraphEdge>>;

  constructor(config: Partial<GraphConfig> = {}) {
    this.config = {
      directed: false,
      allowSelfLoops: true,
      allowParallelEdges: false,
      ...config,
    };
    this.nodeMap = new Map();
    this.adjacencyList = new Map();
  }

  addNode(id: NodeKey): void {
    if (!this.nodeMap.has(id)) {
      this.nodeMap.set(id, { id });
      this.adjacencyList.set(id, new Map());
    }
  }

  addEdge(source: NodeKey, target: NodeKey, weight = 1): void {
    // Ensure both nodes exist.
    this.addNode(source);
    this.addNode(target);
    // Check self-loops.
    if (!this.config.allowSelfLoops && source === target) {
      throw new Error("Self-loops are not allowed in this graph");
    }
    // Check parallel edges.
    if (!this.config.allowParallelEdges && this.hasEdge(source, target)) {
      throw new Error("Parallel edges are not allowed in this graph");
    }
    const edge: GraphEdge = { source, target, weight };
    const sourceAdjacency = this.adjacencyList.get(source);
    if (sourceAdjacency) {
      sourceAdjacency.set(target, edge);
    }
    if (this.config.directed) {
      // Directed graphs only track outgoing adjacency for the Leiden path.
    } else {
      // For undirected graphs, add the reverse edge.
      if (source !== target) {
        const reverseEdge: GraphEdge = { source: target, target: source, weight };
        const targetAdjacency = this.adjacencyList.get(target);
        if (targetAdjacency) {
          targetAdjacency.set(source, reverseEdge);
        }
      }
    }
  }

  hasEdge(source: NodeKey, target: NodeKey): boolean {
    const sourceEdges = this.adjacencyList.get(source);
    return sourceEdges ? sourceEdges.has(target) : false;
  }

  get isDirected(): boolean {
    return this.config.directed;
  }

  nodes(): IterableIterator<GraphNode> {
    return this.nodeMap.values();
  }

  *edges(): Generator<GraphEdge> {
    for (const [source, edges] of this.adjacencyList) {
      for (const edge of edges.values()) {
        // For undirected graphs, only yield each edge once.
        if (!this.config.directed && source > edge.target) {
          continue;
        }
        yield edge;
      }
    }
  }
}

/**
 * Convert a Graph instance to the nested-Map representation Leiden consumes.
 * Outer keys are source nodes; inner maps hold target nodes with edge weights.
 */
function graphToMap(graph: Graph): Map<NodeKey, Map<NodeKey, number>> {
  const map = new Map<NodeKey, Map<NodeKey, number>>();
  // Initialize all nodes.
  for (const node of graph.nodes()) {
    map.set(String(node.id), new Map());
  }
  // Add edges with weights.
  for (const edge of graph.edges()) {
    const source = String(edge.source);
    const target = String(edge.target);
    const weight = edge.weight ?? 1;
    const sourceMap = map.get(source);
    if (sourceMap) {
      sourceMap.set(target, weight);
    }
    // For undirected graphs, add the reverse edge.
    if (!graph.isDirected) {
      const targetMap = map.get(target);
      if (targetMap) {
        targetMap.set(source, weight);
      }
    }
  }
  return map;
}

/**
 * Seeded linear-congruential generator for reproducible results — the exact
 * generator graphty ships, so partitions match seed-for-seed.
 */
class SeededRandom {
  private readonly m: number;
  private readonly a: number;
  private readonly c: number;
  private seed: number;

  constructor(seed: number) {
    this.m = 0x80000000; // 2**31
    this.a = 1103515245;
    this.c = 12345;
    // Handle negative seeds correctly.
    this.seed = ((seed % this.m) + this.m) % this.m;
  }

  next(): number {
    this.seed = (this.a * this.seed + this.c) % this.m;
    return this.seed / (this.m - 1);
  }

  static createGenerator(seed: number): () => number {
    const rng = new SeededRandom(seed);
    return () => rng.next();
  }
}

/**
 * Fisher-Yates shuffle (in place), driven by the supplied RNG.
 */
function shuffle<T>(array: T[], rng: () => number = Math.random): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const temp = array[i];
    const tempJ = array[j];
    if (temp !== undefined && tempJ !== undefined) {
      array[i] = tempJ;
      array[j] = temp;
    }
  }
  return array;
}

type AdjacencyMap = Map<NodeKey, Map<NodeKey, number>>;

export interface LeidenOptions {
  resolution?: number;
  randomSeed?: number;
  maxIterations?: number;
  threshold?: number;
}

export interface LeidenResult {
  communities: Map<NodeKey, number>;
  modularity: number;
  iterations: number;
}

/**
 * Internal Leiden implementation operating on the nested-Map representation.
 */
function leidenImpl(inputGraph: AdjacencyMap, options: LeidenOptions = {}): LeidenResult {
  const { resolution = 1.0, randomSeed = 42, maxIterations = 100, threshold = 1e-7 } = options;
  // Handle empty graph.
  if (inputGraph.size === 0) {
    return {
      communities: new Map(),
      modularity: 0,
      iterations: 0,
    };
  }
  // Use a mutable variable for the current graph state.
  let currentGraph = inputGraph;
  // Initialize random number generator.
  const random = SeededRandom.createGenerator(randomSeed);
  // Calculate total weight.
  let totalWeight = 0;
  const degrees = new Map<NodeKey, number>();
  for (const [node, neighbors] of currentGraph) {
    let degree = 0;
    for (const weight of neighbors.values()) {
      degree += weight;
      totalWeight += weight;
    }
    degrees.set(node, degree);
  }
  totalWeight /= 2; // Each edge counted twice.
  // Initialize communities - each node in its own community.
  const communities = new Map<NodeKey, number>();
  const nodes = Array.from(currentGraph.keys());
  nodes.forEach((node, i) => {
    communities.set(node, i);
  });
  let modularity = calculateModularity(currentGraph, communities, degrees, totalWeight, resolution);
  let bestModularity = modularity;
  let bestCommunities = new Map(communities);
  let iterations = 0;
  // Main Leiden loop.
  while (iterations < maxIterations) {
    iterations++;
    let improved = false;
    // Phase 1: Local moving of nodes (fast).
    const nodeOrder = [...nodes];
    shuffle(nodeOrder, random);
    for (const node of nodeOrder) {
      const currentCommunity = communities.get(node);
      if (currentCommunity === undefined) {
        continue;
      }
      const neighborCommunities = getNeighborCommunities(node, currentGraph, communities);
      let bestCommunity = currentCommunity;
      let bestGain = 0;
      // Try moving to each neighbor community.
      for (const [community] of neighborCommunities) {
        if (community === currentCommunity) {
          continue;
        }
        const gain = calculateModularityGain(
          node,
          community,
          currentGraph,
          communities,
          degrees,
          totalWeight,
          resolution,
        );
        if (gain > bestGain) {
          bestGain = gain;
          bestCommunity = community;
        }
      }
      // Move node if beneficial.
      if (bestCommunity !== currentCommunity) {
        communities.set(node, bestCommunity);
        modularity += bestGain;
        improved = true;
      }
    }
    // Phase 2: Refinement (Leiden improvement over Louvain).
    // Create aggregate network based on current partition.
    createAggregateNetwork(currentGraph, communities);
    // Refine partition using aggregate network.
    const subsetPartition = refinePartition(currentGraph, communities);
    // Apply refined partition.
    for (const [node, newCommunity] of subsetPartition) {
      communities.set(node, newCommunity);
    }
    // Recalculate modularity.
    modularity = calculateModularity(currentGraph, communities, degrees, totalWeight, resolution);
    // Check if we've improved.
    if (modularity > bestModularity + threshold) {
      bestModularity = modularity;
      bestCommunities = new Map(communities);
      improved = true;
    }
    if (!improved) {
      break;
    }
    // Phase 3: Aggregate network (create super-nodes).
    const aggregated = aggregateCommunities(currentGraph, communities);
    if (aggregated.graph.size === currentGraph.size) {
      break;
    } // No aggregation possible.
    // Continue with aggregated network.
    const { graph: aggregatedGraph } = aggregated;
    currentGraph = aggregatedGraph;
    communities.clear();
    let communityId = 0;
    for (const node of currentGraph.keys()) {
      communities.set(node, communityId++);
    }
  }
  // Map back to original nodes.
  const finalCommunities = new Map<NodeKey, number>();
  for (const [node, community] of bestCommunities) {
    finalCommunities.set(node, community);
  }
  // Renumber communities consecutively.
  const communityRenumber = new Map<number, number>();
  let newId = 0;
  for (const community of new Set(finalCommunities.values())) {
    communityRenumber.set(community, newId++);
  }
  for (const [node, community] of finalCommunities) {
    const newCommunityId = communityRenumber.get(community);
    if (newCommunityId !== undefined) {
      finalCommunities.set(node, newCommunityId);
    }
  }
  return {
    communities: finalCommunities,
    modularity: bestModularity,
    iterations,
  };
}

/**
 * Calculate modularity of a partition.
 */
function calculateModularity(
  graph: AdjacencyMap,
  communities: Map<NodeKey, number>,
  degrees: Map<NodeKey, number>,
  totalWeight: number,
  resolution: number,
): number {
  let modularity = 0;
  const communityWeights = new Map<number, number>();
  // Calculate internal weights for each community.
  for (const [node, neighbors] of graph) {
    const nodeCommunity = communities.get(node);
    if (nodeCommunity === undefined) {
      continue;
    }
    for (const [neighbor, weight] of neighbors) {
      const neighborCommunity = communities.get(neighbor);
      if (neighborCommunity === undefined) {
        continue;
      }
      if (nodeCommunity === neighborCommunity) {
        modularity += weight;
      }
    }
    const degree = degrees.get(node);
    if (degree !== undefined) {
      communityWeights.set(nodeCommunity, (communityWeights.get(nodeCommunity) ?? 0) + degree);
    }
  }
  // Handle empty graph or zero weight.
  if (totalWeight === 0) {
    return 0;
  }
  // Normalize and apply resolution.
  modularity /= 2 * totalWeight;
  // Subtract expected edges.
  for (const weight of communityWeights.values()) {
    modularity -= resolution * (weight / (2 * totalWeight)) ** 2;
  }
  return modularity;
}

/**
 * Get communities of neighbors.
 */
function getNeighborCommunities(
  node: NodeKey,
  graph: AdjacencyMap,
  communities: Map<NodeKey, number>,
): Map<number, number> {
  const neighborCommunities = new Map<number, number>();
  const neighbors = graph.get(node);
  if (neighbors) {
    for (const [neighbor, weight] of neighbors) {
      const community = communities.get(neighbor);
      if (community !== undefined) {
        neighborCommunities.set(community, (neighborCommunities.get(community) ?? 0) + weight);
      }
    }
  }
  return neighborCommunities;
}

/**
 * Calculate modularity gain from moving a node to a community.
 */
function calculateModularityGain(
  node: NodeKey,
  targetCommunity: number,
  graph: AdjacencyMap,
  communities: Map<NodeKey, number>,
  degrees: Map<NodeKey, number>,
  totalWeight: number,
  resolution: number,
): number {
  const currentCommunity = communities.get(node);
  const nodeDegree = degrees.get(node);
  if (currentCommunity === undefined || nodeDegree === undefined) {
    return 0;
  }
  // Weight of edges from node to target community.
  let weightToTarget = 0;
  let weightToCurrent = 0;
  const neighbors = graph.get(node);
  if (neighbors) {
    for (const [neighbor, weight] of neighbors) {
      const neighborCommunity = communities.get(neighbor);
      if (neighborCommunity === undefined) {
        continue;
      }
      if (neighborCommunity === targetCommunity) {
        weightToTarget += weight;
      } else if (neighborCommunity === currentCommunity && neighbor !== node) {
        weightToCurrent += weight;
      }
    }
  }
  // Calculate community degrees.
  let targetDegree = 0;
  let currentDegree = 0;
  for (const [n, c] of communities) {
    if (c === targetCommunity && n !== node) {
      const deg = degrees.get(n);
      if (deg !== undefined) {
        targetDegree += deg;
      }
    } else if (c === currentCommunity && n !== node) {
      const deg = degrees.get(n);
      if (deg !== undefined) {
        currentDegree += deg;
      }
    }
  }
  // Modularity gain calculation.
  const m2 = 2 * totalWeight;
  const gain =
    (weightToTarget - weightToCurrent) / totalWeight -
    (resolution * nodeDegree * (targetDegree - currentDegree)) / (m2 * m2);
  return gain;
}

/**
 * Create aggregate network where each community becomes a super-node.
 * (Retained verbatim from upstream; the result is intentionally discarded by
 * the caller — the side-effect-free call preserves identical control flow.)
 */
function createAggregateNetwork(
  graph: AdjacencyMap,
  communities: Map<NodeKey, number>,
): { aggregateGraph: Map<number, Map<number, number>>; nodeMapping: Map<NodeKey, number> } {
  const aggregateGraph = new Map<number, Map<number, number>>();
  const nodeMapping = new Map<NodeKey, number>();
  // Create mapping from nodes to communities.
  for (const [node, community] of communities) {
    nodeMapping.set(node, community);
    if (!aggregateGraph.has(community)) {
      aggregateGraph.set(community, new Map());
    }
  }
  // Aggregate edges.
  for (const [node, neighbors] of graph) {
    const sourceCommunity = communities.get(node);
    if (sourceCommunity === undefined) {
      continue;
    }
    for (const [neighbor, weight] of neighbors) {
      const targetCommunity = communities.get(neighbor);
      if (targetCommunity === undefined) {
        continue;
      }
      const sourceNeighbors = aggregateGraph.get(sourceCommunity);
      if (sourceNeighbors) {
        const current = sourceNeighbors.get(targetCommunity) ?? 0;
        sourceNeighbors.set(targetCommunity, current + weight);
      }
    }
  }
  return { aggregateGraph, nodeMapping };
}

/**
 * Refine partition (Leiden-specific improvement). Ensures well-connected
 * communities by considering subsets.
 */
function refinePartition(
  originalGraph: AdjacencyMap,
  communities: Map<NodeKey, number>,
): Map<NodeKey, number> {
  const refined = new Map<NodeKey, number>();
  // For each community, check if it should be split.
  const communityNodes = new Map<number, NodeKey[]>();
  for (const [node, community] of communities) {
    if (!communityNodes.has(community)) {
      communityNodes.set(community, []);
    }
    const nodes = communityNodes.get(community);
    if (nodes) {
      nodes.push(node);
    }
  }
  let newCommunityId = 0;
  for (const [community, nodes] of communityNodes) {
    if (nodes.length === 1) {
      // Single node community.
      const singleNode = nodes[0];
      if (singleNode) {
        refined.set(singleNode, newCommunityId++);
      }
      continue;
    }
    // Check connectivity within community.
    const subgraph = new Map<NodeKey, Set<NodeKey>>();
    for (const node of nodes) {
      subgraph.set(node, new Set());
      const neighbors = originalGraph.get(node);
      if (neighbors) {
        for (const [neighbor] of neighbors) {
          if (communities.get(neighbor) === community) {
            const nodeSet = subgraph.get(node);
            if (nodeSet) {
              nodeSet.add(neighbor);
            }
          }
        }
      }
    }
    // Find connected components within community.
    const components = findConnectedComponents(subgraph);
    // Assign new community IDs to components.
    for (const component of components) {
      for (const node of component) {
        refined.set(node, newCommunityId);
      }
      newCommunityId++;
    }
  }
  return refined;
}

/**
 * Find connected components in an undirected graph.
 */
function findConnectedComponents(graph: Map<NodeKey, Set<NodeKey>>): Set<NodeKey>[] {
  const visited = new Set<NodeKey>();
  const components: Set<NodeKey>[] = [];
  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      const component = new Set<NodeKey>();
      const queue: NodeKey[] = [node];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined || visited.has(current)) {
          continue;
        }
        visited.add(current);
        component.add(current);
        const neighbors = graph.get(current);
        if (neighbors) {
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
              queue.push(neighbor);
            }
          }
        }
      }
      components.push(component);
    }
  }
  return components;
}

/**
 * Aggregate communities into super-nodes.
 */
function aggregateCommunities(
  graph: AdjacencyMap,
  communities: Map<NodeKey, number>,
): { graph: Map<NodeKey, Map<NodeKey, number>>; mapping: Map<NodeKey, NodeKey> } {
  const aggregated = new Map<NodeKey, Map<NodeKey, number>>();
  const mapping = new Map<NodeKey, NodeKey>();
  // Create super-nodes.
  const communityNodes = new Map<number, NodeKey>();
  for (const community of new Set(communities.values())) {
    const superNode = `super_${String(community)}`;
    communityNodes.set(community, superNode);
    aggregated.set(superNode, new Map());
  }
  // Map original nodes to super-nodes.
  for (const [node, community] of communities) {
    const superNode = communityNodes.get(community);
    if (superNode !== undefined) {
      mapping.set(node, superNode);
    }
  }
  // Aggregate edges.
  for (const [node, neighbors] of graph) {
    const sourceCommunity = communities.get(node);
    if (sourceCommunity === undefined) {
      continue;
    }
    const sourceSuper = communityNodes.get(sourceCommunity);
    if (sourceSuper === undefined) {
      continue;
    }
    for (const [neighbor, weight] of neighbors) {
      const targetCommunity = communities.get(neighbor);
      if (targetCommunity === undefined) {
        continue;
      }
      const targetSuper = communityNodes.get(targetCommunity);
      if (targetSuper === undefined) {
        continue;
      }
      if (sourceSuper !== targetSuper) {
        const sourceNeighbors = aggregated.get(sourceSuper);
        if (sourceNeighbors) {
          const current = sourceNeighbors.get(targetSuper) ?? 0;
          sourceNeighbors.set(targetSuper, current + weight);
        }
      }
    }
  }
  return { graph: aggregated, mapping };
}

/**
 * Leiden algorithm for community detection. Improves upon Louvain by ensuring
 * well-connected communities.
 *
 * @param graph - Undirected weighted graph (a {@link Graph} instance).
 * @param options - Algorithm options.
 * @returns Community assignments and modularity.
 */
export function leiden(graph: Graph, options: LeidenOptions = {}): LeidenResult {
  // Convert Graph to Map representation.
  const graphMap = graphToMap(graph);
  return leidenImpl(graphMap, options);
}
