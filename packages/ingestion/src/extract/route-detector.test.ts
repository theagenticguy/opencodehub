import assert from "node:assert/strict";
import { test } from "node:test";
import { detectExpressRoutes, detectNextJsRoutes } from "./route-detector.js";

const REPO = "/repo";

test("detectNextJsRoutes: app/users/route.ts exporting GET", () => {
  const routes = detectNextJsRoutes(
    [
      {
        filePath: "/repo/app/users/route.ts",
        content: "export async function GET(request) { return Response.json({ users: [] }); }",
      },
    ],
    REPO,
  );
  assert.deepEqual(routes, [
    {
      url: "/users",
      method: "GET",
      handlerFile: "app/users/route.ts",
      framework: "nextjs",
    },
  ]);
});

test("detectNextJsRoutes: dynamic segment [id] becomes {id}", () => {
  const routes = detectNextJsRoutes(
    [
      {
        filePath: "/repo/app/posts/[id]/route.ts",
        content: "export const POST = async () => Response.json({});",
      },
    ],
    REPO,
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.url, "/posts/{id}");
  assert.equal(routes[0]?.method, "POST");
});

test("detectNextJsRoutes: route groups are stripped", () => {
  const routes = detectNextJsRoutes(
    [
      {
        filePath: "/repo/app/(admin)/dashboard/page.tsx",
        content: "export default function Page() { return null; }",
      },
    ],
    REPO,
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.url, "/dashboard");
  assert.equal(routes[0]?.method, undefined);
  assert.equal(routes[0]?.framework, "nextjs");
});

test("detectNextJsRoutes: catch-all [...slug] becomes {+slug}; layout.tsx is skipped", () => {
  const routes = detectNextJsRoutes(
    [
      {
        filePath: "/repo/app/docs/[...slug]/page.tsx",
        content: "export default function Docs() {}",
      },
      {
        filePath: "/repo/app/layout.tsx",
        content: "export default function Layout() {}",
      },
    ],
    REPO,
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.url, "/docs/{+slug}");
});

test("detectNextJsRoutes: multiple HTTP verb exports -> multiple routes, canonical order", () => {
  const routes = detectNextJsRoutes(
    [
      {
        filePath: "/repo/app/api/things/route.ts",
        content: [
          "export async function POST() {}",
          "export async function GET() {}",
          "export const DELETE = async () => {};",
        ].join("\n"),
      },
    ],
    REPO,
  );
  assert.deepEqual(
    routes.map((r) => r.method),
    ["GET", "POST", "DELETE"],
  );
  for (const r of routes) assert.equal(r.url, "/api/things");
});

test("detectExpressRoutes: app.get('/health', handler) -> GET /health", () => {
  const routes = detectExpressRoutes({
    filePath: "src/server.ts",
    content: "app.get('/health', (req, res) => res.json({ ok: true }));",
  });
  assert.deepEqual(routes, [
    {
      url: "/health",
      method: "GET",
      handlerFile: "src/server.ts",
      framework: "express",
      responseKeys: ["ok"],
    },
  ]);
});

test("detectExpressRoutes: router.post with middleware; supports double quotes", () => {
  const routes = detectExpressRoutes({
    filePath: "src/routes/users.ts",
    content: 'router.post("/users", authMiddleware, createUser);',
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.method, "POST");
  assert.equal(routes[0]?.url, "/users");
});

test("detectExpressRoutes: template literal path without interpolation is kept", () => {
  const routes = detectExpressRoutes({
    filePath: "src/api.ts",
    content: "apiRouter.put(`/items`, handler);",
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.method, "PUT");
  assert.equal(routes[0]?.url, "/items");
});
