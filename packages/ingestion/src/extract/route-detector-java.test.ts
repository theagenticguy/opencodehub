import assert from "node:assert/strict";
import { test } from "node:test";
import { detectSpringRoutes } from "./route-detector-java.js";

test("detectSpringRoutes: @GetMapping on a controller method", () => {
  const content = `
package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class UserController {
  @GetMapping("/users")
  public List<User> list() {
    return List.of();
  }
}
`;
  const routes = detectSpringRoutes({ filePath: "UserController.java", content });
  const get = routes.filter((r) => r.method === "GET");
  assert.ok(get.length >= 1);
  assert.ok(get.some((r) => r.url === "/api/users"));
  assert.equal(routes[0]?.framework, "spring");
});

test("detectSpringRoutes: @RequestMapping with method filter", () => {
  const content = `
@RestController
public class OrderController {
  @RequestMapping(value = "/orders", method = RequestMethod.POST)
  public Order create(@RequestBody Order o) { return o; }
}
`;
  const routes = detectSpringRoutes({ filePath: "OrderController.java", content });
  assert.ok(routes.some((r) => r.url === "/orders" && r.method === "POST"));
});

test("detectSpringRoutes: @RequestMapping with multiple methods", () => {
  const content = `
@Controller
public class MultiController {
  @RequestMapping(value = "/multi", method = { RequestMethod.GET, RequestMethod.HEAD })
  public void multi() {}
}
`;
  const routes = detectSpringRoutes({ filePath: "MultiController.java", content });
  const methods = routes
    .filter((r) => r.url === "/multi")
    .map((r) => r.method)
    .sort();
  assert.deepEqual(methods, ["GET", "HEAD"]);
});

test("detectSpringRoutes: negative — plain POJO without mappings", () => {
  const content = `
public class User {
  private String name;
  public String getName() { return name; }
}
`;
  const routes = detectSpringRoutes({ filePath: "User.java", content });
  assert.equal(routes.length, 0);
});
