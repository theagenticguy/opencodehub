import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightPageActions from "starlight-page-actions";
import rehypeMermaid from "rehype-mermaid";

// https://astro.build/config
export default defineConfig({
  site: "https://theagenticguy.github.io",
  base: "/opencodehub",
  // Mermaid: render ```mermaid ``` fences to inline SVG at build time.
  // excludeLangs is critical — without it, Shiki grabs the mermaid fence
  // first and rehype-mermaid never sees it.
  markdown: {
    syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
    rehypePlugins: [[rehypeMermaid, { strategy: "img-svg", dark: true }]],
  },
  integrations: [
    starlight({
      title: "OpenCodeHub",
      description:
        "Apache-2.0 code intelligence graph + MCP server for AI coding agents.",
      logo: {
        src: "./src/assets/logo.svg",
        replacesTitle: false,
      },
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/theagenticguy/opencodehub",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/theagenticguy/opencodehub/edit/main/packages/docs/",
      },
      lastUpdated: true,
      credits: true,
      plugins: [
        // 1) LLM-crawlable bundles. Emits /llms.txt, /llms-full.txt,
        //    /llms-small.txt at build time. Must run first so page-actions
        //    sees it already registered.
        starlightLlmsTxt({
          projectName: "OpenCodeHub",
          description:
            "Apache-2.0 code intelligence graph + MCP server for AI coding agents. Gives agents callers, callees, processes, and blast radius in one MCP tool call — local, offline-capable, deterministic.",
          details:
            "OpenCodeHub indexes a repository into a hybrid structural + semantic knowledge graph and exposes it over the Model Context Protocol (MCP) to AI coding agents. The MCP server registers 28 tools spanning search, change-impact, findings, and cross-repo groups. The CLI binary is `codehub`. Runtime: Node 22, pnpm 10, DuckDB + hnsw_acorn storage, 15 tree-sitter languages, SCIP indexers for TypeScript / Python / Go / Rust / Java.",
          promote: [
            "start-here/**",
            "guides/**",
            "mcp/**",
          ],
          demote: [
            "architecture/**",
            "contributing/**",
          ],
          // Keep llms-small.txt tight by dropping internals-y prose.
          exclude: [],
          minify: {
            note: true,
            tip: true,
            details: true,
            whitespace: true,
            caution: false,
            danger: false,
          },
          customSets: [
            {
              label: "user-guide",
              paths: ["start-here/**", "guides/**"],
              description:
                "User-facing pages only: install, quick-start, editor integration guides.",
            },
            {
              label: "mcp",
              paths: ["mcp/**", "reference/**"],
              description:
                "MCP surface: server tools, resources, prompts, CLI reference, error codes, language matrix.",
            },
            {
              label: "contributing",
              paths: ["contributing/**", "architecture/**"],
              description:
                "Developer and architecture docs: dev loop, release flow, ADRs, determinism, supply-chain.",
            },
          ],
        }),

        // 2) Per-page "Copy as Markdown" + "Open in ChatGPT" + "Open in
        //    Claude" + Share. IMPORTANT: do NOT set `baseUrl`, or this
        //    plugin will try to own /llms.txt too and collide with
        //    starlight-llms-txt. Leave llms generation to plugin #1.
        starlightPageActions({
          actions: {
            markdown: true,
            chatgpt: true,
            claude: true,
            t3chat: false,
            v0: false,
          },
          share: true,
        }),

        // 3) Build-time broken-link check. Runs after content is built
        //    but before deploy, so llms-full.txt never ships dead links.
        starlightLinksValidator({
          errorOnFallbackPages: false,
          errorOnInconsistentLocale: false,
        }),
      ],
      sidebar: [
        {
          label: "Start Here",
          autogenerate: { directory: "start-here" },
        },
        {
          label: "User Guide",
          autogenerate: { directory: "guides" },
        },
        {
          label: "MCP Server",
          autogenerate: { directory: "mcp" },
        },
        {
          label: "Skills",
          autogenerate: { directory: "skills" },
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
        {
          label: "Contributing",
          autogenerate: { directory: "contributing" },
        },
        {
          label: "Architecture",
          autogenerate: { directory: "architecture" },
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
