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
        "Apache-2.0 code intelligence graph + MCP server for AI coding agents. 29 tools, 15 GA languages, LadybugDB-default, WASM-default parsing, deterministic, offline-capable.",
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
            "OpenCodeHub indexes a repository into a hybrid structural + semantic knowledge graph and exposes it over the Model Context Protocol (MCP) to AI coding agents. The MCP server registers 29 tools across five families — exploration (list_repos, query, context, impact, detect_changes, rename, sql), group / federation (group_list, group_query, group_status, group_contracts, group_cross_repo_links, group_sync), scan / findings / verdict (scan, list_findings, list_findings_delta, list_dead_code, remove_dead_code, license_audit, verdict, risk_trends), HTTP / routing (route_map, api_impact, shape_check, tool_map), and meta (project_profile, dependencies, owners, pack_codebase). The CLI binary is `codehub`. Runtime: Node 22 or 24, pnpm 10, LadybugDB graph store + DuckDB temporal sibling by default (legacy single-file DuckDB layout opt-in via CODEHUB_STORE=duck), web-tree-sitter (WASM) parse runtime by default with native opt-in via OCH_NATIVE_PARSER=1, 15 GA languages, SCIP indexers for TypeScript / TSX / JavaScript / Python / Go / Rust / Java / C# / C / C++ / Kotlin / Ruby. 20-scanner inventory. Apache-2.0 end to end. Repos are first-class graph nodes (`repo_uri`); the cross-repo `group_*` family fans out over named groups; AMBIGUOUS_REPO error envelope returns `choices[]` so a caller can retry deterministically.",
          promote: [
            "start-here/**",
            "agents/**",
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
                "User-facing pages only: install, quick-start, editor integration guides, group + migration guides.",
            },
            {
              label: "agents",
              paths: ["agents/**", "mcp/**"],
              description:
                "Agent-side reference: per-editor MCP setup, the 29-tool catalog, tool decision matrix, idiomatic prompts.",
            },
            {
              label: "mcp",
              paths: ["mcp/**", "reference/**"],
              description:
                "MCP surface: server tools, resources, CLI reference, error codes, language matrix, .docmeta.json schema.",
            },
            {
              label: "contributing",
              paths: ["contributing/**", "architecture/**"],
              description:
                "Developer and architecture docs: dev loop, release flow, ADRs, determinism, supply-chain, storage backend, cross-repo federation.",
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
          label: "Start here",
          autogenerate: { directory: "start-here" },
        },
        {
          label: "Agents",
          autogenerate: { directory: "agents" },
        },
        {
          label: "MCP",
          autogenerate: { directory: "mcp" },
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
        {
          label: "Guides",
          autogenerate: { directory: "guides" },
        },
        {
          label: "Architecture",
          autogenerate: { directory: "architecture" },
        },
        {
          label: "Skills",
          autogenerate: { directory: "skills" },
        },
        {
          label: "Contributing",
          autogenerate: { directory: "contributing" },
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
