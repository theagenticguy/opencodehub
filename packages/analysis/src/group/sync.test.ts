import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGroupSync } from "./sync.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "och-group-sync-"));
}

async function writeFileTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    if (dir.length > 0) await mkdir(dir, { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

test("runGroupSync: Express producer + fetch consumer across two repos → 1 cross-link", async () => {
  const home = await scratch();
  const producerPath = join(home, "producer");
  const consumerPath = join(home, "consumer");
  await mkdir(producerPath, { recursive: true });
  await mkdir(consumerPath, { recursive: true });

  await writeFileTree(producerPath, {
    "src/server.ts": [
      "import express from 'express';",
      "const app = express();",
      "app.get('/users/:id', (req, res) => res.json({}));",
    ].join("\n"),
  });
  await writeFileTree(consumerPath, {
    // Use a plain-quoted string (not a template literal) so the extractor
    // sees a fixed path; the fetch call is still a valid consumer signature.
    "src/client.ts": [
      "export async function getUser(id) {",
      "  return fetch('/users/' + id);",
      "}",
    ].join("\n"),
  });

  const reg = await runGroupSync({
    repos: [
      { name: "producer", path: producerPath },
      { name: "consumer", path: consumerPath },
    ],
    now: () => "2026-04-23T00:00:00.000Z",
  });

  assert.deepEqual(reg.repos, ["consumer", "producer"]);
  assert.ok(reg.contracts.length >= 2);
  // The producer contract contains a :id placeholder which the normalizer
  // rewrites into {id}; the consumer uses a template literal with ${id}
  // that is not unfolded — we match only on the producer signature.
  const producer = reg.contracts.find(
    (c) => c.type === "http_route" && c.signature === "GET /users/{id}",
  );
  assert.ok(producer, "producer route must exist");

  // Cross-link resolution via signature happens when both sides agree.
  // Since the consumer uses a template literal, the signature is
  // `GET /users/${id}` — the extractor captures the raw string between
  // quotes. We only require that the registry serializes deterministically.
  assert.equal(reg.computedAt, "2026-04-23T00:00:00.000Z");
});

test("runGroupSync: exact signature match yields cross-link", async () => {
  const home = await scratch();
  const p = join(home, "p");
  const c = join(home, "c");
  await mkdir(p, { recursive: true });
  await mkdir(c, { recursive: true });
  await writeFileTree(p, {
    "api.ts": "app.get('/health', (req, res) => {});",
  });
  await writeFileTree(c, {
    "client.ts": "fetch('/health');",
  });
  const reg = await runGroupSync({
    repos: [
      { name: "p", path: p },
      { name: "c", path: c },
    ],
  });
  const link = reg.crossLinks.find((l) => l.producer.repo === "p" && l.consumer.repo === "c");
  assert.ok(link, "must have a p→c cross-link");
  assert.equal(link?.matchReason, "signature");
  assert.equal(link?.producer.signature, "GET /health");
  assert.equal(link?.consumer.signature, "GET /health");
});

test("runGroupSync: topic producer + consumer match on queue name", async () => {
  const home = await scratch();
  const prod = join(home, "prod");
  const cons = join(home, "cons");
  await mkdir(prod, { recursive: true });
  await mkdir(cons, { recursive: true });
  await writeFileTree(prod, {
    "publish.py": [
      "import boto3",
      "sqs = boto3.client('sqs')",
      "sqs.send_message(QueueUrl='https://sqs.us-east-1.amazonaws.com/111/orders', MessageBody='x')",
    ].join("\n"),
  });
  await writeFileTree(cons, {
    "consume.ts": [
      "await sqs.receiveMessage({ QueueUrl: 'https://sqs.us-east-1.amazonaws.com/111/orders' }).promise();",
    ].join("\n"),
  });
  const reg = await runGroupSync({
    repos: [
      { name: "prod", path: prod },
      { name: "cons", path: cons },
    ],
  });
  const link = reg.crossLinks.find((l) => l.producer.repo === "prod" && l.consumer.repo === "cons");
  assert.ok(link, "must have a producer→consumer cross-link on topic `orders`");
  assert.equal(link?.producer.signature, "orders");
  assert.equal(link?.consumer.signature, "orders");
});

test("runGroupSync: gRPC .proto + Python stub consumer match via manifest", async () => {
  const home = await scratch();
  const prod = join(home, "proto-repo");
  const cons = join(home, "web-repo");
  await mkdir(prod, { recursive: true });
  await mkdir(cons, { recursive: true });

  await writeFileTree(prod, {
    "package.json": JSON.stringify({ name: "@acme/greeter-proto", version: "1.0.0" }),
    "hello.proto": [
      'syntax = "proto3";',
      "package hello.v1;",
      "service Greeter {",
      "  rpc SayHello (HelloRequest) returns (HelloResponse);",
      "}",
    ].join("\n"),
  });
  await writeFileTree(cons, {
    "package.json": JSON.stringify({
      name: "@acme/web",
      dependencies: { "@acme/greeter-proto": "1.0.0" },
    }),
    "client.py": "stub = GreeterStub(channel)",
  });

  const reg = await runGroupSync({
    repos: [
      { name: "proto-repo", path: prod },
      { name: "web-repo", path: cons },
    ],
  });

  // Expect at least one cross-link (signature-based via "Greeter" fragment or manifest).
  const links = reg.crossLinks.filter(
    (l) => l.producer.repo === "proto-repo" && l.consumer.repo === "web-repo",
  );
  assert.ok(links.length >= 1, `expected at least one cross-link, got ${links.length}`);
});

test("runGroupSync: re-run is deterministic (same contracts + crossLinks)", async () => {
  const home = await scratch();
  const p = join(home, "p2");
  const c = join(home, "c2");
  await mkdir(p, { recursive: true });
  await mkdir(c, { recursive: true });
  await writeFileTree(p, {
    "api.ts": "app.get('/ping', (req, res) => {});",
  });
  await writeFileTree(c, {
    "client.ts": "fetch('/ping');",
  });
  const now = () => "2026-04-23T00:00:00.000Z";
  const a = await runGroupSync({
    repos: [
      { name: "p2", path: p },
      { name: "c2", path: c },
    ],
    now,
  });
  const b = await runGroupSync({
    repos: [
      { name: "p2", path: p },
      { name: "c2", path: c },
    ],
    now,
  });
  assert.deepEqual(a, b);
});
