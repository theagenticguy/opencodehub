/**
 * BOM body item: the context read-receipt (item 9/9).
 *
 * A CycloneDX 1.6 JSON document whose components are the source files the
 * pack indexed — one `file` component per `File` node in the graph. It
 * answers a question a `packHash` alone cannot: *which source bytes did the
 * agent's context come from?* Each component carries the file's SHA-256
 * content hash, line count, language, and — when the AST chunker produced
 * range data — the merged byte ranges that were chunked out of it.
 *
 * Why File nodes and not chunks: the chunker's per-file byte ranges are only
 * present when `generatePack` is handed raw file bytes, which today happens
 * only in tests. File nodes are populated by `analyze` on every real pack, so
 * anchoring on them makes the receipt complete in production. Byte ranges
 * layer on as an optional property when present.
 *
 * Determinism contract:
 *   - Components are sorted by `name` (the repo-relative path) ASC; paths are
 *     unique within a graph so no tiebreak is needed.
 *   - Byte ranges per file are merged into sorted, non-overlapping spans.
 *   - The document is serialized through the shared RFC 8785 `canonicalJson`
 *     helper, so two runs over the same graph produce byte-identical output
 *     and therefore the same `contextBomHash`.
 *   - No wall-clock, UUID, or environment-derived field is ever emitted
 *     (no `serialNumber`, no `metadata.timestamp`) — those would break
 *     byte-identity. The document is a pure function of the file set.
 */

import { canonicalJson, sha256Hex } from "@opencodehub/core-types";

/** A source file the pack indexed, projected from a `File` graph node. */
export interface ContextFile {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** SHA-256 hex of the file's content, when the graph recorded one. */
  readonly contentHash?: string;
  /** Line count, when recorded. */
  readonly lineCount?: number;
  /** Source language id, when recorded. */
  readonly language?: string;
}

/** A half-open `[start, end)` byte span read from a file. */
export interface ByteSpan {
  readonly start: number;
  readonly end: number;
}

export interface ContextBomOpts {
  /** Indexed files. Order is irrelevant — the builder sorts by path. */
  readonly files: readonly ContextFile[];
  /**
   * Optional per-path byte spans (e.g. from the AST chunker). Absent or
   * empty in the production-default case where no raw bytes were chunked;
   * when present, merged spans are attached as a `byteRanges` property.
   */
  readonly byteRangesByPath?: ReadonlyMap<string, readonly ByteSpan[]>;
}

/** A CycloneDX 1.6 `property` — name + stringified value. */
interface CdxProperty {
  readonly name: string;
  readonly value: string;
}

/** A CycloneDX 1.6 `hash` entry. */
interface CdxHash {
  readonly alg: "SHA-256";
  readonly content: string;
}

/** A CycloneDX 1.6 `file` component. */
interface CdxComponent {
  readonly type: "file";
  readonly "bom-ref": string;
  readonly name: string;
  readonly hashes?: readonly CdxHash[];
  readonly properties?: readonly CdxProperty[];
}

/** The CycloneDX 1.6 document. */
export interface ContextBomDocument {
  readonly $schema: string;
  readonly bomFormat: "CycloneDX";
  readonly specVersion: "1.6";
  readonly version: 1;
  readonly components: readonly CdxComponent[];
}

/** Result of {@link buildContextBom}: the document, its canonical bytes, and its hash. */
export interface ContextBomResult {
  readonly document: ContextBomDocument;
  /** RFC 8785 canonical JSON of {@link ContextBomDocument}. LF-free, key-sorted. */
  readonly canonical: string;
  /** SHA-256 hex of {@link ContextBomResult.canonical}'s UTF-8 bytes. */
  readonly contextBomHash: string;
}

const CDX_SCHEMA_URL = "http://cyclonedx.org/schema/bom-1.6.schema.json";
const PROP_BYTE_RANGES = "opencodehub:byteRanges";
const PROP_LINE_COUNT = "opencodehub:lineCount";
const PROP_LANGUAGE = "opencodehub:language";

/**
 * Build the context read-receipt as a CycloneDX 1.6 document plus its
 * canonical serialization and hash.
 *
 * An empty file set produces a valid document with `components: []` — a real
 * (if empty) receipt rather than a missing one.
 */
export function buildContextBom(opts: ContextBomOpts): ContextBomResult {
  const sorted = [...opts.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const components: CdxComponent[] = [];
  for (const file of sorted) {
    const properties = buildProperties(file, opts.byteRangesByPath?.get(file.path));
    const component: CdxComponent = {
      type: "file",
      "bom-ref": file.path,
      name: file.path,
      ...(file.contentHash !== undefined
        ? { hashes: [{ alg: "SHA-256", content: file.contentHash } as const] }
        : {}),
      ...(properties.length > 0 ? { properties } : {}),
    };
    components.push(component);
  }

  const document: ContextBomDocument = {
    $schema: CDX_SCHEMA_URL,
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components,
  };

  const canonical = canonicalJson(document);
  const contextBomHash = sha256Hex(canonical);
  return { document, canonical, contextBomHash };
}

/**
 * Assemble a component's properties in a fixed key order. CycloneDX requires
 * every `value` to be a string, so numbers and span arrays are stringified.
 * Properties are omitted (not emitted empty) when their source is absent.
 */
function buildProperties(file: ContextFile, spans: readonly ByteSpan[] | undefined): CdxProperty[] {
  const props: CdxProperty[] = [];
  if (file.lineCount !== undefined) {
    props.push({ name: PROP_LINE_COUNT, value: String(file.lineCount) });
  }
  if (file.language !== undefined) {
    props.push({ name: PROP_LANGUAGE, value: file.language });
  }
  const merged = spans !== undefined ? mergeSpans(spans) : [];
  if (merged.length > 0) {
    props.push({
      name: PROP_BYTE_RANGES,
      value: JSON.stringify(merged.map((s) => [s.start, s.end])),
    });
  }
  return props;
}

/**
 * Merge byte spans into sorted, non-overlapping `[start, end)` ranges so the
 * receipt records the union of what was read, deterministically. Adjacent or
 * overlapping spans coalesce; zero-length and inverted spans are dropped.
 */
export function mergeSpans(spans: readonly ByteSpan[]): ByteSpan[] {
  const ordered = spans
    .filter((s) => s.end > s.start)
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  const merged: ByteSpan[] = [];
  // `last` tracks the most recently pushed span so we never index into
  // `merged` (which `noUncheckedIndexedAccess` types as possibly undefined).
  let last: ByteSpan | undefined;
  for (const cur of ordered) {
    if (last !== undefined && cur.start <= last.end) {
      if (cur.end > last.end) {
        last = { start: last.start, end: cur.end };
        merged[merged.length - 1] = last;
      }
    } else {
      last = { start: cur.start, end: cur.end };
      merged.push(last);
    }
  }
  return merged;
}
