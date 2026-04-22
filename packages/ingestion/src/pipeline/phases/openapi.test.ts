import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { OperationNode, RouteNode } from "@opencodehub/core-types";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext, ProgressEvent } from "../types.js";
import { openapiPhase } from "./openapi.js";
import { PARSE_PHASE_NAME, parsePhase } from "./parse.js";
import { PROFILE_PHASE_NAME, profilePhase } from "./profile.js";
import { ROUTES_PHASE_NAME, routesPhase } from "./routes.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, structurePhase } from "./structure.js";

/**
 * Run scan → profile → structure → parse → routes in the order required
 * for the OpenAPI phase deps. Returns the accumulated context so each
 * test can snapshot / extend it.
 */
async function runPrereqPhases(repo: string): Promise<{
  ctx: PipelineContext;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const onProgress = (ev: ProgressEvent): void => {
    if (ev.kind === "warn" && ev.message) warnings.push(ev.message);
  };
  const ctx: PipelineContext = {
    repoPath: repo,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
    onProgress,
  };
  const scan = await scanPhase.run(ctx, new Map());
  const profile = await profilePhase.run(
    { ...ctx, phaseOutputs: new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]) },
    new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
  );
  const structure = await structurePhase.run(
    { ...ctx, phaseOutputs: new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]) },
    new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
  );
  const parse = await parsePhase.run(
    {
      ...ctx,
      phaseOutputs: new Map<string, unknown>([
        [SCAN_PHASE_NAME, scan],
        [STRUCTURE_PHASE_NAME, structure],
      ]),
    },
    new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
    ]),
  );
  const routesCtx: PipelineContext = {
    ...ctx,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
      [PARSE_PHASE_NAME, parse],
      [PROFILE_PHASE_NAME, profile],
    ]),
  };
  const routes = await routesPhase.run(
    routesCtx,
    new Map<string, unknown>([[PARSE_PHASE_NAME, parse]]),
  );
  const liveCtx: PipelineContext = {
    ...ctx,
    phaseOutputs: new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
      [PARSE_PHASE_NAME, parse],
      [PROFILE_PHASE_NAME, profile],
      [ROUTES_PHASE_NAME, routes],
    ]),
  };
  return { ctx: liveCtx, warnings };
}

describe("openapiPhase", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "och-openapi-"));

    // Express server declaring three routes that the OpenAPI spec also lists.
    await fs.writeFile(
      path.join(repo, "server.ts"),
      [
        "import express from 'express';",
        "const app = express();",
        "app.get('/users', (_req, res) => res.json([]));",
        "app.post('/users', (_req, res) => res.json({}));",
        "app.get('/users/:id', (_req, res) => res.json({}));",
        "",
      ].join("\n"),
    );

    // OpenAPI spec with a $ref for cross-ref dereference coverage.
    await fs.writeFile(
      path.join(repo, "openapi.yaml"),
      [
        "openapi: 3.0.3",
        "info:",
        "  title: Users API",
        "  version: 1.0.0",
        "paths:",
        "  /users:",
        "    get:",
        "      summary: list users",
        "      operationId: listUsers",
        "      responses:",
        "        '200':",
        "          description: ok",
        "          content:",
        "            application/json:",
        "              schema: { $ref: '#/components/schemas/UserList' }",
        "    post:",
        "      summary: create a user",
        "      operationId: createUser",
        "      responses:",
        "        '201':",
        "          description: created",
        "  /users/{id}:",
        "    get:",
        "      summary: fetch one user",
        "      operationId: getUser",
        "      parameters:",
        "        - name: id",
        "          in: path",
        "          required: true",
        "          schema: { type: string }",
        "      responses:",
        "        '200':",
        "          description: ok",
        "          content:",
        "            application/json:",
        "              schema: { $ref: '#/components/schemas/User' }",
        "components:",
        "  schemas:",
        "    User:",
        "      type: object",
        "      properties:",
        "        id: { type: string }",
        "        name: { type: string }",
        "    UserList:",
        "      type: array",
        "      items: { $ref: '#/components/schemas/User' }",
        "",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("emits Operation nodes, resolves $refs, and links matching Routes", async () => {
    const { ctx } = await runPrereqPhases(repo);
    const out = await openapiPhase.run(
      ctx,
      new Map<string, unknown>([
        [ROUTES_PHASE_NAME, ctx.phaseOutputs.get(ROUTES_PHASE_NAME)],
        [PROFILE_PHASE_NAME, ctx.phaseOutputs.get(PROFILE_PHASE_NAME)],
      ]),
    );

    assert.equal(out.specsProcessed, 1, "one spec processed");
    assert.equal(out.operationsEmitted, 3, "three operations emitted");
    assert.equal(out.routesLinked, 3, "all three operations link to a Route");

    const operationNodes = [...ctx.graph.nodes()].filter(
      (n): n is OperationNode => n.kind === "Operation",
    );
    assert.equal(operationNodes.length, 3);
    const sig = operationNodes.map((o) => `${o.method} ${o.path}`).sort();
    assert.deepEqual(sig, ["GET /users", "GET /users/{id}", "POST /users"]);

    const listUsers = operationNodes.find((o) => o.operationId === "listUsers");
    assert.ok(listUsers);
    assert.equal(listUsers.summary, "list users");

    const handlesRoute = [...ctx.graph.edges()].filter((e) => e.type === "HANDLES_ROUTE");
    const fromOperation = handlesRoute.filter((e) =>
      (e.from as unknown as string).startsWith("Operation:"),
    );
    assert.equal(fromOperation.length, 3, "three Operation→Route edges");
    for (const e of fromOperation) {
      assert.equal(e.confidence, 0.95);
      assert.equal(e.reason, "openapi-spec");
    }

    // Ensure the spec-side `{id}` template collapsed onto the Express `:id`
    // normalisation: the Operation for `GET /users/{id}` must match the
    // Route whose url ends with `:id`.
    const routeNodes = [...ctx.graph.nodes()].filter((n): n is RouteNode => n.kind === "Route");
    const getByIdEdge = fromOperation.find((e) => {
      const op = operationNodes.find((o) => o.id === (e.from as unknown as string));
      return op?.method === "GET" && op.path === "/users/{id}";
    });
    assert.ok(getByIdEdge);
    const matchedRoute = routeNodes.find(
      (r) => (r.id as unknown as string) === (getByIdEdge.to as unknown as string),
    );
    assert.ok(matchedRoute);
    assert.equal(matchedRoute.method, "GET");
    assert.equal(matchedRoute.url, "/users/:id");
  });

  it("is a no-op when ProjectProfile.apiContracts does not include openapi", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "och-openapi-skip-"));
    try {
      await fs.writeFile(
        path.join(dir, "server.ts"),
        [
          "import express from 'express';",
          "const app = express();",
          "app.get('/health', (_req, res) => res.json({ ok: true }));",
          "",
        ].join("\n"),
      );
      // No openapi.yaml / swagger.yaml → profile will not detect openapi.
      const { ctx } = await runPrereqPhases(dir);
      const out = await openapiPhase.run(
        ctx,
        new Map<string, unknown>([
          [ROUTES_PHASE_NAME, ctx.phaseOutputs.get(ROUTES_PHASE_NAME)],
          [PROFILE_PHASE_NAME, ctx.phaseOutputs.get(PROFILE_PHASE_NAME)],
        ]),
      );
      assert.equal(out.operationsEmitted, 0);
      assert.equal(out.routesLinked, 0);
      assert.equal(out.specsProcessed, 0);
      const operations = [...ctx.graph.nodes()].filter((n) => n.kind === "Operation");
      assert.equal(operations.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("warns and continues on malformed specs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "och-openapi-bad-"));
    try {
      // Intentionally malformed YAML that still triggers the profile detector
      // via the `openapi:` header sniff.
      await fs.writeFile(
        path.join(dir, "openapi.yaml"),
        ["openapi: 3.0.3", "paths:", "  /users:", "    get: {broken"].join("\n"),
      );
      await fs.writeFile(
        path.join(dir, "server.ts"),
        [
          "import express from 'express';",
          "const app = express();",
          "app.get('/users', (_req, res) => res.json([]));",
          "",
        ].join("\n"),
      );

      const warnings: string[] = [];
      const baseCtx: PipelineContext = {
        repoPath: dir,
        options: { skipGit: true },
        graph: new KnowledgeGraph(),
        phaseOutputs: new Map(),
        onProgress: (ev) => {
          if (ev.kind === "warn" && ev.message) warnings.push(ev.message);
        },
      };
      const scan = await scanPhase.run(baseCtx, new Map());
      const profile = await profilePhase.run(
        { ...baseCtx, phaseOutputs: new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]) },
        new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
      );
      const structure = await structurePhase.run(
        { ...baseCtx, phaseOutputs: new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]) },
        new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
      );
      const parse = await parsePhase.run(
        {
          ...baseCtx,
          phaseOutputs: new Map<string, unknown>([
            [SCAN_PHASE_NAME, scan],
            [STRUCTURE_PHASE_NAME, structure],
          ]),
        },
        new Map<string, unknown>([
          [SCAN_PHASE_NAME, scan],
          [STRUCTURE_PHASE_NAME, structure],
        ]),
      );
      const routesCtx: PipelineContext = {
        ...baseCtx,
        phaseOutputs: new Map<string, unknown>([
          [SCAN_PHASE_NAME, scan],
          [STRUCTURE_PHASE_NAME, structure],
          [PARSE_PHASE_NAME, parse],
          [PROFILE_PHASE_NAME, profile],
        ]),
      };
      const routes = await routesPhase.run(
        routesCtx,
        new Map<string, unknown>([[PARSE_PHASE_NAME, parse]]),
      );
      const liveCtx: PipelineContext = {
        ...baseCtx,
        phaseOutputs: new Map<string, unknown>([
          [SCAN_PHASE_NAME, scan],
          [STRUCTURE_PHASE_NAME, structure],
          [PARSE_PHASE_NAME, parse],
          [PROFILE_PHASE_NAME, profile],
          [ROUTES_PHASE_NAME, routes],
        ]),
      };

      // Only run when profile actually detected openapi; if not, this branch
      // degenerates to the no-op path which is already covered above.
      const profileEntry = liveCtx.phaseOutputs.get(PROFILE_PHASE_NAME);
      assert.ok(profileEntry);
      const out = await openapiPhase.run(
        liveCtx,
        new Map<string, unknown>([
          [ROUTES_PHASE_NAME, routes],
          [PROFILE_PHASE_NAME, profileEntry],
        ]),
      );
      assert.equal(out.operationsEmitted, 0);
      assert.equal(out.specsProcessed, 0);
      assert.ok(
        warnings.some((w) => w.startsWith("openapi: failed to parse")),
        `expected a parse-failure warning, got: ${warnings.join(" | ")}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
