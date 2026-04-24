/**
 * API contract detection.
 *
 * Four categories:
 *   - openapi   — `openapi.{yaml,json}` / `swagger.{yaml,json}` at a known
 *                 location, OR any YAML/JSON file whose header contains
 *                 `openapi: 3.` or `swagger: 2.`.
 *   - graphql   — any `.graphql` / `.gql` file OR `schema.graphql`.
 *   - grpc      — any `.proto` file.
 *   - asyncapi  — `asyncapi.yaml`.
 *
 * Content sniffing is capped the same way as `iac.ts`.
 *
 * Determinism: sorted list of category names.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScannedFile } from "../phases/scan.js";

/** Maximum YAML/JSON files we sniff for an OpenAPI / Swagger marker. */
const CONTENT_SNIFF_CAP = 40;
const SNIFF_BYTES = 1000;

const OPENAPI_FILENAME_RE = /^(?:[^/]*\/)*(openapi|swagger)\.(ya?ml|json)$/i;

export async function detectApiContracts(
  repoRoot: string,
  files: readonly ScannedFile[],
): Promise<readonly string[]> {
  const hits = new Set<string>();

  for (const f of files) {
    const rel = f.relPath;
    const lowered = rel.toLowerCase();

    if (lowered.endsWith(".graphql") || lowered.endsWith(".gql")) {
      hits.add("graphql");
    }
    if (lowered.endsWith(".proto")) {
      hits.add("grpc");
    }
    if (rel === "asyncapi.yaml" || rel === "asyncapi.yml") {
      hits.add("asyncapi");
    }
    if (OPENAPI_FILENAME_RE.test(rel)) {
      hits.add("openapi");
    }
  }

  // Content sniff for openapi / swagger markers if we did not already detect
  // one via filename. This picks up hand-named schema files (e.g.
  // `docs/api-spec.yaml`).
  if (!hits.has("openapi")) {
    const candidates = files
      .filter((f) => {
        const l = f.relPath.toLowerCase();
        return l.endsWith(".yaml") || l.endsWith(".yml") || l.endsWith(".json");
      })
      .slice(0, CONTENT_SNIFF_CAP);

    for (const f of candidates) {
      let header = "";
      try {
        const fh = await fs.open(path.join(repoRoot, f.relPath), "r");
        try {
          const buf = new Uint8Array(SNIFF_BYTES);
          const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
          header = Buffer.from(buf.buffer, buf.byteOffset, bytesRead).toString("utf8");
        } finally {
          await fh.close();
        }
      } catch {
        continue;
      }
      if (/"?openapi"?\s*:\s*"?3\./.test(header) || /^\s*openapi\s*:\s*['"]?3\./m.test(header)) {
        hits.add("openapi");
        break;
      }
      if (/"?swagger"?\s*:\s*"?2\./.test(header) || /^\s*swagger\s*:\s*['"]?2\./m.test(header)) {
        hits.add("openapi");
        break;
      }
    }
  }

  return [...hits].sort();
}
