import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runIngestion } from "../orchestrator.js";
import { UNRESOLVED_FETCH_TARGET_PREFIX } from "./fetches.js";

describe("fetchesPhase", () => {
  it("emits a FETCHES edge to a local Route when the URL matches", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-fetches-local-"));
    try {
      // Producer: Express-style route handler for GET /api/users.
      await fs.writeFile(
        path.join(repo, "server.ts"),
        [
          "const app = require('express')();",
          "app.get('/api/users', function handleUsers() { return []; });",
          "",
        ].join("\n"),
      );
      // Consumer: a fetch call hitting that URL.
      await fs.writeFile(
        path.join(repo, "client.ts"),
        [
          "export async function loadUsers() {",
          "  const r = await fetch('/api/users');",
          "  return r.json();",
          "}",
          "",
        ].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const fetches = [...result.graph.edges()].filter((e) => e.type === "FETCHES");
      assert.ok(fetches.length >= 1, "expected at least one FETCHES edge");
      // At least one FETCHES edge should target a Route node (resolved case).
      const resolved = fetches.find(
        (e) => !(e.to as string).startsWith(UNRESOLVED_FETCH_TARGET_PREFIX),
      );
      assert.ok(resolved, "expected a resolved FETCHES edge to a local Route");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("emits an unresolved FETCHES edge when no local Route matches", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-fetches-unresolved-"));
    try {
      await fs.writeFile(
        path.join(repo, "client.ts"),
        [
          "export async function loadProducts() {",
          "  const r = await fetch('/api/products');",
          "  return r.json();",
          "}",
          "",
        ].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const fetches = [...result.graph.edges()].filter((e) => e.type === "FETCHES");
      assert.ok(fetches.length >= 1);
      const unresolved = fetches.find((e) =>
        (e.to as string).startsWith(UNRESOLVED_FETCH_TARGET_PREFIX),
      );
      assert.ok(unresolved, "expected an unresolved FETCHES edge");
      assert.match(unresolved.reason ?? "", /\/api\/products/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("detects requests.get and axios calls with the right methods", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-fetches-multilang-"));
    try {
      await fs.writeFile(
        path.join(repo, "client.py"),
        [
          "import requests",
          "def load_users():",
          "    return requests.get('/api/users')",
          "def create_user(data):",
          "    return requests.post('/api/users', json=data)",
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(repo, "client.ts"),
        [
          "import axios from 'axios';",
          "export async function fetchThing() {",
          "  return axios.get('/api/things');",
          "}",
          "",
        ].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const fetches = [...result.graph.edges()].filter((e) => e.type === "FETCHES");
      const reasons = fetches.map((e) => e.reason ?? "").join("\n");
      assert.match(reasons, /requests:GET:\/api\/users/);
      assert.match(reasons, /requests:POST:\/api\/users/);
      assert.match(reasons, /axios:GET:\/api\/things/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("is deterministic — same input produces same edge order", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-fetches-deterministic-"));
    try {
      await fs.writeFile(
        path.join(repo, "client.ts"),
        [
          "export async function a() { return fetch('/a'); }",
          "export async function b() { return fetch('/b'); }",
          "export async function c() { return fetch('/c'); }",
          "",
        ].join("\n"),
      );
      const r1 = await runIngestion(repo, { skipGit: true });
      const r2 = await runIngestion(repo, { skipGit: true });
      assert.equal(r1.graphHash, r2.graphHash, "graphHash must be stable across runs");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
