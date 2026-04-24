import assert from "node:assert/strict";
import { test } from "node:test";
import { detectFastApiRoutes } from "./route-detector-python.js";

test("detectFastApiRoutes: @app.get on a function", () => {
  const content = `
from fastapi import FastAPI

app = FastAPI()

@app.get("/users")
def list_users():
    return {"users": []}
`;
  const routes = detectFastApiRoutes({ filePath: "api.py", content });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.url, "/users");
  assert.equal(routes[0]?.method, "GET");
  assert.equal(routes[0]?.framework, "fastapi");
  assert.equal(routes[0]?.handlerFile, "api.py");
});

test("detectFastApiRoutes: @router.post with path parameter", () => {
  const content = `
from fastapi import APIRouter

router = APIRouter()

@router.post("/items/{item_id}")
def create_item(item_id: str):
    ...
`;
  const routes = detectFastApiRoutes({ filePath: "items.py", content });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.url, "/items/{item_id}");
  assert.equal(routes[0]?.method, "POST");
});

test("detectFastApiRoutes: @app.api_route with multi-method list", () => {
  const content = `
@app.api_route("/status", methods=["GET", "HEAD"])
def status():
    return "ok"
`;
  const routes = detectFastApiRoutes({ filePath: "status.py", content });
  assert.equal(routes.length, 2);
  const methods = routes.map((r) => r.method).sort();
  assert.deepEqual(methods, ["GET", "HEAD"]);
});

test("detectFastApiRoutes: negative — no decorator means no routes", () => {
  const content = `
def list_users():
    return []

class UsersRepo:
    def fetch(self):
        return []
`;
  const routes = detectFastApiRoutes({ filePath: "plain.py", content });
  assert.equal(routes.length, 0);
});
