import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://theagenticguy.github.io",
  base: "/opencodehub",
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
