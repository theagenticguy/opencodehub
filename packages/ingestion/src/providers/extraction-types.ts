/**
 * Extraction records emitted by language providers.
 *
 * These records are storage-agnostic intermediate values: the ingestion
 * pipeline maps them to `GraphNode` / edge writes downstream. Keeping them
 * decoupled from `@opencodehub/storage` lets providers ship in a package
 * without a persistence dependency.
 *
 * Every record carries absolute file paths + 1-indexed line numbers, matching
 * the conventions documented in `parse/types.ts`.
 */

import type { NodeKind } from "@opencodehub/core-types";

/** A defined symbol within a single file. */
export interface ExtractedDefinition {
  readonly kind: NodeKind;
  readonly name: string;
  /** Dotted form, e.g. `MyClass.myMethod`. Equals `name` for top-level syms. */
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Qualified name of the enclosing class/struct/impl, when any. */
  readonly owner?: string;
  readonly signature?: string;
  readonly parameterCount?: number;
  readonly parameterTypes?: readonly string[];
  readonly returnType?: string;
  readonly isExported: boolean;
  readonly isConst?: boolean;
}

/** A call-site record; callee resolution is applied downstream. */
export interface ExtractedCall {
  readonly callerQualifiedName: string;
  /** Unresolved identifier at the call site. */
  readonly calleeName: string;
  /** Receiver inference (e.g. `this` / `self` / `pkg`) if present. */
  readonly calleeOwner?: string;
  readonly filePath: string;
  readonly startLine: number;
}

/** Classification of an import statement's shape. */
export type ImportKind = "named" | "namespace" | "package-wildcard" | "default";

/** A normalized import declaration. */
export interface ExtractedImport {
  /** Path of the file that contains the import statement. */
  readonly filePath: string;
  /** Raw module specifier as written in source. */
  readonly source: string;
  /** Symbol names introduced by a named import. */
  readonly importedNames?: readonly string[];
  /** Whether the import pulls every exported symbol (`import *`, `from x import *`). */
  readonly isWildcard?: boolean;
  /** Local alias assigned to the module or symbol (e.g. `np` in `import numpy as np`). */
  readonly localAlias?: string;
  readonly kind: ImportKind;
}

/** A parent/child heritage edge (EXTENDS or IMPLEMENTS). */
export interface ExtractedHeritage {
  readonly childQualifiedName: string;
  /** Unresolved identifier of the parent type. */
  readonly parentName: string;
  readonly filePath: string;
  readonly relation: "EXTENDS" | "IMPLEMENTS";
  readonly startLine: number;
}

/**
 * A single property access observed inside a function/method body.
 *
 * The {@link enclosingSymbolId} is the pre-built `NodeId` for the enclosing
 * Function/Method/Constructor as derived by `idForDefinition` in the parse
 * phase — passing the fully-baked id means the accesses phase never has to
 * reconstruct it and every provider emits the identical shape.
 *
 * `propertyName` is the bare, unqualified identifier (e.g. `name`, not
 * `user.name`). `reason` is `write` for LHS-of-assignment, else `read`.
 */
export interface PropertyAccess {
  readonly enclosingSymbolId: string;
  readonly propertyName: string;
  readonly reason: "read" | "write";
  readonly startLine: number;
  readonly endLine: number;
  readonly filePath: string;
}
