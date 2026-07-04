export type { CodeRelation, RelationType } from "./edges.js";
export { RELATION_TYPES } from "./edges.js";
export { KnowledgeGraph } from "./graph.js";
export { graphHash } from "./graph-hash.js";
export { canonicalJson, hash6, hashCanonicalJson, sha256Hex, writeCanonicalJson } from "./hash.js";
export type { EdgeId, MakeNodeIdOptions, NodeId, ParsedNodeId } from "./id.js";
export { makeEdgeId, makeNodeId, parseNodeId } from "./id.js";
export type { LanguageId } from "./language-id.js";
export { PROVENANCE_PREFIXES, SCIP_PROVENANCE_PREFIXES } from "./lsp-provenance.js";
export { NODE_COLUMNS, RELATION_COLUMNS } from "./node-columns.js";
export type {
  AnnotationNode,
  ClassNode,
  CodeElementNode,
  CommunityNode,
  ConstNode,
  ConstructorNode,
  ContributorNode,
  DelegateNode,
  DependencyNode,
  Embedding,
  EnumNode,
  Evidence,
  FileBranchDivergence,
  FileNode,
  FindingNode,
  FolderNode,
  FrameworkCategory,
  FrameworkDetection,
  FunctionNode,
  GraphNode,
  ImplNode,
  InterfaceNode,
  MacroNode,
  MethodNode,
  ModuleNode,
  NamespaceNode,
  NodeKind,
  NodeOfKind,
  OperationNode,
  ProcessNode,
  ProjectProfileNode,
  PropertyNode,
  RecordNode,
  RepoNode,
  RouteNode,
  SectionNode,
  StaticNode,
  StructNode,
  TemplateNode,
  ToolNode,
  TraitNode,
  TypeAliasNode,
  TypedefNode,
  UnionNode,
  VariableNode,
} from "./nodes.js";
export { NODE_KINDS } from "./nodes.js";
export { compareEdges, compareNodesById, sortEdges, sortNodes } from "./ordering.js";
export type { SchemaCompareResult } from "./schema-version.js";
export { compareSchemaVersion, SCHEMA_VERSION } from "./schema-version.js";
export type { StalenessEnvelope } from "./staleness.js";
