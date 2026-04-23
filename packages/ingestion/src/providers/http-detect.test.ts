import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  detectHttpCallsGo,
  detectHttpCallsJava,
  detectHttpCallsPython,
  detectHttpCallsTsJs,
  normalizeUrlTemplate,
} from "./http-detect.js";

describe("http-detect", () => {
  it("normalizes :id to {id}", () => {
    assert.equal(normalizeUrlTemplate("/users/:id"), "/users/{id}");
    assert.equal(normalizeUrlTemplate("/a/{id}?x=1"), "/a/{id}");
    assert.equal(normalizeUrlTemplate("/a/:x/:y"), "/a/{x}/{y}");
  });

  it("detects fetch default GET and explicit method", () => {
    const src = [
      "await fetch('/api/users');",
      "await fetch('/api/users', { method: 'POST' });",
    ].join("\n");
    const calls = detectHttpCallsTsJs(src);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[1]?.method, "POST");
    assert.equal(calls[0]?.clientLibrary, "fetch");
  });

  it("detects axios.verb and axios config object", () => {
    const src = [
      "axios.get('/api/things');",
      "axios.post('/api/things', { a: 1 });",
      "axios({ method: 'delete', url: '/api/things/1' });",
    ].join("\n");
    const calls = detectHttpCallsTsJs(src);
    const reasons = calls.map((c) => `${c.method} ${c.urlTemplate} ${c.clientLibrary}`);
    assert.ok(reasons.includes("GET /api/things axios"));
    assert.ok(reasons.includes("POST /api/things axios"));
    assert.ok(reasons.includes("DELETE /api/things/1 axios"));
  });

  it("detects requests and httpx in Python", () => {
    const src = ["requests.get('/a')", "requests.post('/b')", "httpx.get('/c')"].join("\n");
    const calls = detectHttpCallsPython(src);
    const set = new Set(calls.map((c) => `${c.method} ${c.urlTemplate} ${c.clientLibrary}`));
    assert.ok(set.has("GET /a requests"));
    assert.ok(set.has("POST /b requests"));
    assert.ok(set.has("GET /c httpx"));
  });

  it("detects http.Get / http.Post in Go", () => {
    const src = 'http.Get("/a"); http.Post("/b", "application/json", nil)';
    const calls = detectHttpCallsGo(src);
    const set = new Set(calls.map((c) => `${c.method} ${c.urlTemplate}`));
    assert.ok(set.has("GET /a"));
    assert.ok(set.has("POST /b"));
  });

  it("detects restTemplate + webClient in Java", () => {
    const src = [
      'restTemplate.getForObject("/api/x", X.class);',
      'webClient.get().uri("/api/y");',
    ].join("\n");
    const calls = detectHttpCallsJava(src);
    const set = new Set(calls.map((c) => `${c.method} ${c.urlTemplate} ${c.clientLibrary}`));
    assert.ok(set.has("GET /api/x restTemplate"));
    assert.ok(set.has("GET /api/y webClient"));
  });
});
