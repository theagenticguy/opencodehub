/**
 * Path-resolution unit tests — runs in isolation, no model files needed.
 */

import { deepEqual, equal, ok } from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getDefaultModelRoot, modelFileName, resolveModelDir, TOKENIZER_FILES } from "./paths.js";

describe("paths", () => {
  const originalHome = process.env["CODEHUB_HOME"];

  beforeEach(() => {
    delete process.env["CODEHUB_HOME"];
  });
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["CODEHUB_HOME"];
    } else {
      process.env["CODEHUB_HOME"] = originalHome;
    }
  });

  it("getDefaultModelRoot falls back to ~/.codehub", () => {
    const root = getDefaultModelRoot();
    equal(root, join(homedir(), ".codehub"));
  });

  it("getDefaultModelRoot honours CODEHUB_HOME env", () => {
    process.env["CODEHUB_HOME"] = `${sep}tmp${sep}custom-codehub`;
    const root = getDefaultModelRoot();
    // The impl returns `resolve(envHome)`, which on Windows prepends the
    // current drive letter — mirror it rather than expecting the raw input.
    equal(root, resolve(`${sep}tmp${sep}custom-codehub`));
  });

  it("resolveModelDir builds fp32 path by default", () => {
    const dir = resolveModelDir();
    equal(dir, join(homedir(), ".codehub", "models", "f2llm-v2-80m", "fp32"));
  });

  it("resolveModelDir respects int8 variant", () => {
    const dir = resolveModelDir(undefined, "int8");
    equal(dir, join(homedir(), ".codehub", "models", "f2llm-v2-80m", "int8"));
  });

  it("resolveModelDir returns override unchanged when provided", () => {
    const dir = resolveModelDir(`${sep}tmp${sep}my-models${sep}xs`);
    // `resolve` of an already-absolute POSIX-ish path is a no-op on POSIX but
    // prepends the drive on Windows; mirror the impl so the assertion holds
    // cross-platform.
    equal(dir, resolve(`${sep}tmp${sep}my-models${sep}xs`));
  });

  it("modelFileName picks the right ONNX filename per variant", () => {
    equal(modelFileName("fp32"), "model.onnx");
    equal(modelFileName("int8"), "model_int8.onnx");
  });

  it("TOKENIZER_FILES enumerates the two required JSON files", () => {
    deepEqual([...TOKENIZER_FILES], ["tokenizer.json", "tokenizer_config.json"]);
    ok(TOKENIZER_FILES.length === 2);
  });
});
