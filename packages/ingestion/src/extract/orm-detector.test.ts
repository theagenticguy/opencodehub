import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPrismaCalls, detectSupabaseCalls } from "./orm-detector.js";

test("detectPrismaCalls: prisma.user.findMany -> user/findMany", () => {
  const edges = detectPrismaCalls({
    filePath: "src/users.ts",
    content: "const users = await prisma.user.findMany({ where: { active: true } });",
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.modelName, "user");
  assert.equal(edges[0]?.operation, "findMany");
  assert.equal(edges[0]?.orm, "prisma");
  assert.equal(edges[0]?.confidence, 0.9);
});

test("detectPrismaCalls: multiple ops and models emitted in order", () => {
  const edges = detectPrismaCalls({
    filePath: "src/mixed.ts",
    content: [
      "await prisma.post.create({ data });",
      "await prisma.user.update({ where: { id }, data });",
      "await prisma.comment.deleteMany({});",
    ].join("\n"),
  });
  assert.deepEqual(
    edges.map((e) => `${e.modelName}.${e.operation}`),
    ["post.create", "user.update", "comment.deleteMany"],
  );
});

test("detectPrismaCalls: unrelated method calls are ignored", () => {
  const edges = detectPrismaCalls({
    filePath: "src/misc.ts",
    content: "logger.info.log('hi'); prisma.$transaction(ops); someOther.user.findMany();",
  });
  assert.deepEqual(edges, []);
});

test("detectSupabaseCalls: supabase.from('users').select -> users/select", () => {
  const edges = detectSupabaseCalls({
    filePath: "src/list.ts",
    content: "const { data } = await supabase.from('users').select('*');",
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.modelName, "users");
  assert.equal(edges[0]?.operation, "select");
  assert.equal(edges[0]?.orm, "supabase");
  assert.equal(edges[0]?.confidence, 0.85);
});

test("detectSupabaseCalls: .insert and .upsert both recognised; .from without an op is skipped", () => {
  const edges = detectSupabaseCalls({
    filePath: "src/write.ts",
    content: [
      "await supabase.from('orders').insert({ amount: 10 });",
      "await supabase.from('cache').upsert({ key: 'k', value: 'v' });",
      "const builder = supabase.from('dangling');",
    ].join("\n"),
  });
  assert.deepEqual(
    edges.map((e) => `${e.modelName}.${e.operation}`),
    ["orders.insert", "cache.upsert"],
  );
});
