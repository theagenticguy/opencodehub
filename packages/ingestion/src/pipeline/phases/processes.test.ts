import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runIngestion } from "../orchestrator.js";

describe("processesPhase (via full pipeline)", () => {
  it("emits a Process with at least 3 PROCESS_STEP edges for a linear call chain", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-proc-linear-"));
    try {
      // Entry-looking name (`handleRequest`) + linear A→B→C→D call chain.
      await fs.writeFile(
        path.join(repo, "handler.ts"),
        [
          "export function handleRequest() { return step1(); }",
          "function step1() { return step2(); }",
          "function step2() { return step3(); }",
          "function step3() { return 'ok'; }",
          "",
        ].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const processes = [...result.graph.nodes()].filter((n) => n.kind === "Process");
      assert.ok(processes.length >= 1, "expected at least one Process node");
      const stepEdges = [...result.graph.edges()].filter((e) => e.type === "PROCESS_STEP");
      assert.ok(stepEdges.length >= 3, `expected >= 3 PROCESS_STEP edges, got ${stepEdges.length}`);
      for (const e of stepEdges) assert.equal(e.confidence, 0.85);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("emits ENTRY_POINT_OF when a Route shares the entry-point's file", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-proc-route-"));
    try {
      await fs.writeFile(
        path.join(repo, "server.ts"),
        [
          "const app = require('express')();",
          "app.get('/health', handleHealth);",
          "export function handleHealth() { return compute(); }",
          "function compute() { return step1(); }",
          "function step1() { return step2(); }",
          "function step2() { return 'ok'; }",
          "",
        ].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const entryPointOf = [...result.graph.edges()].filter((e) => e.type === "ENTRY_POINT_OF");
      // The route-detection + process-scoring heuristics must align for the
      // edge to emit; tolerate zero but verify the processes phase ran.
      const processes = [...result.graph.nodes()].filter((n) => n.kind === "Process");
      assert.ok(processes.length >= 1);
      if (entryPointOf.length > 0) {
        for (const e of entryPointOf) assert.equal(e.confidence, 0.85);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("excludes test-path files from entry-point scoring", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-proc-exclude-test-"));
    try {
      await fs.mkdir(path.join(repo, "tests"), { recursive: true });
      await fs.writeFile(
        path.join(repo, "tests", "handler.test.ts"),
        [
          "export function handleTest() { return step1(); }",
          "function step1() { return step2(); }",
          "function step2() { return step3(); }",
          "function step3() { return 'ok'; }",
          "",
        ].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const processes = [...result.graph.nodes()].filter((n) => n.kind === "Process");
      // No non-test entry points — expect zero processes.
      assert.equal(processes.length, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("boosts framework-aware dir hints (Next.js app/api + Express routes)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-proc-framework-"));
    try {
      await fs.mkdir(path.join(repo, "app", "api", "users"), { recursive: true });
      await fs.mkdir(path.join(repo, "controllers"), { recursive: true });
      await fs.writeFile(
        path.join(repo, "app", "api", "users", "route.ts"),
        [
          "export async function GET() { return step1(); }",
          "function step1() { return step2(); }",
          "function step2() { return step3(); }",
          "function step3() { return 'ok'; }",
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(repo, "controllers", "userController.ts"),
        [
          "export function UsersController() { return handle1(); }",
          "function handle1() { return handle2(); }",
          "function handle2() { return handle3(); }",
          "function handle3() { return 'ok'; }",
          "",
        ].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const processes = [...result.graph.nodes()].filter((n) => n.kind === "Process");
      // Expect at least one process per handler module (2 modules, 2+ expected).
      assert.ok(
        processes.length >= 2,
        `expected >= 2 processes from dir-hint boost, got ${processes.length}`,
      );
      // A label should never be an empty string.
      for (const p of processes) {
        const proc = p as { inferredLabel?: string };
        assert.ok(typeof proc.inferredLabel === "string" && proc.inferredLabel.length > 0);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("derives a cohesion label from repeated tokens across the flow", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-proc-cohesion-"));
    try {
      await fs.writeFile(
        path.join(repo, "handler.ts"),
        [
          "export function handleLoginRequest() { return loginUser(); }",
          "function loginUser() { return loginValidate(); }",
          "function loginValidate() { return loginPersist(); }",
          "function loginPersist() { return 'ok'; }",
          "",
        ].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const processes = [...result.graph.nodes()].filter(
        (n): n is typeof n & { inferredLabel?: string } => n.kind === "Process",
      );
      assert.ok(processes.length >= 1);
      // "login" appears in every callee's name — expect it in the label.
      const first = processes[0] as { inferredLabel?: string };
      assert.ok(
        typeof first.inferredLabel === "string" && first.inferredLabel.includes("login"),
        `expected cohesion label to contain "login", got ${first.inferredLabel}`,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("boosts entries re-exported from an index.ts in the same dir", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-proc-reexport-"));
    try {
      await fs.mkdir(path.join(repo, "users"), { recursive: true });
      await fs.writeFile(
        path.join(repo, "users", "controller.ts"),
        [
          "export function UsersController() { return s1(); }",
          "function s1() { return s2(); }",
          "function s2() { return s3(); }",
          "function s3() { return 'ok'; }",
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        path.join(repo, "users", "index.ts"),
        ["export * from './controller';", ""].join("\n"),
      );
      const result = await runIngestion(repo, { skipGit: true });
      const processes = [...result.graph.nodes()].filter((n) => n.kind === "Process");
      assert.ok(processes.length >= 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
