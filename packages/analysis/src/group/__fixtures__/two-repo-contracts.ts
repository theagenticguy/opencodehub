/**
 * Synthetic 2-repo cross-repo-contracts fixture (AC-M6-5 quickcheck).
 *
 * Models a producer/consumer pair across two repos in the same group:
 *   - `api-svc`   — HTTP route producer + gRPC service producer
 *   - `web-app`   — HTTP call consumer + gRPC client consumer
 *
 * The pair is deterministic by construction: alpha-sorted symbol names,
 * fixed line numbers, no timestamps, no random IDs. The output of
 * `computeCrossRepoLinks(TWO_REPO_FIXTURE)` exercises the populated-case
 * Mermaid + matrix path that the `codehub-contract-map` skill renders
 * downstream.
 *
 * Used by `cross-repo-links-quickcheck.test.ts` to assert:
 *   1. ≥ 1 link is returned per signature
 *   2. Output shape matches `CrossRepoLink`
 *   3. Consumer/producer orientation is correct (depends_on points from
 *      consumer to producer; consumer_of points from producer to consumer)
 *   4. Two runs on the same input are byte-identical (determinism contract)
 *
 * All `repo_uri` values follow the Sourcegraph host/path scheme codified
 * by AC-M6-1 (`packages/core-types/src/nodes.ts:524-552`) — see ADR 0012
 * for the rationale.
 */

import type { ComputeCrossRepoLinksOpts } from "../cross-repo-links.js";
import type { CrossLink } from "../types.js";

/** Producer repo (HTTP routes + gRPC services). */
export const API_SVC_REPO = "api-svc";
/** Consumer repo (HTTP calls + gRPC clients). */
export const WEB_APP_REPO = "web-app";

/** Canonical Sourcegraph-style URIs for the fixture. */
export const API_SVC_URI = "github.com/org/api-svc";
export const WEB_APP_URI = "github.com/org/web-app";

/**
 * Two cross-links forming a populated producer/consumer pair across
 * the api-svc / web-app boundary. Signatures are alpha-sorted so two
 * runs on the same fixture produce byte-identical output.
 */
export const TWO_REPO_CROSS_LINKS: readonly CrossLink[] = [
  // HTTP: web-app → api-svc on GET /users/{id}
  {
    producer: {
      type: "http_route",
      signature: "GET /users/{id}",
      repo: API_SVC_REPO,
      file: "api-svc/src/routes/users.ts",
      line: 42,
    },
    consumer: {
      type: "http_call",
      signature: "GET /users/{id}",
      repo: WEB_APP_REPO,
      file: "web-app/src/clients/users-client.ts",
      line: 17,
    },
    matchReason: "signature",
  },
  // gRPC: web-app → api-svc on api.UserService/GetUser
  {
    producer: {
      type: "grpc_service",
      signature: "api.UserService/GetUser",
      repo: API_SVC_REPO,
      file: "api-svc/src/grpc/user-service.ts",
      line: 88,
    },
    consumer: {
      type: "grpc_client",
      signature: "api.UserService/GetUser",
      repo: WEB_APP_REPO,
      file: "web-app/src/clients/grpc/user-rpc.ts",
      line: 25,
    },
    matchReason: "signature",
  },
];

/** Stable repo-name → repo_uri map covering both fixture repos. */
export const TWO_REPO_URI_MAP: ReadonlyMap<string, string> = new Map([
  [API_SVC_REPO, API_SVC_URI],
  [WEB_APP_REPO, WEB_APP_URI],
]);

/** Drop-in input for `computeCrossRepoLinks`. */
export const TWO_REPO_FIXTURE: ComputeCrossRepoLinksOpts = {
  groupName: "platform",
  crossLinks: TWO_REPO_CROSS_LINKS,
  repoUriByName: TWO_REPO_URI_MAP,
};
