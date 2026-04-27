/**
 * Decode a SCIP protobuf index into the minimal subset we care about:
 * Documents, their Occurrences, and SymbolInformation. We do NOT decode
 * Diagnostics, SignatureDocumentation, or Relationship details beyond
 * symbol identity — the graph extractor does not use them.
 *
 * Field numbers mirror `proto/scip.proto`. The reader is streaming-style
 * on a per-message basis; callers pass `index.scip` buffer in and we walk
 * Documents/Occurrences in O(bytes).
 */

import { ProtoReader, WireType } from "./proto-reader.js";

export interface ScipRange {
  readonly startLine: number;
  readonly startChar: number;
  readonly endLine: number;
  readonly endChar: number;
}

export interface ScipOccurrence {
  readonly symbol: string;
  readonly symbolRoles: number;
  readonly range: ScipRange;
  readonly enclosingRange: ScipRange | null;
}

export interface ScipRelationship {
  readonly symbol: string;
  readonly isReference: boolean;
  readonly isImplementation: boolean;
  readonly isTypeDefinition: boolean;
  readonly isDefinition: boolean;
}

export interface ScipSymbolInformation {
  readonly symbol: string;
  readonly displayName: string;
  readonly kind: number;
  readonly documentation: readonly string[];
  readonly relationships: readonly ScipRelationship[];
}

export interface ScipDocument {
  readonly relativePath: string;
  readonly language: string;
  readonly occurrences: readonly ScipOccurrence[];
  readonly symbols: readonly ScipSymbolInformation[];
}

export interface ScipToolInfo {
  readonly name: string;
  readonly version: string;
}

export interface ScipIndex {
  readonly tool: ScipToolInfo;
  readonly projectRoot: string;
  readonly documents: readonly ScipDocument[];
  readonly externalSymbols: readonly ScipSymbolInformation[];
}

/** Symbol-role bitmask, copied from scip.proto. */
export const SCIP_ROLE_DEFINITION = 0x1;
export const SCIP_ROLE_IMPORT = 0x2;
export const SCIP_ROLE_WRITE_ACCESS = 0x4;
export const SCIP_ROLE_READ_ACCESS = 0x8;

export function parseScipIndex(buf: Uint8Array): ScipIndex {
  let tool: ScipToolInfo = { name: "", version: "" };
  let projectRoot = "";
  const documents: ScipDocument[] = [];
  const externalSymbols: ScipSymbolInformation[] = [];

  const reader = new ProtoReader(buf);
  reader.forEachField((field, wire, self) => {
    switch (field) {
      case 1: // metadata
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        ({ tool, projectRoot } = parseMetadata(self.readSubMessage()));
        return true;
      case 2: // documents
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        documents.push(parseDocument(self.readSubMessage()));
        return true;
      case 3: // external_symbols
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        externalSymbols.push(parseSymbolInformation(self.readSubMessage()));
        return true;
      default:
        return false;
    }
  });

  return { tool, projectRoot, documents, externalSymbols };
}

function parseMetadata(buf: Uint8Array): { tool: ScipToolInfo; projectRoot: string } {
  let tool: ScipToolInfo = { name: "", version: "" };
  let projectRoot = "";
  const reader = new ProtoReader(buf);
  reader.forEachField((field, wire, self) => {
    if (field === 2 && wire === WireType.LENGTH_DELIMITED) {
      tool = parseToolInfo(self.readSubMessage());
      return true;
    }
    if (field === 3 && wire === WireType.LENGTH_DELIMITED) {
      projectRoot = self.readString();
      return true;
    }
    return false;
  });
  return { tool, projectRoot };
}

function parseToolInfo(buf: Uint8Array): ScipToolInfo {
  let name = "";
  let version = "";
  const reader = new ProtoReader(buf);
  reader.forEachField((field, wire, self) => {
    if (field === 1 && wire === WireType.LENGTH_DELIMITED) {
      name = self.readString();
      return true;
    }
    if (field === 2 && wire === WireType.LENGTH_DELIMITED) {
      version = self.readString();
      return true;
    }
    return false;
  });
  return { name, version };
}

function parseDocument(buf: Uint8Array): ScipDocument {
  let relativePath = "";
  let language = "";
  const occurrences: ScipOccurrence[] = [];
  const symbols: ScipSymbolInformation[] = [];
  const reader = new ProtoReader(buf);
  reader.forEachField((field, wire, self) => {
    switch (field) {
      case 1: // relative_path
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        relativePath = self.readString();
        return true;
      case 2: // occurrences
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        occurrences.push(parseOccurrence(self.readSubMessage()));
        return true;
      case 3: // symbols (SymbolInformation)
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        symbols.push(parseSymbolInformation(self.readSubMessage()));
        return true;
      case 4: // language
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        language = self.readString();
        return true;
      default:
        return false;
    }
  });
  return { relativePath, language, occurrences, symbols };
}

function parseOccurrence(buf: Uint8Array): ScipOccurrence {
  const rangeInts: number[] = [];
  let symbol = "";
  let symbolRoles = 0;
  const enclosingInts: number[] = [];
  const reader = new ProtoReader(buf);
  reader.forEachField((field, wire, self) => {
    switch (field) {
      case 1: // range (packed/unpacked int32)
        self.readRepeatedInt32(wire, rangeInts);
        return true;
      case 2: // symbol
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        symbol = self.readString();
        return true;
      case 3: // symbol_roles
        if (wire !== WireType.VARINT) return false;
        symbolRoles = self.readVarint();
        return true;
      case 7: // enclosing_range
        self.readRepeatedInt32(wire, enclosingInts);
        return true;
      default:
        return false;
    }
  });
  return {
    symbol,
    symbolRoles,
    range: normalizeRange(rangeInts),
    enclosingRange: enclosingInts.length > 0 ? normalizeRange(enclosingInts) : null,
  };
}

function parseSymbolInformation(buf: Uint8Array): ScipSymbolInformation {
  let symbol = "";
  let displayName = "";
  let kind = 0;
  const documentation: string[] = [];
  const relationships: ScipRelationship[] = [];
  const reader = new ProtoReader(buf);
  reader.forEachField((field, wire, self) => {
    switch (field) {
      case 1: // symbol
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        symbol = self.readString();
        return true;
      case 3: // documentation
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        documentation.push(self.readString());
        return true;
      case 4: // relationships
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        relationships.push(parseRelationship(self.readSubMessage()));
        return true;
      case 5: // kind
        if (wire !== WireType.VARINT) return false;
        kind = self.readVarint();
        return true;
      case 6: // display_name
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        displayName = self.readString();
        return true;
      default:
        return false;
    }
  });
  return {
    symbol,
    displayName: displayName || deriveDisplayName(symbol),
    kind,
    documentation,
    relationships,
  };
}

function parseRelationship(buf: Uint8Array): ScipRelationship {
  let symbol = "";
  let isReference = false;
  let isImplementation = false;
  let isTypeDefinition = false;
  let isDefinition = false;
  const reader = new ProtoReader(buf);
  reader.forEachField((field, wire, self) => {
    switch (field) {
      case 1:
        if (wire !== WireType.LENGTH_DELIMITED) return false;
        symbol = self.readString();
        return true;
      case 2:
        if (wire !== WireType.VARINT) return false;
        isReference = self.readVarint() !== 0;
        return true;
      case 3:
        if (wire !== WireType.VARINT) return false;
        isImplementation = self.readVarint() !== 0;
        return true;
      case 4:
        if (wire !== WireType.VARINT) return false;
        isTypeDefinition = self.readVarint() !== 0;
        return true;
      case 5:
        if (wire !== WireType.VARINT) return false;
        isDefinition = self.readVarint() !== 0;
        return true;
      default:
        return false;
    }
  });
  return { symbol, isReference, isImplementation, isTypeDefinition, isDefinition };
}

/**
 * SCIP ranges are `[startLine, startChar, endLine, endChar]` with an
 * optional 3-length form when start/end share a line:
 * `[startLine, startChar, endChar]`.
 */
function normalizeRange(ints: readonly number[]): ScipRange {
  if (ints.length === 3) {
    return {
      startLine: ints[0] ?? 0,
      startChar: ints[1] ?? 0,
      endLine: ints[0] ?? 0,
      endChar: ints[2] ?? 0,
    };
  }
  return {
    startLine: ints[0] ?? 0,
    startChar: ints[1] ?? 0,
    endLine: ints[2] ?? 0,
    endChar: ints[3] ?? 0,
  };
}

function deriveDisplayName(symbol: string): string {
  if (symbol.startsWith("local ")) return symbol;
  const parts = symbol.split(" ");
  if (parts.length < 4) return symbol;
  const descriptor = parts.slice(3).join(" ");
  const segments = descriptor.replace(/#/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? symbol;
}
