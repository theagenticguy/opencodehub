import assert from "node:assert/strict";
import { test } from "node:test";
import { extractHttpContracts, httpSignature, normalizeHttpPath } from "./http-patterns.js";

test("normalizeHttpPath collapses :id / {id} / trailing slash", () => {
  assert.equal(normalizeHttpPath("/users/:id/"), "/users/{id}");
  assert.equal(normalizeHttpPath("/users/{id}?limit=5"), "/users/{id}");
  assert.equal(normalizeHttpPath(""), "/");
  assert.equal(normalizeHttpPath("api/v1/thing"), "/api/v1/thing");
});

test("httpSignature uppercases the method", () => {
  assert.equal(httpSignature("post", "/x"), "POST /x");
});

test("extractHttpContracts: Express route producer", () => {
  const source = [
    "import express from 'express';",
    "const app = express();",
    "app.get('/users/:id', handler);",
  ].join("\n");
  const out = extractHttpContracts({
    repo: "api",
    file: "src/server.ts",
    source,
    language: "ts",
  });
  const routes = out.filter((c) => c.type === "http_route");
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.signature, "GET /users/{id}");
  assert.equal(routes[0]?.line, 3);
});

test("extractHttpContracts: fetch consumer default GET + explicit POST", () => {
  const source = [
    "async function one() { await fetch('/users/1'); }",
    "async function two() { await fetch('/users', { method: 'POST', body: JSON.stringify({}) }); }",
  ].join("\n");
  const out = extractHttpContracts({
    repo: "web",
    file: "src/client.ts",
    source,
    language: "ts",
  });
  const calls = out.filter((c) => c.type === "http_call");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.signature, "GET /users/1");
  assert.equal(calls[1]?.signature, "POST /users");
});

test("extractHttpContracts: Flask @app.route with methods list", () => {
  const source = ["@app.route('/items', methods=['POST', 'GET'])", "def handle(): pass"].join("\n");
  const out = extractHttpContracts({
    repo: "api",
    file: "app.py",
    source,
    language: "py",
  });
  const routes = out.filter((c) => c.type === "http_route");
  assert.equal(routes.length, 2);
  const sigs = routes.map((r) => r.signature).sort();
  assert.deepEqual(sigs, ["GET /items", "POST /items"]);
});

test("extractHttpContracts: FastAPI @router.get and requests.get consumer", () => {
  const source = [
    "@router.get('/health')",
    "def health(): return {}",
    "",
    "def call_out():",
    "    requests.get('/health')",
  ].join("\n");
  const out = extractHttpContracts({
    repo: "svc",
    file: "api.py",
    source,
    language: "py",
  });
  const routes = out.filter((c) => c.type === "http_route");
  const calls = out.filter((c) => c.type === "http_call");
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.signature, "GET /health");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.signature, "GET /health");
});
