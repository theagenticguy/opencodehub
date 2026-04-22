// Python-targeted stack-graph builder.
//
// Given a tree-sitter CST for a Python file this module produces a stack
// graph whose structure mirrors the intent of the vendored Python tsg rules
// without reusing upstream code. We inspect the parsed rule file only to
// guard our visitor: if the rule file lacks a pattern for a given Python
// construct (e.g. `module`) we skip synthesising nodes for it, so our graph
// never claims more structure than the vendored rules authorise.
//
// The graph we emit captures four shapes that drive Python re-export
// resolution:
//   1. module root scope + root entry/exit
//   2. top-level definitions (function / class / const) as pop nodes
//   3. import forms (import, from-import, wildcard) producing push/pop
//      chains and ROOT edges
//   4. reference sites inside function bodies (call / attribute) as push
//      nodes keyed by (line, column) so the resolver can look them up
//
// We intentionally do not model function-local scope machinery or scoped
// symbols — Python's class/method resolution in OpenCodeHub is handled by
// the C3 MRO walker; stack-graphs here specifically targets cross-module
// and re-export resolution.

import type {
  NodeId,
  StackGraph,
  StackGraphEdge,
  StackGraphNode,
  StackNodeKind,
  TsgRule,
} from "./types.js";

/**
 * Minimal view of a tree-sitter node — duck-typed so we can pass either a
 * real `Parser.SyntaxNode` from tree-sitter or a test fixture. Only the
 * fields we use are declared; that lets fixtures omit the dozens of other
 * properties.
 */
export interface MinimalTsNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly childCount: number;
  child(index: number): MinimalTsNode | null;
  childForFieldName(name: string): MinimalTsNode | null;
  readonly namedChildCount: number;
  namedChild(index: number): MinimalTsNode | null;
}

export interface MinimalTsTree {
  readonly rootNode: MinimalTsNode;
}

interface MutableGraph {
  readonly file: string;
  readonly nodes: Map<NodeId, StackGraphNode>;
  readonly edges: StackGraphEdge[];
  readonly referenceIndex: Map<string, NodeId>;
  readonly rootNodeId: NodeId;
  readonly moduleScopeId: NodeId;
  seq: number;
}

function nextId(g: MutableGraph, kind: StackNodeKind): NodeId {
  g.seq++;
  return `${g.file}#${kind}-${g.seq}`;
}

function addNode(
  g: MutableGraph,
  kind: StackNodeKind,
  opts: {
    readonly symbol?: string;
    readonly definitionTarget?: string;
    readonly line?: number;
  } = {},
): NodeId {
  const id = nextId(g, kind);
  const base = { id, kind, file: g.file } as const;
  const node: StackGraphNode = {
    ...base,
    ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
    ...(opts.definitionTarget !== undefined ? { definitionTarget: opts.definitionTarget } : {}),
    ...(opts.line !== undefined ? { line: opts.line } : {}),
  };
  g.nodes.set(id, node);
  return id;
}

function addEdge(g: MutableGraph, source: NodeId, target: NodeId, precedence = 0): void {
  g.edges.push({ source, target, precedence });
}

/** Iterate every named descendant breadth-first. Stable order. */
function* walkNamed(root: MinimalTsNode): IterableIterator<MinimalTsNode> {
  const queue: MinimalTsNode[] = [root];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) continue;
    yield cur;
    for (let i = 0; i < cur.namedChildCount; i++) {
      const c = cur.namedChild(i);
      if (c !== null) queue.push(c);
    }
  }
}

function positionKey(line: number, column: number): string {
  return `${line}:${column}`;
}

/** Build a graph for a single Python file. */
export function buildStackGraph(
  file: string,
  tree: MinimalTsTree,
  rules: readonly TsgRule[],
): StackGraph {
  const rootNodeId: NodeId = `${file}#root`;
  const moduleScopeId: NodeId = `${file}#module-scope`;
  const graph: MutableGraph = {
    file,
    nodes: new Map<NodeId, StackGraphNode>(),
    edges: [],
    referenceIndex: new Map<string, NodeId>(),
    rootNodeId,
    moduleScopeId,
    seq: 0,
  };
  graph.nodes.set(rootNodeId, { id: rootNodeId, kind: "root", file });
  graph.nodes.set(moduleScopeId, { id: moduleScopeId, kind: "scope", file });
  addEdge(graph, rootNodeId, moduleScopeId, 0);

  // Gate visitors on the parsed rule set. A rule firing on `module` means the
  // upstream ruleset authorises us to walk modules; missing the rule disables
  // our synthesiser for that kind.
  const authorised = new Set<string>();
  for (const rule of rules) {
    for (const pat of rule.patterns) authorised.add(pat.nodeType);
  }

  const root = tree.rootNode;
  if (!authorised.has("module") && root.type !== "module") {
    // Unknown rule set — return an empty graph so callers can fall back.
    return finalise(graph);
  }

  visitTopLevel(root, graph, authorised);
  return finalise(graph);
}

function finalise(g: MutableGraph): StackGraph {
  return {
    file: g.file,
    nodes: new Map(g.nodes),
    edges: g.edges.slice(),
    rootNodeId: g.rootNodeId,
    referenceIndex: new Map(g.referenceIndex),
  };
}

/** Module-level walk — definitions, imports, and function bodies. */
function visitTopLevel(
  moduleNode: MinimalTsNode,
  g: MutableGraph,
  authorised: ReadonlySet<string>,
): void {
  for (let i = 0; i < moduleNode.namedChildCount; i++) {
    const child = moduleNode.namedChild(i);
    if (child === null) continue;
    dispatchStatement(child, g, authorised);
  }
}

function dispatchStatement(
  node: MinimalTsNode,
  g: MutableGraph,
  authorised: ReadonlySet<string>,
): void {
  switch (node.type) {
    case "import_statement":
      if (authorised.has("import_statement")) handleImport(node, g);
      break;
    case "import_from_statement":
      if (authorised.has("import_from_statement")) handleFromImport(node, g);
      break;
    case "function_definition":
      if (authorised.has("function_definition")) handleFunctionDef(node, g, authorised);
      break;
    case "class_definition":
      if (authorised.has("class_definition")) handleClassDef(node, g, authorised);
      break;
    case "expression_statement":
      // Assignment targets like `__all__ = [...]` are interpreted by the
      // post-processor; we don't add stack-graph nodes for them.
      break;
    default: {
      // Recurse into decorated defs, if statements, etc., so we still reach
      // function/class definitions and reference sites living inside them.
      for (const named of walkNamed(node)) {
        if (named === node) continue;
        if (
          named.type === "function_definition" ||
          named.type === "class_definition" ||
          named.type === "import_statement" ||
          named.type === "import_from_statement"
        ) {
          dispatchStatement(named, g, authorised);
        }
      }
    }
  }
}

function dottedNameSegments(node: MinimalTsNode): readonly string[] {
  if (node.type === "identifier") return [node.text];
  if (node.type === "dotted_name") {
    const out: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c === null) continue;
      if (c.type === "identifier") out.push(c.text);
    }
    return out;
  }
  return [node.text];
}

function handleImport(node: MinimalTsNode, g: MutableGraph): void {
  // `import foo.bar [as baz]` — bind `foo` (or alias) to the module path.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child === null) continue;
    if (child.type === "dotted_name") {
      const segments = dottedNameSegments(child);
      if (segments.length === 0) continue;
      const head = segments[0];
      if (head === undefined) continue;
      bindModuleAlias(g, head, segments, node.startPosition.row + 1);
    } else if (child.type === "aliased_import") {
      const nameChild = child.childForFieldName("name");
      const aliasChild = child.childForFieldName("alias");
      if (nameChild === null) continue;
      const segments = dottedNameSegments(nameChild);
      const alias = aliasChild?.text ?? segments[0];
      if (alias === undefined) continue;
      bindModuleAlias(g, alias, segments, node.startPosition.row + 1);
    }
  }
}

function bindModuleAlias(
  g: MutableGraph,
  alias: string,
  targetSegments: readonly string[],
  line: number,
): void {
  // A local definition that pops the alias symbol and points to ROOT via
  // a push chain of the target segments — so when a reference later pushes
  // `alias`, the path lands on ROOT with `segments` still to pop.
  const defNode = addNode(g, "pop", {
    symbol: alias,
    definitionTarget: targetSegments.join("."),
    line,
  });
  addEdge(g, g.moduleScopeId, defNode, 1);
  // Push chain: each segment becomes a push node in reverse order so the
  // final edge lands on ROOT.
  let cursor = defNode;
  for (const segment of targetSegments) {
    const pushNode = addNode(g, "push", { symbol: segment, line });
    addEdge(g, cursor, pushNode, 0);
    cursor = pushNode;
  }
  addEdge(g, cursor, g.rootNodeId, 0);
}

function handleFromImport(node: MinimalTsNode, g: MutableGraph): void {
  const moduleField = node.childForFieldName("module_name");
  if (moduleField === null) return;
  const modulePath = resolveModulePath(moduleField);
  if (modulePath === null) return;

  const names = collectImportedNames(node);
  const line = node.startPosition.row + 1;
  for (const binding of names) {
    if (binding.kind === "wildcard") {
      // Wildcard: every symbol reachable from the target module's scope
      // becomes reachable from ours. We model this with a precedence-1
      // edge from module-scope through a push chain to ROOT.
      emitFromImportChain(g, null, modulePath, line, /*precedence*/ 1);
      continue;
    }
    emitFromImportChain(g, binding, modulePath, line, /*precedence*/ 2);
  }
}

interface ImportedName {
  readonly kind: "named";
  readonly local: string;
  readonly imported: string;
}
interface WildcardName {
  readonly kind: "wildcard";
}

function collectImportedNames(node: MinimalTsNode): readonly (ImportedName | WildcardName)[] {
  const out: (ImportedName | WildcardName)[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c === null) continue;
    if (c.type === "wildcard_import") {
      out.push({ kind: "wildcard" });
      continue;
    }
    // Skip the module_name child — it appears as a named child too.
    const moduleField = node.childForFieldName("module_name");
    if (moduleField !== null && c === moduleField) continue;

    if (c.type === "dotted_name") {
      const segs = dottedNameSegments(c);
      const name = segs[0];
      if (name !== undefined) out.push({ kind: "named", local: name, imported: name });
    } else if (c.type === "aliased_import") {
      const nameChild = c.childForFieldName("name");
      const aliasChild = c.childForFieldName("alias");
      if (nameChild === null) continue;
      const imported = dottedNameSegments(nameChild)[0];
      const local = aliasChild?.text ?? imported;
      if (imported !== undefined && local !== undefined) {
        out.push({ kind: "named", local, imported });
      }
    }
  }
  return out;
}

function resolveModulePath(field: MinimalTsNode): readonly string[] | null {
  if (field.type === "dotted_name") return dottedNameSegments(field);
  if (field.type === "relative_import") {
    // `from . import x` or `from ..pkg import y` — we flatten dots into
    // leading empty segments so the resolver can interpret them later.
    const segments: string[] = [];
    for (let i = 0; i < field.namedChildCount; i++) {
      const c = field.namedChild(i);
      if (c === null) continue;
      if (c.type === "import_prefix") {
        for (const _ of c.text) segments.push("");
      } else if (c.type === "dotted_name") {
        segments.push(...dottedNameSegments(c));
      }
    }
    return segments;
  }
  return null;
}

function emitFromImportChain(
  g: MutableGraph,
  binding: ImportedName | null,
  modulePath: readonly string[],
  line: number,
  precedence: number,
): void {
  // Definition (pop) for the locally-bound name, or a scope junction for
  // wildcards so every push that reaches the module scope forwards on.
  const defNode =
    binding === null
      ? addNode(g, "scope", { line })
      : addNode(g, "pop", {
          symbol: binding.local,
          definitionTarget: `${modulePath.join(".")}.${binding.imported}`,
          line,
        });
  addEdge(g, g.moduleScopeId, defNode, precedence);

  // Emit the push chain: imported-name then each module segment in reverse.
  let cursor = defNode;
  if (binding !== null) {
    const pushImported = addNode(g, "push", { symbol: binding.imported, line });
    addEdge(g, cursor, pushImported, 0);
    cursor = pushImported;
  }
  for (const segment of modulePath) {
    if (segment === "") continue; // skip relative-prefix placeholders
    const pushSegment = addNode(g, "push", { symbol: segment, line });
    addEdge(g, cursor, pushSegment, 0);
    cursor = pushSegment;
  }
  addEdge(g, cursor, g.rootNodeId, 0);
}

function handleFunctionDef(
  node: MinimalTsNode,
  g: MutableGraph,
  authorised: ReadonlySet<string>,
): void {
  const nameChild = node.childForFieldName("name");
  if (nameChild === null) return;
  const line = node.startPosition.row + 1;
  const defNode = addNode(g, "pop", {
    symbol: nameChild.text,
    definitionTarget: nameChild.text,
    line,
  });
  addEdge(g, g.moduleScopeId, defNode, 2);

  // Walk the body to index reference sites.
  const body = node.childForFieldName("body");
  if (body !== null) indexReferences(body, g, authorised);
}

function handleClassDef(
  node: MinimalTsNode,
  g: MutableGraph,
  authorised: ReadonlySet<string>,
): void {
  const nameChild = node.childForFieldName("name");
  if (nameChild === null) return;
  const line = node.startPosition.row + 1;
  const defNode = addNode(g, "pop", {
    symbol: nameChild.text,
    definitionTarget: nameChild.text,
    line,
  });
  addEdge(g, g.moduleScopeId, defNode, 2);
  const body = node.childForFieldName("body");
  if (body !== null) indexReferences(body, g, authorised);
}

function indexReferences(
  root: MinimalTsNode,
  g: MutableGraph,
  authorised: ReadonlySet<string>,
): void {
  for (const node of walkNamed(root)) {
    if (node.type === "identifier") {
      if (!authorised.has("identifier")) continue;
      // Skip identifiers that are themselves names of nested defs.
      // Heuristic: we index every identifier and rely on the resolver to
      // filter — position-keyed lookup means false-positives are harmless.
      const line = node.startPosition.row + 1;
      const col = node.startPosition.column;
      const key = positionKey(line, col);
      if (g.referenceIndex.has(key)) continue;
      const pushNode = addNode(g, "push", { symbol: node.text, line });
      addEdge(g, pushNode, g.moduleScopeId, 0);
      g.referenceIndex.set(key, pushNode);
    }
  }
}
