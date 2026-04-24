import assert from "node:assert/strict";
import { test } from "node:test";
import { detectRailsRoutes } from "./route-detector-rails.js";

test("detectRailsRoutes: verb-level routes", () => {
  const content = `
Rails.application.routes.draw do
  get "/health", to: "health#index"
  post "/login", to: "sessions#create"
end
`;
  const routes = detectRailsRoutes("config/routes.rb", content);
  const byUrl = new Map(routes.map((r) => [`${r.method} ${r.url}`, r]));
  assert.ok(byUrl.has("GET /health"));
  assert.ok(byUrl.has("POST /login"));
  assert.equal(routes[0]?.framework, "rails");
});

test("detectRailsRoutes: resources :posts expands to the eight canonical routes", () => {
  const content = `
Rails.application.routes.draw do
  resources :posts
end
`;
  const routes = detectRailsRoutes("config/routes.rb", content);
  const keys = new Set(routes.map((r) => `${r.method} ${r.url}`));
  assert.ok(keys.has("GET /posts"));
  assert.ok(keys.has("POST /posts"));
  assert.ok(keys.has("GET /posts/new"));
  assert.ok(keys.has("GET /posts/:id"));
  assert.ok(keys.has("GET /posts/:id/edit"));
  assert.ok(keys.has("PATCH /posts/:id"));
  assert.ok(keys.has("PUT /posts/:id"));
  assert.ok(keys.has("DELETE /posts/:id"));
});

test("detectRailsRoutes: namespace :admin wraps routes with /admin prefix", () => {
  const content = `
Rails.application.routes.draw do
  namespace :admin do
    get "/dashboard", to: "admin/dashboard#index"
  end
end
`;
  const routes = detectRailsRoutes("config/routes.rb", content);
  const dash = routes.find((r) => r.url === "/admin/dashboard");
  assert.ok(dash !== undefined);
  assert.equal(dash?.method, "GET");
});

test("detectRailsRoutes: negative — a plain .rb file without a route DSL", () => {
  const content = `
class Util
  def helper
    "x"
  end
end
`;
  const routes = detectRailsRoutes("app/util.rb", content);
  assert.equal(routes.length, 0);
});
