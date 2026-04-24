import assert from "node:assert/strict";
import { test } from "node:test";
import { detectNestJsRoutes } from "./route-detector-nestjs.js";

test("detectNestJsRoutes: @Get on a controller method", () => {
  const content = `
import { Controller, Get } from "@nestjs/common";

@Controller("/users")
export class UserController {
  @Get()
  findAll() { return []; }
}
`;
  const routes = detectNestJsRoutes({ filePath: "user.controller.ts", content });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.url, "/users");
  assert.equal(routes[0]?.method, "GET");
  assert.equal(routes[0]?.framework, "nestjs");
});

test("detectNestJsRoutes: @Post(':id') with controller prefix", () => {
  const content = `
@Controller("items")
export class ItemController {
  @Post(":id")
  create() {}

  @Delete(":id")
  remove() {}
}
`;
  const routes = detectNestJsRoutes({ filePath: "item.controller.ts", content });
  const byMethod = new Map(routes.map((r) => [r.method, r.url]));
  assert.equal(byMethod.get("POST"), "/items/:id");
  assert.equal(byMethod.get("DELETE"), "/items/:id");
});

test("detectNestJsRoutes: @All() emits a method-less route", () => {
  const content = `
@Controller("catchall")
export class CatchController {
  @All()
  handle() {}
}
`;
  const routes = detectNestJsRoutes({ filePath: "catch.controller.ts", content });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.url, "/catchall");
  assert.equal(routes[0]?.method, undefined);
});

test("detectNestJsRoutes: negative — plain TS file with no Nest decorators", () => {
  const content = `
export class PlainService {
  foo() { return "bar"; }
}
`;
  const routes = detectNestJsRoutes({ filePath: "plain.service.ts", content });
  assert.equal(routes.length, 0);
});
