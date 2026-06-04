/**
 * Tests for `codehub setup --cobol-proleap`. Uses an in-memory ProcessApi
 * so the suite never shells out. Covers:
 *
 *   - Missing tool precondition errors emit tool-specific install hints.
 *   - javac < 17 refused with the JDK-upgrade hint.
 *   - Happy path: git clone + mvn install + javac + atomic rename succeed;
 *     the result reports the final JAR + wrapper class paths.
 *   - Idempotency: a second call with the JAR + wrapper class already in
 *     place skips without re-running the build.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_PROCESS_API,
  defaultVendorDir,
  type ProcessApi,
  type ProcessResult,
  runSetupCobolProleap,
} from "./cobol-proleap-setup.js";

/** Scripted ProcessApi: looks up `(cmd, args)` in the registered map. */
interface Script {
  toolResponses: Map<string, ProcessResult>;
  fsFiles: Set<string>;
  fsDirs: Set<string>;
  fsReaddir: Map<string, readonly string[]>;
  calls: { cmd: string; args: readonly string[] }[];
}

function makeScript(init: Partial<Script> = {}): Script {
  return {
    toolResponses: init.toolResponses ?? new Map(),
    fsFiles: init.fsFiles ?? new Set(),
    fsDirs: init.fsDirs ?? new Set(),
    fsReaddir: init.fsReaddir ?? new Map(),
    calls: [],
  };
}

function makeProcessApi(script: Script): ProcessApi {
  return {
    async run(cmd, args) {
      script.calls.push({ cmd, args });
      const key = `${cmd} ${args.join(" ")}`;
      const response = script.toolResponses.get(key);
      if (response !== undefined) return response;
      // Match by command + first arg (covers e.g. `git clone` vs `git --version`).
      const prefix = `${cmd} ${args[0] ?? ""}`;
      const prefixResponse = script.toolResponses.get(prefix);
      if (prefixResponse !== undefined) return prefixResponse;
      return { code: 127, stdout: "", stderr: `stub: no script for ${key}` };
    },
    async mkdtemp(prefix) {
      const dir = `/tmp/${prefix}abcdef`;
      script.fsDirs.add(dir);
      return dir;
    },
    async mkdir(path) {
      script.fsDirs.add(path);
    },
    async copyFile(_src, dest) {
      script.fsFiles.add(dest);
    },
    async rename(src, dest) {
      script.fsFiles.add(dest);
      script.fsFiles.delete(src);
    },
    async rm(_path, _opts) {
      // Best-effort in the test; cleanup is non-load-bearing.
    },
    async readdir(path) {
      return script.fsReaddir.get(path) ?? [];
    },
    async exists(path) {
      return script.fsFiles.has(path) || script.fsDirs.has(path);
    },
  };
}

test("runSetupCobolProleap: surfaces a git-missing install hint when the binary is not on PATH", async () => {
  const script = makeScript({
    toolResponses: new Map([["git --version", { code: 127, stdout: "", stderr: "ENOENT" }]]),
  });
  const proc = makeProcessApi(script);
  await assert.rejects(
    runSetupCobolProleap({
      processApi: proc,
      vendorDir: "/test/vendor",
      log: () => undefined,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /git not on PATH/);
      assert.match(err.message, /git-scm/);
      return true;
    },
  );
});

test("runSetupCobolProleap: refuses when javac reports version < 17", async () => {
  const script = makeScript({
    toolResponses: new Map([
      ["git --version", { code: 0, stdout: "git version 2.40.0", stderr: "" }],
      ["mvn --version", { code: 0, stdout: "Apache Maven 3.8.6", stderr: "" }],
      ["javac --version", { code: 0, stdout: "javac 11.0.2", stderr: "" }],
    ]),
  });
  const proc = makeProcessApi(script);
  await assert.rejects(
    runSetupCobolProleap({
      processApi: proc,
      vendorDir: "/test/vendor",
      log: () => undefined,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /< 17/);
      assert.match(err.message, /openjdk@17|openjdk-17-jdk/);
      return true;
    },
  );
});

test("runSetupCobolProleap: happy path — builds from source and atomic-renames into the vendor dir", async () => {
  const script = makeScript({
    toolResponses: new Map([
      ["git --version", { code: 0, stdout: "git version 2.40.0", stderr: "" }],
      ["mvn --version", { code: 0, stdout: "Apache Maven 3.8.6", stderr: "" }],
      ["javac --version", { code: 0, stdout: "javac 21.0.1", stderr: "" }],
      ["git clone", { code: 0, stdout: "", stderr: "" }],
      ["mvn install", { code: 0, stdout: "BUILD SUCCESS", stderr: "" }],
      ["javac -cp", { code: 0, stdout: "", stderr: "" }],
    ]),
    fsReaddir: new Map([
      [
        "/tmp/codehub-proleap-abcdef/cobol-parser/target",
        ["proleap-cobol-parser-4.0.0.jar", "proleap-cobol-parser-4.0.0-sources.jar"],
      ],
    ]),
    // The wrapper Java source must exist for the pre-flight to pass. The
    // test points javaSourcePath at an in-memory file.
    fsFiles: new Set([
      "/test/java/cobol_to_scip.java",
      "/tmp/codehub-proleap-abcdef/cobol-parser/target/proleap-cobol-parser-4.0.0.jar",
      "/tmp/codehub-proleap-abcdef/wrapper/cobol_to_scip.class",
    ]),
  });
  const proc = makeProcessApi(script);
  const result = await runSetupCobolProleap({
    processApi: proc,
    vendorDir: "/test/vendor",
    javaSourcePath: "/test/java/cobol_to_scip.java",
    log: () => undefined,
  });
  assert.equal(result.installed, true);
  assert.equal(result.skipped, false);
  assert.equal(result.vendorDir, "/test/vendor");
  // jarPath is `join(vendorDir, …)` → backslashes on Windows; assert against
  // the same join rather than a forward-slash regex.
  assert.equal(result.jarPath, join("/test/vendor", "proleap-cobol-parser.jar"));
  // Confirm the script invoked every expected tool.
  const cmds = script.calls.map((c) => `${c.cmd} ${c.args[0] ?? ""}`);
  assert.ok(cmds.includes("git --version"));
  assert.ok(cmds.includes("mvn --version"));
  assert.ok(cmds.includes("javac --version"));
  assert.ok(cmds.includes("git clone"));
  assert.ok(cmds.includes("mvn install"));
});

test("runSetupCobolProleap: idempotent when jar + wrapper class already exist", async () => {
  const script = makeScript({
    fsFiles: new Set(["/test/vendor/proleap-cobol-parser.jar", "/test/vendor/cobol_to_scip.class"]),
  });
  const proc = makeProcessApi(script);
  const result = await runSetupCobolProleap({
    processApi: proc,
    vendorDir: "/test/vendor",
    log: () => undefined,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.installed, false);
  // No tool probes should have fired on the skip path.
  assert.equal(script.calls.length, 0);
});

test("defaultVendorDir: resolves under ~/.codehub/vendor/proleap", () => {
  const home = "/Users/alice";
  const dir = defaultVendorDir(home);
  // `join` so the expected separator matches the platform (the impl joins).
  assert.equal(dir, join(home, ".codehub", "vendor", "proleap"));
});

test("DEFAULT_PROCESS_API is exported for the cli action", () => {
  assert.equal(typeof DEFAULT_PROCESS_API.run, "function");
});
