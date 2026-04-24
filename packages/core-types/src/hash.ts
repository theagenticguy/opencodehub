import { createHash, type Hash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
  const h = createHash("sha256");
  if (typeof input === "string") {
    h.update(input, "utf8");
  } else {
    h.update(input);
  }
  return h.digest("hex");
}

export function hash6(input: string): string {
  return sha256Hex(input).slice(0, 6);
}

/**
 * Canonical-JSON serializer. Sorted object keys, arrays preserve insertion
 * order, `undefined` object fields are dropped, `null` is preserved, and
 * non-finite numbers (NaN, ±Infinity) render as `null`. Always returns a
 * single string — convenient for small / medium payloads.
 *
 * For payloads large enough to risk V8's max-string-length limit (≈ 512 MB
 * for one-byte strings, ≈ 256 MB for two-byte strings) prefer
 * {@link writeCanonicalJson}, which streams chunks through a user-provided
 * callback and never materializes one monolithic string.
 */
export function canonicalJson(value: unknown): string {
  // Collect chunks into an array. Using `Array.join("")` at the end lets V8
  // build the string in one shot without the quadratic-reallocation penalty
  // that `+=` on a growing buffer incurs. For graph-scale inputs callers
  // should go through `writeCanonicalJson` instead; this wrapper is retained
  // so the existing small-object callers (SARIF baseline keys, StoreMeta
  // stats blob) keep working byte-identically.
  const chunks: string[] = [];
  writeCanonicalJson(value, (s) => chunks.push(s));
  return chunks.join("");
}

/**
 * Streaming variant of {@link canonicalJson}. Emits canonical-JSON bytes in
 * order by calling `emit(chunk)` zero-or-more times. The concatenation of
 * every emitted chunk is byte-identical to `canonicalJson(value)`.
 *
 * The streaming form is the only one safe for large aggregates: a 1.3 M-edge
 * graph's canonical JSON is ~400 MB, which blows V8's single-string cap
 * (`RangeError: Invalid string length`). By contrast, each individual
 * chunk here is tiny — a primitive, a key/value separator, or a serialized
 * leaf — so the caller (typically a `crypto.Hash.update` wrapper) can digest
 * arbitrarily large inputs without retaining them.
 */
export function writeCanonicalJson(value: unknown, emit: (chunk: string) => void): void {
  writeValue(value, emit);
}

/**
 * Feed the canonical-JSON form of `value` into a Node crypto Hash instance.
 * Convenience wrapper over {@link writeCanonicalJson}; provided so callers
 * don't have to reinvent the `emit → hasher.update` glue.
 */
export function hashCanonicalJson(value: unknown, hasher: Hash): void {
  writeCanonicalJson(value, (chunk) => {
    hasher.update(chunk, "utf8");
  });
}

function writeValue(v: unknown, emit: (chunk: string) => void): void {
  if (v === null || v === undefined) {
    emit("null");
    return;
  }
  const t = typeof v;
  if (t === "boolean") {
    emit(v ? "true" : "false");
    return;
  }
  if (t === "number") {
    const n = v as number;
    emit(Number.isFinite(n) ? JSON.stringify(n) : "null");
    return;
  }
  if (t === "bigint") {
    emit((v as bigint).toString());
    return;
  }
  if (t === "string") {
    emit(JSON.stringify(v));
    return;
  }
  if (Array.isArray(v)) {
    emit("[");
    for (let i = 0; i < v.length; i += 1) {
      if (i > 0) emit(",");
      const item = v[i];
      if (item === undefined) emit("null");
      else writeValue(item, emit);
    }
    emit("]");
    return;
  }
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    emit("{");
    let first = true;
    for (const k of keys) {
      const val = obj[k];
      if (val === undefined) continue;
      if (!first) emit(",");
      first = false;
      emit(JSON.stringify(k));
      emit(":");
      writeValue(val, emit);
    }
    emit("}");
    return;
  }
  emit("null");
}
