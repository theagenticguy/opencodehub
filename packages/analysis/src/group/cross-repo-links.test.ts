import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCrossRepoLinks } from "./cross-repo-links.js";
import type { CrossLink } from "./types.js";

function makeLink(producerRepo: string, consumerRepo: string, signature: string): CrossLink {
  return {
    producer: {
      type: "http_route",
      signature,
      repo: producerRepo,
      file: `${producerRepo}/server.ts`,
      line: 10,
    },
    consumer: {
      type: "http_call",
      signature,
      repo: consumerRepo,
      file: `${consumerRepo}/client.ts`,
      line: 22,
    },
    matchReason: "signature",
  };
}

function repoMap(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

test("computeCrossRepoLinks: emits paired depends_on + consumer_of per cross-link", () => {
  const links = computeCrossRepoLinks({
    groupName: "stack",
    crossLinks: [makeLink("api", "web", "GET /users/{id}")],
    repoUriByName: repoMap({
      api: "github.com/org/api",
      web: "github.com/org/web",
    }),
  });
  assert.equal(links.length, 2);
  // Alpha-sorted by source_repo_uri first — api < web.
  assert.equal(links[0]?.source_repo_uri, "github.com/org/api");
  assert.equal(links[0]?.target_repo_uri, "github.com/org/web");
  assert.equal(links[0]?.relation, "consumer_of");
  assert.equal(links[1]?.source_repo_uri, "github.com/org/web");
  assert.equal(links[1]?.target_repo_uri, "github.com/org/api");
  assert.equal(links[1]?.relation, "depends_on");
});

test("computeCrossRepoLinks: determinism — two runs on the same fixture produce byte-identical output", () => {
  const fixture: CrossLink[] = [
    makeLink("orders", "frontend", "GET /orders"),
    makeLink("billing", "frontend", "POST /charges"),
    makeLink("orders", "billing", "GET /orders/{id}/invoice"),
  ];
  const repos = repoMap({
    orders: "github.com/org/orders",
    billing: "github.com/org/billing",
    frontend: "github.com/org/frontend",
  });
  const first = computeCrossRepoLinks({
    groupName: "stack",
    crossLinks: fixture,
    repoUriByName: repos,
  });
  const second = computeCrossRepoLinks({
    groupName: "stack",
    crossLinks: fixture,
    repoUriByName: repos,
  });
  assert.deepEqual(first, second);
  // Stringify to catch any subtle ordering drift.
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("computeCrossRepoLinks: alpha-sort on the 5-tuple", () => {
  // Deliberately unsorted input.
  const links = computeCrossRepoLinks({
    groupName: "stack",
    crossLinks: [
      makeLink("zzz", "aaa", "GET /z"),
      makeLink("aaa", "bbb", "GET /a"),
      makeLink("mmm", "nnn", "GET /m"),
    ],
    repoUriByName: repoMap({
      aaa: "github.com/org/aaa",
      bbb: "github.com/org/bbb",
      mmm: "github.com/org/mmm",
      nnn: "github.com/org/nnn",
      zzz: "github.com/org/zzz",
    }),
  });
  // 3 cross-links × 2 relations = 6 entries.
  assert.equal(links.length, 6);
  const sources = links.map((l) => l.source_repo_uri);
  const sorted = [...sources].sort();
  assert.deepEqual(sources, sorted);
  // Within the same source, target should be sorted next.
  for (let i = 1; i < links.length; i++) {
    const a = links[i - 1];
    const b = links[i];
    if (!a || !b) continue;
    if (a.source_repo_uri === b.source_repo_uri) {
      assert.ok(
        a.target_repo_uri <= b.target_repo_uri,
        "target_repo_uri must be alpha-sorted within same source",
      );
    }
  }
});

test("computeCrossRepoLinks: empty group → empty array, no error", () => {
  const links = computeCrossRepoLinks({
    groupName: "empty",
    crossLinks: [],
    repoUriByName: new Map(),
  });
  assert.deepEqual(links, []);
});

test("computeCrossRepoLinks: repo without a registered URI is silently skipped", () => {
  const links = computeCrossRepoLinks({
    groupName: "stack",
    crossLinks: [
      makeLink("api", "web", "GET /a"),
      makeLink("ghost", "web", "GET /b"), // ghost not in map
    ],
    repoUriByName: repoMap({
      api: "github.com/org/api",
      web: "github.com/org/web",
    }),
  });
  // Only the (api ↔ web) pair survives.
  assert.equal(links.length, 2);
  for (const l of links) {
    assert.notEqual(l.source_repo_uri, "github.com/org/ghost");
    assert.notEqual(l.target_repo_uri, "github.com/org/ghost");
  }
});

test("computeCrossRepoLinks: duplicate contracts collapse to one link per relation", () => {
  // Two different signatures, same repo pair → dedup to 2 links (one per relation).
  const links = computeCrossRepoLinks({
    groupName: "stack",
    crossLinks: [
      makeLink("api", "web", "GET /users/{id}"),
      makeLink("api", "web", "POST /users"),
      makeLink("api", "web", "DELETE /users/{id}"),
    ],
    repoUriByName: repoMap({
      api: "github.com/org/api",
      web: "github.com/org/web",
    }),
  });
  assert.equal(links.length, 2);
  const relations = links.map((l) => l.relation).sort();
  assert.deepEqual(relations, ["consumer_of", "depends_on"]);
});

test("computeCrossRepoLinks: same-repo links are dropped (defense-in-depth; resolveCrossLinks already filters)", () => {
  const selfLink: CrossLink = {
    producer: {
      type: "http_route",
      signature: "GET /a",
      repo: "api",
      file: "a.ts",
      line: 1,
    },
    consumer: {
      type: "http_call",
      signature: "GET /a",
      repo: "api",
      file: "b.ts",
      line: 1,
    },
    matchReason: "signature",
  };
  const links = computeCrossRepoLinks({
    groupName: "stack",
    crossLinks: [selfLink],
    repoUriByName: repoMap({ api: "github.com/org/api" }),
  });
  assert.deepEqual(links, []);
});

test("computeCrossRepoLinks: evidence is populated from producer.signature", () => {
  const links = computeCrossRepoLinks({
    groupName: "stack",
    crossLinks: [makeLink("api", "web", "GET /health")],
    repoUriByName: repoMap({
      api: "github.com/org/api",
      web: "github.com/org/web",
    }),
  });
  for (const l of links) {
    assert.equal(l.evidence, "GET /health");
  }
});

test("computeCrossRepoLinks: unknown docPathScheme throws", () => {
  assert.throws(
    () =>
      computeCrossRepoLinks({
        groupName: "stack",
        crossLinks: [],
        repoUriByName: new Map(),
        // @ts-expect-error — intentionally invalid for this test
        docPathScheme: "weird",
      }),
    /Unknown docPathScheme/,
  );
});
