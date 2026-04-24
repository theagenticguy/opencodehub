/**
 * Regex-based gRPC contract extractor.
 *
 * Producers:
 *   - `.proto` files: detect `package foo.v1;` + `service Bar { rpc Baz (...) ... }`.
 *     Each rpc becomes a `grpc_service` contract with signature
 *     `foo.v1.Bar/Baz`. A service with no rpcs still emits one contract
 *     with signature `foo.v1.Bar` (so consumers that hold only the
 *     service handle still resolve).
 *
 * Consumers:
 *   - TS / JS: `new BarClient(...)` or `createClient(BarService)` — we
 *     capture identifiers ending in `Client` / `Service` and treat each
 *     import target as a potential consumer signature.
 *   - Python: `BarStub(channel)` or `BarServicer` references. Captured by
 *     the same simple identifier pattern.
 *
 * Because .proto is the ground truth, we expect most inter-repo pairings
 * to resolve via the `manifest` pass in `contracts.ts` (package.json peer
 * or pyproject shared-lib pointing at the producer repo).
 */

import type { Contract } from "./types.js";

const PROTO_PACKAGE_RE = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/gm;
const PROTO_SERVICE_RE = /^\s*service\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)^\s*\}/gm;
const PROTO_RPC_RE = /\brpc\s+([A-Za-z_]\w*)\s*\(/g;

/** `new XxxClient(...)` / `createClient(Xxx)` / import …XxxClient… */
const JS_CLIENT_RE = /\bnew\s+([A-Za-z_]\w*(?:Client|ServiceClient))\s*\(/g;
const JS_CREATE_CLIENT_RE = /\bcreateClient\s*\(\s*([A-Za-z_]\w*)/g;

/** Python: `XxxStub(channel)` or reference to `XxxServicer`. */
const PY_STUB_RE = /\b([A-Za-z_]\w*Stub)\s*\(/g;
const PY_SERVICER_RE = /\bclass\s+([A-Za-z_]\w*Servicer)\b/g;

function lineNumberOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

export interface GrpcProtoExtractOptions {
  readonly repo: string;
  readonly file: string;
  readonly source: string;
}

/** Stripped class/identifier base name (`FooClient` → `Foo`). */
function stripClientSuffix(name: string): string {
  return name
    .replace(/Client$/, "")
    .replace(/ServiceClient$/, "")
    .replace(/Service$/, "")
    .replace(/Stub$/, "")
    .replace(/Servicer$/, "");
}

export function extractGrpcProtoContracts(opts: GrpcProtoExtractOptions): readonly Contract[] {
  const { repo, file, source } = opts;
  const out: Contract[] = [];

  const packages = Array.from(source.matchAll(PROTO_PACKAGE_RE), (m) => m[1] ?? "");
  const pkg = packages[0] ?? "";

  PROTO_SERVICE_RE.lastIndex = 0;
  for (const match of source.matchAll(PROTO_SERVICE_RE)) {
    const name = match[1] ?? "";
    const body = match[2] ?? "";
    const offset = match.index ?? 0;
    const line = lineNumberOf(source, offset);
    const fqsn = pkg ? `${pkg}.${name}` : name;

    const rpcs = Array.from(body.matchAll(PROTO_RPC_RE), (m) => m[1] ?? "").filter(
      (n) => n.length > 0,
    );
    if (rpcs.length === 0) {
      out.push({ type: "grpc_service", signature: fqsn, repo, file, line });
      continue;
    }
    for (const rpc of rpcs) {
      out.push({
        type: "grpc_service",
        signature: `${fqsn}/${rpc}`,
        repo,
        file,
        line,
      });
    }
  }

  return out;
}

export interface GrpcClientExtractOptions {
  readonly repo: string;
  readonly file: string;
  readonly source: string;
  readonly language: "js" | "ts" | "py";
}

export function extractGrpcClientContracts(opts: GrpcClientExtractOptions): readonly Contract[] {
  const { repo, file, source, language } = opts;
  const out: Contract[] = [];

  if (language === "js" || language === "ts") {
    for (const match of source.matchAll(JS_CLIENT_RE)) {
      const id = match[1] ?? "";
      const base = stripClientSuffix(id);
      if (base.length === 0) continue;
      const line = lineNumberOf(source, match.index ?? 0);
      out.push({ type: "grpc_client", signature: base, repo, file, line });
    }
    for (const match of source.matchAll(JS_CREATE_CLIENT_RE)) {
      const id = match[1] ?? "";
      const base = stripClientSuffix(id);
      if (base.length === 0) continue;
      const line = lineNumberOf(source, match.index ?? 0);
      out.push({ type: "grpc_client", signature: base, repo, file, line });
    }
  }

  if (language === "py") {
    for (const match of source.matchAll(PY_STUB_RE)) {
      const id = match[1] ?? "";
      const base = stripClientSuffix(id);
      if (base.length === 0) continue;
      const line = lineNumberOf(source, match.index ?? 0);
      out.push({ type: "grpc_client", signature: base, repo, file, line });
    }
    for (const match of source.matchAll(PY_SERVICER_RE)) {
      // Servicers are server-side implementations; surface them as
      // additional producer contracts so signature-match with a producer
      // .proto file (or a consumer's Stub reference) resolves.
      const id = match[1] ?? "";
      const base = stripClientSuffix(id);
      if (base.length === 0) continue;
      const line = lineNumberOf(source, match.index ?? 0);
      out.push({ type: "grpc_service", signature: base, repo, file, line });
    }
  }

  return out;
}
