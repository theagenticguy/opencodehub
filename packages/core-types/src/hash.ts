import { createHash } from "node:crypto";

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

export function canonicalJson(value: unknown): string {
  return writeValue(value);
}

function writeValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    const n = v as number;
    if (!Number.isFinite(n)) return "null";
    return JSON.stringify(n);
  }
  if (t === "bigint") return (v as bigint).toString();
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    const items = v.map((item) => (item === undefined ? "null" : writeValue(item)));
    return `[${items.join(",")}]`;
  }
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const val = obj[k];
      if (val === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${writeValue(val)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}
