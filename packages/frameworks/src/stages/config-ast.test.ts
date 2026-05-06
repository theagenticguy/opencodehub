/**
 * Tests for stage 3 — config-AST inspectors.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { inspectConfigAst } from "./config-ast.js";

function mk(
  files: ReadonlyArray<readonly [string, string]>,
  relPaths: readonly string[],
): {
  fileText: Map<string, string>;
  relSet: Set<string>;
} {
  return { fileText: new Map(files), relSet: new Set(relPaths) };
}

describe("config-ast — next.config.*", () => {
  it("detects app-router from app/ directory", () => {
    const { fileText, relSet } = mk(
      [["next.config.mjs", "export default { reactStrictMode: true }"]],
      ["app/layout.tsx", "app/page.tsx"],
    );
    const out = inspectConfigAst(fileText, relSet);
    const variants = out.filter((f) => f.variant !== undefined).map((f) => f.variant);
    assert.deepEqual(variants, ["app-router"]);
  });

  it("detects pages-router from pages/ directory", () => {
    const { fileText, relSet } = mk(
      [["next.config.js", "module.exports = {}"]],
      ["pages/index.tsx", "pages/_app.tsx"],
    );
    const out = inspectConfigAst(fileText, relSet);
    assert.equal(out.find((f) => f.variant !== undefined)?.variant, "pages-router");
  });

  it("detects hybrid when both app/ and pages/ exist", () => {
    const { fileText, relSet } = mk(
      [["next.config.ts", "export default {}"]],
      ["app/page.tsx", "pages/api/hello.ts"],
    );
    const out = inspectConfigAst(fileText, relSet);
    assert.equal(out.find((f) => f.variant !== undefined)?.variant, "hybrid");
  });

  it("detects app-router via legacy experimental.appDir option", () => {
    const { fileText, relSet } = mk(
      [
        [
          "next.config.mjs",
          "export default { experimental: { appDir: true, serverActions: true } };",
        ],
      ],
      [],
    );
    const out = inspectConfigAst(fileText, relSet);
    assert.equal(out.find((f) => f.variant !== undefined)?.variant, "app-router");
  });
});

describe("config-ast — astro.config.mjs", () => {
  it("lists integration names from integrations: [...]", () => {
    const text = [
      "import { defineConfig } from 'astro/config';",
      "import react from '@astrojs/react';",
      "import tailwind from '@astrojs/tailwind';",
      "export default defineConfig({",
      "  integrations: [react(), tailwind(), mdx()],",
      "});",
    ].join("\n");
    const { fileText, relSet } = mk([["astro.config.mjs", text]], []);
    const out = inspectConfigAst(fileText, relSet);
    const details = out
      .filter((f) => f.detail.startsWith("astro integration:"))
      .map((f) => f.detail);
    assert.deepEqual(details.sort(), [
      "astro integration: mdx",
      "astro integration: react",
      "astro integration: tailwind",
    ]);
  });

  it("records astro.config presence even when integrations list is empty", () => {
    const { fileText, relSet } = mk(
      [["astro.config.mjs", "export default { output: 'static' };"]],
      [],
    );
    const out = inspectConfigAst(fileText, relSet);
    assert.ok(out.some((f) => f.detail === "astro.config present"));
  });
});

describe("config-ast — vite.config.*", () => {
  it("lists plugin names from plugins: [...]", () => {
    const text = [
      "import { defineConfig } from 'vite';",
      "import react from '@vitejs/plugin-react';",
      "export default defineConfig({",
      "  plugins: [react(), tsconfigPaths()],",
      "});",
    ].join("\n");
    const { fileText, relSet } = mk([["vite.config.ts", text]], []);
    const out = inspectConfigAst(fileText, relSet);
    const details = out.filter((f) => f.detail.startsWith("vite plugin:")).map((f) => f.detail);
    assert.deepEqual(details.sort(), ["vite plugin: react", "vite plugin: tsconfigPaths"]);
  });
});

describe("config-ast — META-INF/spring.factories", () => {
  it("flags EnableAutoConfiguration key", () => {
    const text = [
      "org.springframework.boot.autoconfigure.EnableAutoConfiguration=\\",
      "com.example.MyAutoConfig",
    ].join("\n");
    const { fileText, relSet } = mk([["META-INF/spring.factories", text]], []);
    const out = inspectConfigAst(fileText, relSet);
    assert.ok(
      out.some((f) =>
        f.detail.startsWith(
          "spring.factories key: org.springframework.boot.autoconfigure.EnableAutoConfiguration",
        ),
      ),
    );
  });

  it("records spring.factories presence even with unknown keys", () => {
    const { fileText, relSet } = mk(
      [["META-INF/spring.factories", "some.other.key=com.example.Foo"]],
      [],
    );
    const out = inspectConfigAst(fileText, relSet);
    assert.ok(out.some((f) => f.detail === "spring.factories present"));
  });
});

describe("config-ast — absent files", () => {
  it("returns [] when no known config files are present", () => {
    const { fileText, relSet } = mk([["README.md", "# foo"]], []);
    const out = inspectConfigAst(fileText, relSet);
    assert.deepEqual(out, []);
  });
});
