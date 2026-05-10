#!/usr/bin/env node
// Postbuild: inject LLM-navigation helpers into every per-page .md emitted
// by starlight-page-actions, mirroring the pattern from
// https://code.claude.com/docs/en/agent-sdk/python.md:
//
//   1. Index banner at the top of every page pointing at /llms.txt
//   2. "See also" footer with 3-5 curated related-page links
//
// Runs after `astro build` against packages/docs/dist/**/*.md.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..", "dist");
const BASE = "/opencodehub";
const SITE = "https://theagenticguy.github.io";

const INDEX_BANNER = `> ## Documentation Index
> Fetch the complete documentation index at: ${SITE}${BASE}/llms.txt
> Use this file to discover all available pages before exploring further.
> Scoped bundles: [user-guide](${SITE}${BASE}/_llms-txt/user-guide.txt) · [mcp](${SITE}${BASE}/_llms-txt/mcp.txt) · [contributing](${SITE}${BASE}/_llms-txt/contributing.txt)

`;

// Per-page "See also" — curated by section.
// Keys are the doc slug (path from dist/ without .md extension, leading slash).
const RELATED = {
  "/index": [
    ["Quick start", `${BASE}/start-here/quick-start/`],
    ["What is OpenCodeHub?", `${BASE}/start-here/what-is-opencodehub/`],
    ["MCP tools", `${BASE}/mcp/tools/`],
    ["CLI reference", `${BASE}/reference/cli/`],
  ],

  // Start here
  "/start-here/what-is-opencodehub": [
    ["Install", `${BASE}/start-here/install/`],
    ["Quick start", `${BASE}/start-here/quick-start/`],
    ["MCP overview", `${BASE}/mcp/overview/`],
  ],
  "/start-here/install": [
    ["Quick start", `${BASE}/start-here/quick-start/`],
    ["First query", `${BASE}/start-here/first-query/`],
    ["Troubleshooting", `${BASE}/guides/troubleshooting/`],
  ],
  "/start-here/quick-start": [
    ["First query", `${BASE}/start-here/first-query/`],
    ["Indexing a repo", `${BASE}/guides/indexing-a-repo/`],
    ["Using with Claude Code", `${BASE}/guides/using-with-claude-code/`],
    ["MCP tools", `${BASE}/mcp/tools/`],
  ],
  "/start-here/first-query": [
    ["CLI reference", `${BASE}/reference/cli/`],
    ["MCP tools", `${BASE}/mcp/tools/`],
    ["Indexing a repo", `${BASE}/guides/indexing-a-repo/`],
  ],

  // Guides
  "/guides/indexing-a-repo": [
    ["CLI reference — analyze", `${BASE}/reference/cli/`],
    ["Troubleshooting", `${BASE}/guides/troubleshooting/`],
    ["Language matrix", `${BASE}/reference/languages/`],
  ],
  "/guides/using-with-claude-code": [
    ["Using with Cursor", `${BASE}/guides/using-with-cursor/`],
    ["Using with Codex", `${BASE}/guides/using-with-codex/`],
    ["MCP overview", `${BASE}/mcp/overview/`],
    ["MCP tools", `${BASE}/mcp/tools/`],
  ],
  "/guides/using-with-cursor": [
    ["Using with Claude Code", `${BASE}/guides/using-with-claude-code/`],
    ["Using with Codex", `${BASE}/guides/using-with-codex/`],
    ["MCP overview", `${BASE}/mcp/overview/`],
  ],
  "/guides/using-with-codex": [
    ["Using with Claude Code", `${BASE}/guides/using-with-claude-code/`],
    ["Using with Cursor", `${BASE}/guides/using-with-cursor/`],
    ["MCP overview", `${BASE}/mcp/overview/`],
  ],
  "/guides/using-with-windsurf": [
    ["Using with Claude Code", `${BASE}/guides/using-with-claude-code/`],
    ["Using with Cursor", `${BASE}/guides/using-with-cursor/`],
    ["MCP overview", `${BASE}/mcp/overview/`],
  ],
  "/guides/using-with-opencode": [
    ["Using with Claude Code", `${BASE}/guides/using-with-claude-code/`],
    ["Using with Cursor", `${BASE}/guides/using-with-cursor/`],
    ["MCP overview", `${BASE}/mcp/overview/`],
  ],
  "/guides/cross-repo-groups": [
    ["MCP tools — group_*", `${BASE}/mcp/tools/`],
    ["CLI reference — group", `${BASE}/reference/cli/`],
    ["Indexing a repo", `${BASE}/guides/indexing-a-repo/`],
  ],
  "/guides/ci-integration": [
    ["CLI reference — verdict / detect-changes", `${BASE}/reference/cli/`],
    ["MCP tools — verdict", `${BASE}/mcp/tools/`],
    ["Error codes", `${BASE}/reference/error-codes/`],
  ],
  "/guides/troubleshooting": [
    ["CLI reference — doctor", `${BASE}/reference/cli/`],
    ["Error codes", `${BASE}/reference/error-codes/`],
    ["Install", `${BASE}/start-here/install/`],
  ],

  // Reference
  "/reference/cli": [
    ["MCP tools", `${BASE}/mcp/tools/`],
    ["Configuration", `${BASE}/reference/configuration/`],
    ["Error codes", `${BASE}/reference/error-codes/`],
  ],
  "/reference/configuration": [
    ["CLI reference", `${BASE}/reference/cli/`],
    ["Using with Claude Code", `${BASE}/guides/using-with-claude-code/`],
    ["Troubleshooting", `${BASE}/guides/troubleshooting/`],
  ],
  "/reference/error-codes": [
    ["CLI reference", `${BASE}/reference/cli/`],
    ["MCP overview", `${BASE}/mcp/overview/`],
    ["Troubleshooting", `${BASE}/guides/troubleshooting/`],
  ],
  "/reference/languages": [
    ["Adding a language provider", `${BASE}/contributing/adding-a-language-provider/`],
    ["Indexing a repo", `${BASE}/guides/indexing-a-repo/`],
    ["Architecture overview", `${BASE}/architecture/overview/`],
  ],

  // MCP
  "/mcp/overview": [
    ["MCP tools", `${BASE}/mcp/tools/`],
    ["Resources", `${BASE}/mcp/resources/`],
    ["Prompts", `${BASE}/mcp/prompts/`],
    ["Using with Claude Code", `${BASE}/guides/using-with-claude-code/`],
  ],
  "/mcp/tools": [
    ["MCP overview", `${BASE}/mcp/overview/`],
    ["Resources", `${BASE}/mcp/resources/`],
    ["Prompts", `${BASE}/mcp/prompts/`],
    ["CLI reference", `${BASE}/reference/cli/`],
  ],
  "/mcp/resources": [
    ["MCP overview", `${BASE}/mcp/overview/`],
    ["MCP tools", `${BASE}/mcp/tools/`],
    ["Prompts", `${BASE}/mcp/prompts/`],
  ],
  "/mcp/prompts": [
    ["MCP overview", `${BASE}/mcp/overview/`],
    ["MCP tools", `${BASE}/mcp/tools/`],
    ["Resources", `${BASE}/mcp/resources/`],
  ],

  // Contributing
  "/contributing/overview": [
    ["Dev loop", `${BASE}/contributing/dev-loop/`],
    ["Commit conventions", `${BASE}/contributing/commit-conventions/`],
    ["IP hygiene", `${BASE}/contributing/ip-hygiene/`],
    ["Adding a language provider", `${BASE}/contributing/adding-a-language-provider/`],
  ],
  "/contributing/dev-loop": [
    ["Commit conventions", `${BASE}/contributing/commit-conventions/`],
    ["Testing", `${BASE}/contributing/testing/`],
    ["Release process", `${BASE}/contributing/release-process/`],
  ],
  "/contributing/commit-conventions": [
    ["Release process", `${BASE}/contributing/release-process/`],
    ["Dev loop", `${BASE}/contributing/dev-loop/`],
    ["Contributing overview", `${BASE}/contributing/overview/`],
  ],
  "/contributing/release-process": [
    ["Commit conventions", `${BASE}/contributing/commit-conventions/`],
    ["Contributing overview", `${BASE}/contributing/overview/`],
    ["Supply chain", `${BASE}/architecture/supply-chain/`],
  ],
  "/contributing/ip-hygiene": [
    ["Supply chain", `${BASE}/architecture/supply-chain/`],
    ["Contributing overview", `${BASE}/contributing/overview/`],
    ["Dev loop", `${BASE}/contributing/dev-loop/`],
  ],
  "/contributing/adding-a-language-provider": [
    ["Language matrix", `${BASE}/reference/languages/`],
    ["Architecture overview", `${BASE}/architecture/overview/`],
    ["Testing", `${BASE}/contributing/testing/`],
  ],
  "/contributing/testing": [
    ["Dev loop", `${BASE}/contributing/dev-loop/`],
    ["Architecture overview", `${BASE}/architecture/overview/`],
    ["Determinism", `${BASE}/architecture/determinism/`],
  ],

  // Architecture
  "/architecture/overview": [
    ["Monorepo map", `${BASE}/architecture/monorepo-map/`],
    ["ADRs", `${BASE}/architecture/adrs/`],
    ["Determinism", `${BASE}/architecture/determinism/`],
    ["Supply chain", `${BASE}/architecture/supply-chain/`],
  ],
  "/architecture/monorepo-map": [
    ["Architecture overview", `${BASE}/architecture/overview/`],
    ["Adding a language provider", `${BASE}/contributing/adding-a-language-provider/`],
    ["Dev loop", `${BASE}/contributing/dev-loop/`],
  ],
  "/architecture/adrs": [
    ["Architecture overview", `${BASE}/architecture/overview/`],
    ["Determinism", `${BASE}/architecture/determinism/`],
    ["Supply chain", `${BASE}/architecture/supply-chain/`],
  ],
  "/architecture/determinism": [
    ["Architecture overview", `${BASE}/architecture/overview/`],
    ["Testing", `${BASE}/contributing/testing/`],
    ["ADRs", `${BASE}/architecture/adrs/`],
  ],
  "/architecture/supply-chain": [
    ["IP hygiene", `${BASE}/contributing/ip-hygiene/`],
    ["Architecture overview", `${BASE}/architecture/overview/`],
    ["Release process", `${BASE}/contributing/release-process/`],
  ],
};

function slugForFile(mdPath) {
  const rel = path.relative(DIST, mdPath).replace(/\\/g, "/");
  return "/" + rel.replace(/\.md$/, "");
}

function seeAlso(slug) {
  const links = RELATED[slug];
  if (!links) return "";
  const lines = links.map(([label, href]) => `* [${label}](${href})`).join("\n");
  return `\n\n## See also\n\n${lines}\n`;
}

async function walk(dir) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

async function main() {
  let patched = 0;
  let skipped = 0;
  const files = await walk(DIST);
  for (const file of files) {
    // Skip llms.txt-family (they're already the index).
    if (file.endsWith("/llms.txt")) continue;
    if (file.includes("/_llms-txt/")) continue;

    const original = await fs.readFile(file, "utf8");

    // Idempotency guard — don't double-inject.
    if (original.startsWith("> ## Documentation Index")) {
      skipped += 1;
      continue;
    }

    const slug = slugForFile(file);
    const body = INDEX_BANNER + original + seeAlso(slug);
    await fs.writeFile(file, body, "utf8");
    patched += 1;
  }

  console.warn(
    `[inject-llm-nav] patched ${patched} .md files, skipped ${skipped} already-patched`,
  );
}

main().catch((err) => {
  console.error("[inject-llm-nav] failed:", err);
  process.exitCode = 1;
});
