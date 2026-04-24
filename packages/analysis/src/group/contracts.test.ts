import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRegistry, resolveCrossLinks } from "./contracts.js";
import type { Contract } from "./types.js";

test("resolveCrossLinks: HTTP producer + consumer with same signature cross-link", () => {
  const producer: Contract = {
    type: "http_route",
    signature: "GET /users/{id}",
    repo: "api",
    file: "server.ts",
    line: 10,
  };
  const consumer: Contract = {
    type: "http_call",
    signature: "GET /users/{id}",
    repo: "web",
    file: "client.ts",
    line: 22,
  };
  const links = resolveCrossLinks([producer, consumer], []);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.matchReason, "signature");
  assert.equal(links[0]?.producer.repo, "api");
  assert.equal(links[0]?.consumer.repo, "web");
});

test("resolveCrossLinks: same repo pairs do NOT cross-link", () => {
  const a: Contract = {
    type: "http_route",
    signature: "GET /x",
    repo: "api",
    file: "a.ts",
    line: 1,
  };
  const b: Contract = {
    type: "http_call",
    signature: "GET /x",
    repo: "api",
    file: "b.ts",
    line: 1,
  };
  assert.equal(resolveCrossLinks([a, b], []).length, 0);
});

test("resolveCrossLinks: gRPC token signature-match pairs FQN producer with short-name consumer", () => {
  const producer: Contract = {
    type: "grpc_service",
    signature: "hello.v1.Greeter/SayHello",
    repo: "proto-repo",
    file: "hello.proto",
    line: 5,
  };
  const consumer: Contract = {
    type: "grpc_client",
    signature: "Greeter",
    repo: "web-repo",
    file: "client.ts",
    line: 8,
  };
  const links = resolveCrossLinks([producer, consumer], []);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.matchReason, "signature");
});

test("resolveCrossLinks: topic manifest link pairs producer+consumer when signatures differ", () => {
  // Topic family does NOT allow token-substring signature match, so the
  // manifest pass is the one that surfaces the cross-link.
  const producer: Contract = {
    type: "topic_producer",
    signature: "orders-v1",
    repo: "svc-a",
    file: "publish.ts",
    line: 1,
  };
  const consumer: Contract = {
    type: "topic_consumer",
    signature: "orders-v2",
    repo: "svc-b",
    file: "consume.ts",
    line: 1,
  };
  const links = resolveCrossLinks(
    [producer, consumer],
    [
      {
        producerRepo: "svc-a",
        consumerRepo: "svc-b",
        contract: "orders",
        type: "topic_producer",
      },
    ],
  );
  assert.equal(links.length, 1);
  assert.equal(links[0]?.matchReason, "manifest");
});

test("buildRegistry sorts contracts and stamps timestamp", () => {
  const contracts: Contract[] = [
    {
      type: "http_route",
      signature: "GET /b",
      repo: "api",
      file: "b.ts",
      line: 1,
    },
    {
      type: "http_route",
      signature: "GET /a",
      repo: "api",
      file: "a.ts",
      line: 1,
    },
  ];
  const reg = buildRegistry({
    repos: ["web", "api"],
    contracts,
    now: () => "2026-04-23T00:00:00.000Z",
  });
  assert.deepEqual(reg.repos, ["api", "web"]);
  assert.equal(reg.computedAt, "2026-04-23T00:00:00.000Z");
  assert.equal(reg.contracts[0]?.signature, "GET /a");
});
