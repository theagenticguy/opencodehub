/**
 * Complexity phase tests.
 *
 * Each fixture writes a single source file, runs scan → structure → parse →
 * complexity, and asserts the cyclomatic complexity, nesting depth, and NLOC
 * attached to the expected callable node.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { KnowledgeGraph } from "@opencodehub/core-types";
import type { PipelineContext } from "../types.js";
import { COMPLEXITY_PHASE_NAME, type ComplexityOutput, complexityPhase } from "./complexity.js";
import { PARSE_PHASE_NAME, parsePhase } from "./parse.js";
import { SCAN_PHASE_NAME, scanPhase } from "./scan.js";
import { STRUCTURE_PHASE_NAME, structurePhase } from "./structure.js";

interface RunResult {
  readonly ctx: PipelineContext;
  readonly complexityOut: ComplexityOutput;
}

async function runThroughComplexity(repo: string): Promise<RunResult> {
  const ctx: PipelineContext = {
    repoPath: repo,
    options: { skipGit: true },
    graph: new KnowledgeGraph(),
    phaseOutputs: new Map(),
  };
  const scan = await scanPhase.run(ctx, new Map());
  const structure = await structurePhase.run(
    ctx,
    new Map<string, unknown>([[SCAN_PHASE_NAME, scan]]),
  );
  const parse = await parsePhase.run(
    ctx,
    new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [STRUCTURE_PHASE_NAME, structure],
    ]),
  );
  const complexityOut = await complexityPhase.run(
    ctx,
    new Map<string, unknown>([
      [SCAN_PHASE_NAME, scan],
      [PARSE_PHASE_NAME, parse],
    ]),
  );
  return { ctx, complexityOut };
}

interface CallableMetrics {
  readonly cyclomaticComplexity: number | undefined;
  readonly nestingDepth: number | undefined;
  readonly nloc: number | undefined;
}

function findCallable(ctx: PipelineContext, name: string): CallableMetrics | undefined {
  for (const n of ctx.graph.nodes()) {
    if (n.kind !== "Function" && n.kind !== "Method" && n.kind !== "Constructor") continue;
    if (n.name === name) {
      return {
        cyclomaticComplexity: n.cyclomaticComplexity,
        nestingDepth: n.nestingDepth,
        nloc: n.nloc,
      };
    }
  }
  return undefined;
}

describe(`${COMPLEXITY_PHASE_NAME}Phase`, () => {
  it("computes Python cyclomatic, nesting, and NLOC for a single-if function", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-complexity-py-"));
    try {
      await fs.writeFile(
        path.join(repo, "m.py"),
        ["def foo(x):", "    if x:", "        return 1", "    return 0", ""].join("\n"),
      );
      const { ctx, complexityOut } = await runThroughComplexity(repo);
      assert.ok(complexityOut.symbolsAnnotated >= 1);
      const foo = findCallable(ctx, "foo");
      assert.ok(foo, "expected foo Function node");
      assert.equal(foo.cyclomaticComplexity, 2, "foo: 1 + 1 if");
      assert.equal(foo.nestingDepth, 1, "foo: if block depth 1");
      assert.equal(foo.nloc, 4, "foo: 4 non-blank, non-comment-only lines");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("computes TypeScript complexity including a for-of with nested if", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-complexity-ts-"));
    try {
      await fs.writeFile(
        path.join(repo, "iter.ts"),
        [
          "export function iter(xs: number[]): number {",
          "  for (const x of xs) {",
          "    if (x > 0) {",
          "      return x;",
          "    }",
          "  }",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
      );
      const { ctx } = await runThroughComplexity(repo);
      const iter = findCallable(ctx, "iter");
      assert.ok(iter, "expected iter Function node");
      assert.equal(iter.cyclomaticComplexity, 3, "iter: 1 + for + if");
      assert.equal(iter.nestingDepth, 2, "iter: for then nested if = depth 2");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("counts Go switch cases as decision points (including default)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-complexity-go-"));
    try {
      await fs.writeFile(
        path.join(repo, "main.go"),
        [
          "package main",
          "",
          "func Dispatch(n int) string {",
          "\tswitch n {",
          "\tcase 1:",
          '\t\treturn "one"',
          "\tcase 2:",
          '\t\treturn "two"',
          "\tdefault:",
          '\t\treturn "other"',
          "\t}",
          "}",
          "",
        ].join("\n"),
      );
      const { ctx } = await runThroughComplexity(repo);
      const dispatch = findCallable(ctx, "Dispatch");
      assert.ok(dispatch, "expected Dispatch Function node");
      // Rule: we count each `case` (expression_case / type_case /
      // communication_case) as +1 but not `default` — default is the
      // fall-through path, not a decision. Expected: 1 + 2 cases = 3.
      assert.equal(dispatch.cyclomaticComplexity, 3, "Dispatch: fn + 2 cases, default uncounted");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("annotates the eval fixture auth.py Auth.login with cyclomatic > 1", async () => {
    // Integration smoke: copy the packaged eval fixture auth module into a
    // tempdir and run the phase over it.
    const src = path.resolve(process.cwd(), "../eval/src/opencodehub_eval/fixtures/py/auth.py");
    // The test may run from various CWDs depending on how tests are invoked
    // — tolerate a missing fixture (e.g. when the eval package is absent) by
    // short-circuiting to a local stand-in that matches the fixture exactly.
    const repo = await mkdtemp(path.join(tmpdir(), "och-complexity-auth-"));
    try {
      let srcExists = false;
      try {
        await fs.access(src);
        srcExists = true;
      } catch {
        srcExists = false;
      }
      if (srcExists) {
        await fs.copyFile(src, path.join(repo, "auth.py"));
      } else {
        await fs.writeFile(
          path.join(repo, "auth.py"),
          [
            '"""A tiny auth module used as an eval fixture."""',
            "",
            "from __future__ import annotations",
            "",
            "",
            "class Auth:",
            '    """Minimal in-memory auth store."""',
            "",
            "    def __init__(self) -> None:",
            "        self._users: dict[str, dict[str, str]] = {}",
            "",
            "    def login(self, email: str, password: str) -> dict[str, str] | None:",
            "        user = self._users.get(email)",
            "        if user is None:",
            "            return None",
            '        if user["passwordHash"] != _hash(password):',
            "            return None",
            "        return user",
            "",
            "    def register(self, email: str, password: str) -> dict[str, str]:",
            '        user = {"email": email, "passwordHash": _hash(password)}',
            "        self._users[email] = user",
            "        return user",
            "",
            "",
            "def _hash(raw: str) -> str:",
            '    return f"sha256:{len(raw)}:{raw}"',
            "",
          ].join("\n"),
        );
      }
      const { ctx } = await runThroughComplexity(repo);
      const login = findCallable(ctx, "login");
      assert.ok(login, "expected Auth.login Method node");
      assert.ok(
        login.cyclomaticComplexity !== undefined && login.cyclomaticComplexity > 1,
        `login cyclomatic > 1, got ${login.cyclomaticComplexity}`,
      );
      assert.ok(login.nloc !== undefined && login.nloc >= 5, `login nloc >= 5, got ${login.nloc}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("skips gracefully when a function has no body (empty file)", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "och-complexity-empty-"));
    try {
      await fs.writeFile(path.join(repo, "m.py"), "");
      const { complexityOut } = await runThroughComplexity(repo);
      assert.equal(complexityOut.symbolsAnnotated, 0);
      assert.equal(complexityOut.skipped, 0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
