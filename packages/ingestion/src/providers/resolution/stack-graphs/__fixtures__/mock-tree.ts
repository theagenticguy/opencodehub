// Lightweight mock of the tree-sitter Parser.SyntaxNode surface we consume.
// Only the handful of methods the builder calls are implemented; the rest
// throw. Fixture trees are hand-assembled in tests.

import type { MinimalTsNode, MinimalTsTree } from "../node-edge-builder.js";

export interface Pos {
  readonly row: number;
  readonly column: number;
}

export interface MockNodeSpec {
  readonly type: string;
  readonly text?: string;
  readonly start?: Pos;
  readonly end?: Pos;
  readonly namedChildren?: readonly MockNodeSpec[];
  /** Named "fields" (accessed via childForFieldName). */
  readonly fields?: Readonly<Record<string, MockNodeSpec>>;
}

class MockNode implements MinimalTsNode {
  private readonly _namedChildren: readonly MockNode[];
  private readonly _fields: ReadonlyMap<string, MockNode>;

  constructor(private readonly spec: MockNodeSpec) {
    this._namedChildren = (spec.namedChildren ?? []).map((c) => new MockNode(c));
    const fields = new Map<string, MockNode>();
    if (spec.fields !== undefined) {
      for (const [k, v] of Object.entries(spec.fields)) {
        fields.set(k, new MockNode(v));
      }
    }
    this._fields = fields;
  }

  get type(): string {
    return this.spec.type;
  }
  get text(): string {
    return this.spec.text ?? "";
  }
  get startPosition(): Pos {
    return this.spec.start ?? { row: 0, column: 0 };
  }
  get endPosition(): Pos {
    return this.spec.end ?? this.startPosition;
  }
  get childCount(): number {
    return this._namedChildren.length;
  }
  child(index: number): MinimalTsNode | null {
    return this._namedChildren[index] ?? null;
  }
  childForFieldName(name: string): MinimalTsNode | null {
    return this._fields.get(name) ?? null;
  }
  get namedChildCount(): number {
    return this._namedChildren.length;
  }
  namedChild(index: number): MinimalTsNode | null {
    return this._namedChildren[index] ?? null;
  }
}

export function mockTree(root: MockNodeSpec): MinimalTsTree {
  return { rootNode: new MockNode(root) };
}
