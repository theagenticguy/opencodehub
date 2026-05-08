/**
 * Quickcheck — populated-case 2-repo fixture (AC-M6-5).
 *
 * The existing `cross-repo-links.test.ts` covers the empty + alpha-sort
 * + dedup + skip + error paths. This file pins the populated-case
 * Mermaid + matrix output that the `codehub-contract-map` skill renders
 * from `group_cross_repo_links` — i.e. it asserts the populated path
 * stays green when refactors land downstream.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_SVC_REPO,
  API_SVC_URI,
  TWO_REPO_FIXTURE,
  WEB_APP_REPO,
  WEB_APP_URI,
} from "./__fixtures__/two-repo-contracts.js";
import { computeCrossRepoLinks } from "./cross-repo-links.js";

test("quickcheck: populated 2-repo fixture emits ≥ 1 link with the canonical 5-tuple shape", () => {
  const links = computeCrossRepoLinks(TWO_REPO_FIXTURE);

  // Two cross-links × two relations (depends_on + consumer_of) = 4 links.
  // Both signatures share the same (producer, consumer) repo pair so they
  // collapse to two unique links per the per-landing dedup contract.
  assert.equal(links.length, 2);

  for (const link of links) {
    // Shape match — every field present and a non-empty string.
    assert.equal(typeof link.source_repo_uri, "string");
    assert.equal(typeof link.target_repo_uri, "string");
    assert.equal(typeof link.source_doc_path, "string");
    assert.equal(typeof link.target_doc_path, "string");
    assert.equal(typeof link.relation, "string");
    assert.ok(link.source_repo_uri.length > 0);
    assert.ok(link.target_repo_uri.length > 0);
    assert.ok(link.source_doc_path.length > 0);
    assert.ok(link.target_doc_path.length > 0);
    assert.ok(["see_also", "depends_on", "consumer_of"].includes(link.relation));
  }
});

test("quickcheck: consumer/producer orientation is correct", () => {
  const links = computeCrossRepoLinks(TWO_REPO_FIXTURE);

  // depends_on: consumer (web-app) → producer (api-svc).
  const dependsOn = links.find((l) => l.relation === "depends_on");
  assert.ok(dependsOn !== undefined, "depends_on link must exist");
  assert.equal(dependsOn.source_repo_uri, WEB_APP_URI);
  assert.equal(dependsOn.target_repo_uri, API_SVC_URI);
  assert.equal(dependsOn.source_doc_path, `${WEB_APP_REPO}/architecture.md`);
  assert.equal(dependsOn.target_doc_path, `${API_SVC_REPO}/architecture.md`);

  // consumer_of: producer (api-svc) → consumer (web-app).
  const consumerOf = links.find((l) => l.relation === "consumer_of");
  assert.ok(consumerOf !== undefined, "consumer_of link must exist");
  assert.equal(consumerOf.source_repo_uri, API_SVC_URI);
  assert.equal(consumerOf.target_repo_uri, WEB_APP_URI);
  assert.equal(consumerOf.source_doc_path, `${API_SVC_REPO}/architecture.md`);
  assert.equal(consumerOf.target_doc_path, `${WEB_APP_REPO}/architecture.md`);
});

test("quickcheck: deterministic ordering — two runs deep-equal", () => {
  const first = computeCrossRepoLinks(TWO_REPO_FIXTURE);
  const second = computeCrossRepoLinks(TWO_REPO_FIXTURE);
  assert.deepEqual(first, second);
  // Stringify to also catch any subtle ordering drift the deepEqual
  // walk could miss on deeply nested optional fields.
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("quickcheck: evidence is sourced from producer.signature on every link", () => {
  const links = computeCrossRepoLinks(TWO_REPO_FIXTURE);
  // The fixture has two signatures; the per-landing dedup keeps whichever
  // arrived first. Either signature is a valid evidence string — we only
  // assert that the field is populated and matches one of the expected
  // signatures.
  const allowed = new Set(["GET /users/{id}", "api.UserService/GetUser"]);
  for (const link of links) {
    assert.ok(link.evidence !== undefined, "evidence must be populated");
    assert.ok(
      allowed.has(link.evidence ?? ""),
      `evidence ${String(link.evidence)} must come from a fixture signature`,
    );
  }
});
