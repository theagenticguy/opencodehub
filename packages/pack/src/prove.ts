/**
 * `prove` — turn a {@link PackManifest} into a checkable receipt.
 *
 * `buildProvenanceStatement(manifest, bomDir)` emits an in-toto ITE-6
 * statement carrying an SLSA Provenance v1 predicate whose **subject digest
 * is exactly `manifest.packHash`** — the same sha256 that `manifest.ts`
 * computes over the canonical-JSON BOM (we do NOT recompute or alter it;
 * `manifest.ts` is the trusted input). The predicate records the four
 * reproducibility inputs `(commit, tokenizerId, budgetTokens, pins)` as
 * `externalParameters` and every BOM file as a `resolvedDependency`
 * (`{uri, digest:{sha256}}`).
 *
 * The statement is emitted as plain JSON; in-toto permits any JSON object,
 * but we lay the bytes down via the shared RFC 8785 `canonicalJson`
 * (`@opencodehub/core-types`) so the `.intoto.jsonl` line is byte-stable
 * across runs — a third party who re-derives the same manifest can diff the
 * statement byte-for-byte, and the cosign bundle wraps an identical payload.
 *
 * Signing is keyless-OIDC only (ADR / release.yml identity), never an
 * embedded key. `signStatement` shells out to `cosign sign-blob --bundle`
 * exactly as the release workflow does. When `cosign` is absent from PATH
 * (air-gapped dev box, CI lane without the installer) the function returns
 * `{ signed: false, reason }` and the caller still has the unsigned
 * `.intoto.jsonl` statement on disk — we NEVER fabricate a signature.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@opencodehub/core-types";
import type { PackManifest } from "./types.js";

/**
 * The Sigstore OIDC issuer the release workflow's keyless flow authenticates
 * against (`actions/attest-build-provenance` + `cosign sign-blob`). Reused
 * verbatim for the local/air-gapped `cosign verify-blob-attestation` path so
 * there is exactly one signing identity across CI and dev.
 */
export const SIGSTORE_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** in-toto Statement media type (ITE-6 v1). */
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

/** SLSA Provenance predicate type carried by the statement. */
export const SLSA_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

/**
 * The builder identity recorded in the SLSA `runDetails.builder.id`. This is
 * the deterministic `@opencodehub/pack` BOM path, NOT the repomix wrapper —
 * `--prove` only ever attests a real 9-item BOM.
 */
export const PACK_BUILDER_ID = "https://github.com/opencodehub/opencodehub/pack";

/** in-toto resource descriptor: a named subject/dependency bound to a digest. */
export interface ResourceDescriptor {
  readonly name: string;
  readonly uri?: string;
  readonly digest: { readonly sha256: string };
}

/** The four reproducibility inputs that, together with the commit's tree, fix the packHash. */
export interface ProvenanceExternalParameters {
  readonly commit: string;
  readonly tokenizerId: string;
  readonly budgetTokens: number;
  readonly pins: PackManifest["pins"];
}

/** SLSA Provenance v1 predicate (the subset @opencodehub/pack populates). */
export interface SlsaProvenancePredicate {
  readonly buildDefinition: {
    readonly buildType: string;
    readonly externalParameters: ProvenanceExternalParameters;
    readonly internalParameters: {
      readonly determinismClass: PackManifest["determinismClass"];
      readonly schemaVersion: PackManifest["schemaVersion"];
    };
    readonly resolvedDependencies: readonly ResourceDescriptor[];
  };
  readonly runDetails: {
    readonly builder: { readonly id: string };
    readonly metadata: { readonly invocationId: string };
  };
}

/** An in-toto/SLSA-v1 statement: subject digest == packHash, predicate == provenance. */
export interface InTotoStatement {
  readonly _type: string;
  readonly subject: readonly ResourceDescriptor[];
  readonly predicateType: string;
  readonly predicate: SlsaProvenancePredicate;
}

export interface ProveResult {
  /** The in-toto/SLSA-v1 statement (subject digest == manifest.packHash). */
  readonly statement: InTotoStatement;
  /** Absolute path of the unsigned `*.intoto.jsonl` statement on disk. */
  readonly statementPath: string;
  /** Absolute path the cosign bundle WILL live at (next to the statement). */
  readonly bundlePath: string;
  /** Outcome of the signing attempt. `signed: false` carries a human reason. */
  readonly signing:
    | { readonly signed: true; readonly bundlePath: string }
    | { readonly signed: false; readonly reason: string; readonly command: string };
}

/**
 * Build the in-toto/SLSA-v1 statement for a pack.
 *
 * `subject` is a single descriptor `{ name: "pack:<packHash>", digest:{ sha256: packHash } }`
 * — the digest is `manifest.packHash` verbatim. `resolvedDependencies` maps
 * `manifest.files[]` to `{ name, uri, digest:{sha256: fileHash} }`, lexically
 * sorted by name for byte-stable output (U7) independent of the BOM array
 * order. `externalParameters` carries exactly the four reproducibility inputs.
 *
 * `bomDir` names the directory the BOM bodies live in; it is recorded as the
 * `uri` prefix on each resolved dependency (a `file:` URI relative to the
 * pack root) so a verifier can locate each input — the digest, not the URI,
 * is what binds identity.
 */
export function buildProvenanceStatement(manifest: PackManifest, bomDir: string): InTotoStatement {
  const resolvedDependencies: ResourceDescriptor[] = manifest.files
    .map(
      (f): ResourceDescriptor => ({
        name: f.path,
        uri: toFileUri(bomDir, f.path),
        digest: { sha256: f.fileHash },
      }),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      {
        name: `pack:${manifest.packHash}`,
        digest: { sha256: manifest.packHash },
      },
    ],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: PACK_BUILDER_ID,
        externalParameters: {
          commit: manifest.commit,
          tokenizerId: manifest.tokenizerId,
          budgetTokens: manifest.budgetTokens,
          pins: manifest.pins,
        },
        internalParameters: {
          determinismClass: manifest.determinismClass,
          schemaVersion: manifest.schemaVersion,
        },
        resolvedDependencies,
      },
      runDetails: {
        builder: { id: PACK_BUILDER_ID },
        // The invocation is keyed by the pack's own hash — there is no
        // wall-clock or random id, so the statement bytes stay deterministic
        // for a given (commit, tokenizer, budget, pins).
        metadata: { invocationId: `pack:${manifest.packHash}` },
      },
    },
  };
}

/**
 * Serialize the statement to a single canonical-JSON line (`.intoto.jsonl`
 * is newline-delimited JSON; one statement = one line + trailing LF). Byte
 * order is RFC 8785 canonical via the shared `canonicalJson`, so the on-disk
 * statement is byte-identical across runs of the same pack.
 */
export function serializeStatement(statement: InTotoStatement): string {
  return `${canonicalJson(statement)}\n`;
}

/** Test seam: inject a fake spawner so unit tests never shell out to cosign. */
export interface SignStatementInternalOpts {
  /** Resolves to `true` when `cosign` is on PATH, `false` otherwise. */
  readonly _cosignPresent?: () => Promise<boolean>;
}

/**
 * `codehub pack --prove <repo>` glue: build the statement for `manifest`,
 * write the unsigned `*.intoto.jsonl` next to the pack, then attempt a
 * keyless cosign signature into `*.intoto.jsonl.sigstore` (the bundle).
 *
 * The statement is ALWAYS written. Signing is best-effort and additive: if
 * `cosign` is absent, `signing.signed` is `false` with the exact command an
 * operator must run in an environment that has cosign — we never fabricate a
 * signature. This mirrors release.yml's keyless `sign-blob --bundle` flow;
 * the OIDC identity/issuer is `SIGSTORE_OIDC_ISSUER`.
 */
export async function prove(
  manifest: PackManifest,
  bomDir: string,
  internal: SignStatementInternalOpts = {},
): Promise<ProveResult> {
  const statement = buildProvenanceStatement(manifest, bomDir);
  const statementPath = path.join(bomDir, `pack-${manifest.packHash}.intoto.jsonl`);
  const bundlePath = `${statementPath}.sigstore`;

  await writeFile(statementPath, serializeStatement(statement));

  const cosignPresent = internal._cosignPresent ?? defaultCosignPresent;
  const present = await cosignPresent();

  // The exact command the operator runs to sign in a cosign-enabled env. The
  // keyless flow needs an OIDC token (CI provides it via id-token: write;
  // locally cosign opens a browser). `--yes` skips the confirmation prompt,
  // matching release.yml.
  const signCommand = `cosign sign-blob --yes --bundle ${quote(bundlePath)} ${quote(statementPath)}`;

  if (!present) {
    return {
      statement,
      statementPath,
      bundlePath,
      signing: {
        signed: false,
        reason:
          "cosign not found on PATH — wrote unsigned statement only. Sign in a cosign-enabled " +
          "environment (CI release.yml lane, or `cosign` installed locally with an OIDC identity).",
        command: signCommand,
      },
    };
  }

  try {
    await runCosignSignBlob(statementPath, bundlePath);
    return { statement, statementPath, bundlePath, signing: { signed: true, bundlePath } };
  } catch (err) {
    return {
      statement,
      statementPath,
      bundlePath,
      signing: {
        signed: false,
        reason: `cosign sign-blob failed: ${err instanceof Error ? err.message : String(err)}`,
        command: signCommand,
      },
    };
  }
}

/**
 * The exact offline verification command a third party runs. The bundle's
 * SET carries the Rekor inclusion proof, so this verifies WITHOUT network
 * given a vendored Sigstore trusted root (`--trusted-root`). `<identity>` is
 * the workflow's certificate-identity (its OIDC subject); the issuer is fixed.
 */
export function offlineVerifyCommand(bundlePath: string, statementPath: string): string {
  return [
    "cosign verify-blob-attestation",
    `--bundle ${quote(bundlePath)}`,
    `--certificate-oidc-issuer ${SIGSTORE_OIDC_ISSUER}`,
    "--certificate-identity-regexp '^https://github.com/opencodehub/opencodehub/'",
    "--trusted-root vendor/sigstore/trusted_root.json",
    "--offline",
    quote(statementPath),
  ].join(" ");
}

/** `file://` URI for a BOM body relative to the pack dir. Identity is the digest, not this. */
function toFileUri(bomDir: string, relPath: string): string {
  // bomDir may be absolute; we record the basename + relPath so the URI is
  // stable regardless of the absolute staging location (which is a temp dir).
  return `file:${path.posix.join("pack", path.basename(bomDir), relPath)}`;
}

/** Quote a path for inclusion in a copy-pasteable shell command. */
function quote(s: string): string {
  return /[^\w./@:-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

/** Default PATH probe for cosign. Never throws; resolves false on any error. */
async function defaultCosignPresent(): Promise<boolean> {
  return new Promise((resolveP) => {
    let settled = false;
    const child = spawn("cosign", ["version"], { stdio: "ignore" });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolveP(false);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolveP(code === 0);
    });
  });
}

/** Spawn the keyless `cosign sign-blob --bundle`. Rejects on non-zero exit. */
async function runCosignSignBlob(statementPath: string, bundlePath: string): Promise<void> {
  await new Promise<void>((res, rej) => {
    const child = spawn("cosign", ["sign-blob", "--yes", "--bundle", bundlePath, statementPath], {
      env: { ...process.env, COSIGN_EXPERIMENTAL: "true" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", (err) => rej(err));
    child.on("close", (code) => {
      if (code === 0) res();
      else rej(new Error(`cosign sign-blob exited ${code}`));
    });
  });
}
