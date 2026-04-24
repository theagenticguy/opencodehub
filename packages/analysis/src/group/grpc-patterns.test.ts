import assert from "node:assert/strict";
import { test } from "node:test";
import { extractGrpcClientContracts, extractGrpcProtoContracts } from "./grpc-patterns.js";

test("extractGrpcProtoContracts: service + rpcs produce fully qualified signatures", () => {
  const source = [
    'syntax = "proto3";',
    "package hello.v1;",
    "",
    "service Greeter {",
    "  rpc SayHello (HelloRequest) returns (HelloResponse);",
    "  rpc SayGoodbye (ByeRequest) returns (ByeResponse);",
    "}",
  ].join("\n");
  const out = extractGrpcProtoContracts({
    repo: "proto",
    file: "hello.proto",
    source,
  });
  const sigs = out.map((c) => c.signature).sort();
  assert.deepEqual(sigs, ["hello.v1.Greeter/SayGoodbye", "hello.v1.Greeter/SayHello"]);
  for (const c of out) {
    assert.equal(c.type, "grpc_service");
    assert.equal(c.repo, "proto");
    assert.equal(c.file, "hello.proto");
  }
});

test("extractGrpcProtoContracts: service with no rpcs still emits one entry", () => {
  const source = ["package x.v1;", "service Empty {", "}"].join("\n");
  const out = extractGrpcProtoContracts({ repo: "p", file: "x.proto", source });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.signature, "x.v1.Empty");
});

test("extractGrpcClientContracts: TS new GreeterClient(...) emits a consumer", () => {
  const source = "const c = new GreeterClient('localhost:50051');";
  const out = extractGrpcClientContracts({
    repo: "web",
    file: "src/call.ts",
    source,
    language: "ts",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.type, "grpc_client");
  assert.equal(out[0]?.signature, "Greeter");
});

test("extractGrpcClientContracts: Python GreeterStub(channel) emits a consumer", () => {
  const source = "stub = GreeterStub(channel)";
  const out = extractGrpcClientContracts({
    repo: "web",
    file: "client.py",
    source,
    language: "py",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.type, "grpc_client");
  assert.equal(out[0]?.signature, "Greeter");
});
