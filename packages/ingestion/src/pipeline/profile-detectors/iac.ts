/**
 * IaC (Infrastructure-as-Code) detection.
 *
 * Seven categories in priority order:
 *   - terraform          — any `.tf` or `.tf.json`
 *   - docker-compose     — `docker-compose.yml` / `compose.yaml`
 *   - docker             — `Dockerfile` or `Dockerfile.*`
 *   - kubernetes         — YAML with `apiVersion:` + `kind:` at top
 *   - cloudformation     — YAML/JSON with `AWSTemplateFormatVersion:`
 *   - cdk                — `cdk.json` at repo root
 *   - pulumi             — `Pulumi.yaml`
 *
 * Kubernetes/CloudFormation are content-sniffed (we read the first 1000
 * bytes) because their file extensions (.yaml/.yml/.json) are ambiguous and
 * collide with every other YAML/JSON artifact in the repo. To bound IO cost
 * we cap the number of YAML/JSON files we peek at per category.
 *
 * Determinism: the output is a sorted list of IaC category names.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScannedFile } from "../phases/scan.js";

/** Maximum YAML/JSON files we sniff for k8s/CloudFormation headers. */
const CONTENT_SNIFF_CAP = 40;
/** Bytes we read from each sniffed file. */
const SNIFF_BYTES = 1000;

const DOCKERFILE_RE = /^(?:[^/]*\/)*Dockerfile(?:\..+)?$/;
const COMPOSE_RE = /^(docker-compose\.ya?ml|compose\.ya?ml)$/;

export async function detectIaCTypes(
  repoRoot: string,
  files: readonly ScannedFile[],
): Promise<readonly string[]> {
  const hits = new Set<string>();

  for (const f of files) {
    const rel = f.relPath;
    const lowered = rel.toLowerCase();

    // terraform: any .tf or .tf.json
    if (lowered.endsWith(".tf") || lowered.endsWith(".tf.json")) {
      hits.add("terraform");
    }

    // docker-compose (root-only, composes nested in examples are ignored)
    if (!rel.includes("/") && COMPOSE_RE.test(rel)) {
      hits.add("docker-compose");
    }

    // docker
    if (DOCKERFILE_RE.test(rel)) {
      hits.add("docker");
    }

    // cdk
    if (rel === "cdk.json") {
      hits.add("cdk");
    }

    // pulumi
    if (rel === "Pulumi.yaml") {
      hits.add("pulumi");
    }
  }

  // kubernetes + cloudformation need content sniffing. Collect YAML/JSON
  // candidates, sort for determinism, cap total reads.
  const sniffCandidates = files
    .filter((f) => {
      const l = f.relPath.toLowerCase();
      return l.endsWith(".yaml") || l.endsWith(".yml") || l.endsWith(".json");
    })
    .filter(
      // Skip files already covered by exact-match rules so we do not
      // waste reads on `docker-compose.yml` or `Pulumi.yaml` / `cdk.json`.
      (f) => f.relPath !== "Pulumi.yaml" && f.relPath !== "cdk.json" && !COMPOSE_RE.test(f.relPath),
    )
    .slice(0, CONTENT_SNIFF_CAP);

  for (const f of sniffCandidates) {
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

    if (header.includes("AWSTemplateFormatVersion")) {
      hits.add("cloudformation");
      continue;
    }

    // Kubernetes manifests carry `apiVersion:` and `kind:` near the top.
    // Both must be present (CloudFormation templates also have `Resources:`
    // but not `apiVersion:`).
    const hasApiVersion = /^\s*apiVersion\s*:/m.test(header);
    const hasKind = /^\s*kind\s*:/m.test(header);
    if (hasApiVersion && hasKind) {
      hits.add("kubernetes");
    }
  }

  return [...hits].sort();
}
