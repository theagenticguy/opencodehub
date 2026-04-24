/**
 * Top-20 framework detection catalog.
 *
 * A typed, declarative table of `FrameworkRule` entries covering the
 * 20 frameworks enumerated in
 * `.erpaval/sessions/2026-04-24-v1-backlog-and-framework-detection/research/frameworks-top20.md`.
 *
 * Each rule is self-describing: category + tier + manifest fingerprint +
 * optional file / regex / variant markers + optional `parent` for wrapping
 * relationships (e.g. Next.js wraps React). The dispatcher in
 * `framework-detector.ts` walks this catalog once and emits a
 * `FrameworkDetection` per hit; variant resolution is delegated to
 * `variant-detectors.ts`.
 *
 * The catalog is the single source of truth the rest of the detector
 * reads from. Adding a framework requires only appending a new entry
 * (and, if variants matter, a matching resolver in `variant-detectors.ts`).
 *
 * Ecosystems are keyed for profile-gating — only catalog entries whose
 * ecosystem's language is present in `ProjectProfile.languages` run.
 */
import type { FrameworkCategory } from "@opencodehub/core-types";

/**
 * Which language ecosystem a framework belongs to. Used to profile-gate the
 * catalog: if the repo has no TS/JS files, every `js` entry is skipped.
 * `any` entries always run (rarely used; reserved for meta tools).
 */
export type FrameworkEcosystem =
  | "js"
  | "python"
  | "ruby"
  | "go"
  | "rust"
  | "java"
  | "php"
  | "csharp"
  | "any";

/** Detection tier per the research packet (D / H / C). */
export type FrameworkTier = "D" | "H" | "C";

/** A manifest-key fingerprint — `{ file, path }` where `path` is dot-delimited into JSON. */
export interface ManifestKey {
  /** Repo-root-relative manifest filename (e.g. `"package.json"`). */
  readonly file: string;
  /**
   * Dot-delimited path into the JSON-parsed manifest. For non-JSON
   * manifests (requirements.txt, Gemfile, pom.xml, go.mod, Cargo.toml)
   * this field is informational; `textMatch` is the real matcher.
   */
  readonly path?: string;
  /**
   * Optional raw-text regex applied to the manifest contents for
   * non-JSON manifests OR JSON manifests where the key shape is awkward
   * (e.g. `<parent><artifactId>…</artifactId></parent>`).
   */
  readonly textMatch?: RegExp;
}

/** A variant discriminator known to `variant-detectors.ts`. */
export interface VariantDefinition {
  /**
   * Stable id consumed by the variant-resolvers table. One of
   * the discriminators listed in `variant-detectors.ts`.
   */
  readonly discriminator: string;
  /** The variant label we report when the discriminator matches. */
  readonly value: string;
}

/** One catalog entry. */
export interface FrameworkRule {
  /** Canonical framework name, lowercased with dashes (e.g. `"nextjs"`, `"react-native"`). */
  readonly name: string;
  /** Taxonomy slot — see `FrameworkCategory` in `@opencodehub/core-types`. */
  readonly category: FrameworkCategory;
  /** Detection tier per the research packet. */
  readonly tier: FrameworkTier;
  /** Ecosystem gate; skip this rule if the ecosystem is not present. */
  readonly ecosystem: FrameworkEcosystem;
  /** Manifest-level fingerprints — any match is sufficient (disjunctive). */
  readonly manifestKeys?: readonly ManifestKey[];
  /** Repo-root-relative files whose exact presence proves the framework. */
  readonly fileMarkers?: readonly string[];
  /** Regex patterns matched against scanned relPaths. */
  readonly fileRegexMarkers?: readonly RegExp[];
  /** Variant axes the detector knows how to resolve (optional). */
  readonly variants?: readonly VariantDefinition[];
  /** Parent framework name when this one wraps another (e.g. `"react"` for `"nextjs"`). */
  readonly parent?: string;
  /**
   * Dot-delimited manifest path used to extract a readable version string
   * when the manifest is JSON. When present, the detector fills the
   * `version` field on the emitted `FrameworkDetection`.
   */
  readonly versionKey?: { readonly file: string; readonly path: string };
}

// ---------------------------------------------------------------------------
// The 20-entry catalog.
// Order below mirrors the numbered list in the research packet; the final
// output is sorted by name so insertion order does not affect determinism.
// ---------------------------------------------------------------------------

export const FRAMEWORK_CATALOG: readonly FrameworkRule[] = [
  // 1. React — UI library. Most variants are driven by what wraps it (CRA,
  // Vite, Next.js) or by its React Native fork.
  {
    name: "react",
    category: "ui",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [{ file: "package.json", path: "dependencies.react" }],
    versionKey: { file: "package.json", path: "dependencies.react" },
    variants: [
      { discriminator: "react-scaffold", value: "cra" },
      { discriminator: "react-scaffold", value: "vite" },
      { discriminator: "react-scaffold", value: "custom" },
    ],
  },

  // 2. Node.js — runtime. Detected via the presence of package.json at the
  // root (scan phase already checks this) paired with a declared engines
  // field, or an .nvmrc / .node-version file.
  {
    name: "nodejs",
    category: "runtime",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [{ file: "package.json", path: "engines.node" }],
    fileMarkers: [".nvmrc", ".node-version"],
    versionKey: { file: "package.json", path: "engines.node" },
  },

  // 3. Next.js — meta-framework wrapping React.
  {
    name: "nextjs",
    category: "meta",
    tier: "D",
    ecosystem: "js",
    parent: "react",
    manifestKeys: [{ file: "package.json", path: "dependencies.next" }],
    versionKey: { file: "package.json", path: "dependencies.next" },
    fileMarkers: ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"],
    variants: [
      { discriminator: "nextjs-router", value: "app-router" },
      { discriminator: "nextjs-router", value: "pages-router" },
      { discriminator: "nextjs-router", value: "hybrid" },
    ],
  },

  // 4. Express — bare-bones backend HTTP.
  {
    name: "express",
    category: "backend_http",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [{ file: "package.json", path: "dependencies.express" }],
    versionKey: { file: "package.json", path: "dependencies.express" },
  },

  // 5. Angular.
  {
    name: "angular",
    category: "ui",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [{ file: "package.json", path: "dependencies.@angular/core" }],
    versionKey: { file: "package.json", path: "dependencies.@angular/core" },
    fileMarkers: ["angular.json"],
  },

  // 6. ASP.NET Core. Detected via any .csproj that includes the Web SDK or
  // an ASP.NET Core PackageReference; the fileRegexMarker picks the former.
  {
    name: "aspnet-core",
    category: "backend_http",
    tier: "D",
    ecosystem: "csharp",
    fileRegexMarkers: [/\.csproj$/i],
    variants: [
      { discriminator: "aspnet-core-style", value: "minimal-apis" },
      { discriminator: "aspnet-core-style", value: "mvc" },
      { discriminator: "aspnet-core-style", value: "razor-pages" },
    ],
  },

  // 7. Vue.js.
  {
    name: "vue",
    category: "ui",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [{ file: "package.json", path: "dependencies.vue" }],
    versionKey: { file: "package.json", path: "dependencies.vue" },
  },

  // 8. Flask — Python web framework.
  {
    name: "flask",
    category: "backend_http",
    tier: "D",
    ecosystem: "python",
    manifestKeys: [
      { file: "pyproject.toml", textMatch: /(^|[\s"'[,])flask(?:[<>=!~\]'"\s]|$)/im },
      { file: "requirements.txt", textMatch: /^\s*flask(?:[<>=!~].*)?(?:\s|$)/im },
    ],
  },

  // 9. Spring Boot — Java / Kotlin.
  {
    name: "spring-boot",
    category: "backend_http",
    tier: "D",
    ecosystem: "java",
    manifestKeys: [
      {
        file: "pom.xml",
        textMatch: /<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>/i,
      },
      {
        file: "build.gradle",
        textMatch: /['"]org\.springframework\.boot['"]/i,
      },
      {
        file: "build.gradle.kts",
        textMatch: /['"]org\.springframework\.boot['"]/i,
      },
    ],
    variants: [
      { discriminator: "spring-boot-style", value: "web-mvc" },
      { discriminator: "spring-boot-style", value: "webflux" },
    ],
  },

  // 10. Django — Python.
  {
    name: "django",
    category: "backend_http",
    tier: "D",
    ecosystem: "python",
    fileMarkers: ["manage.py"],
    manifestKeys: [
      { file: "pyproject.toml", textMatch: /(^|[\s"'[,])django(?:[<>=!~\]'"\s]|$)/im },
      { file: "requirements.txt", textMatch: /^\s*django(?:[<>=!~].*)?(?:\s|$)/im },
    ],
  },

  // 11. WordPress — PHP CMS. Detected by layout.
  {
    name: "wordpress",
    category: "cms",
    tier: "D",
    ecosystem: "php",
    fileMarkers: ["wp-config.php"],
    fileRegexMarkers: [/^wp-content\//, /^wp-admin\//, /^wp-includes\//],
  },

  // 12. FastAPI — Python.
  {
    name: "fastapi",
    category: "backend_http",
    tier: "D",
    ecosystem: "python",
    manifestKeys: [
      { file: "pyproject.toml", textMatch: /(^|[\s"'[,])fastapi(?:[<>=!~\]'"\s]|$)/im },
      { file: "requirements.txt", textMatch: /^\s*fastapi(?:[<>=!~].*)?(?:\s|$)/im },
    ],
    variants: [
      { discriminator: "fastapi-orm", value: "sqlalchemy" },
      { discriminator: "fastapi-orm", value: "sqlmodel" },
      { discriminator: "fastapi-orm", value: "beanie" },
      { discriminator: "fastapi-orm", value: "tortoise" },
    ],
  },

  // 13. Laravel — PHP.
  {
    name: "laravel",
    category: "backend_http",
    tier: "D",
    ecosystem: "php",
    manifestKeys: [{ file: "composer.json", path: "require.laravel/framework" }],
    versionKey: { file: "composer.json", path: "require.laravel/framework" },
    fileMarkers: ["artisan"],
  },

  // 14. Svelte / SvelteKit — UI + meta half. We emit a single tag keyed
  // "svelte" and the variant resolver distinguishes SvelteKit.
  {
    name: "svelte",
    category: "ui",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [{ file: "package.json", path: "dependencies.svelte" }],
    versionKey: { file: "package.json", path: "dependencies.svelte" },
  },

  // 15. NestJS — TS backend on top of Express or Fastify.
  {
    name: "nestjs",
    category: "backend_http",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [{ file: "package.json", path: "dependencies.@nestjs/core" }],
    versionKey: { file: "package.json", path: "dependencies.@nestjs/core" },
    variants: [
      { discriminator: "nestjs-adapter", value: "express" },
      { discriminator: "nestjs-adapter", value: "fastify" },
    ],
  },

  // 16. Ruby on Rails.
  {
    name: "rails",
    category: "backend_http",
    tier: "D",
    ecosystem: "ruby",
    fileMarkers: ["config/routes.rb"],
    manifestKeys: [
      {
        file: "Gemfile",
        textMatch: /^\s*gem\s+['"]rails['"]/im,
      },
    ],
    variants: [
      { discriminator: "rails-style", value: "api-only" },
      { discriminator: "rails-style", value: "standard" },
    ],
  },

  // 17. React Native / Expo — mobile framework.
  {
    name: "react-native",
    category: "mobile_desktop",
    tier: "D",
    ecosystem: "js",
    parent: "react",
    manifestKeys: [{ file: "package.json", path: "dependencies.react-native" }],
    versionKey: { file: "package.json", path: "dependencies.react-native" },
    variants: [
      { discriminator: "react-native-flavor", value: "bare" },
      { discriminator: "react-native-flavor", value: "expo-managed" },
      { discriminator: "react-native-flavor", value: "expo-prebuild" },
    ],
  },

  // 18. Vite — build tool.
  {
    name: "vite",
    category: "build",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [
      { file: "package.json", path: "dependencies.vite" },
      { file: "package.json", path: "devDependencies.vite" },
    ],
    versionKey: { file: "package.json", path: "devDependencies.vite" },
    fileMarkers: ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs"],
  },

  // 19. Electron / Tauri — desktop frameworks. We keep two entries to
  // preserve variant per-framework.
  {
    name: "electron",
    category: "mobile_desktop",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [
      { file: "package.json", path: "dependencies.electron" },
      { file: "package.json", path: "devDependencies.electron" },
    ],
    versionKey: { file: "package.json", path: "devDependencies.electron" },
  },
  {
    name: "tauri",
    category: "mobile_desktop",
    tier: "D",
    ecosystem: "rust",
    fileMarkers: [
      "src-tauri/tauri.conf.json",
      "src-tauri/tauri.conf.json5",
      "src-tauri/Tauri.toml",
    ],
    variants: [
      { discriminator: "tauri-version", value: "v1" },
      { discriminator: "tauri-version", value: "v2" },
    ],
  },

  // 20. Vitest / Jest / Playwright — test runners. Each is its own catalog
  // entry to preserve granularity (they are exclusive peers, not variants).
  {
    name: "jest",
    category: "test",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [
      { file: "package.json", path: "dependencies.jest" },
      { file: "package.json", path: "devDependencies.jest" },
    ],
    versionKey: { file: "package.json", path: "devDependencies.jest" },
    fileMarkers: ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"],
  },
  {
    name: "vitest",
    category: "test",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [
      { file: "package.json", path: "dependencies.vitest" },
      { file: "package.json", path: "devDependencies.vitest" },
    ],
    versionKey: { file: "package.json", path: "devDependencies.vitest" },
    fileMarkers: ["vitest.config.js", "vitest.config.ts", "vitest.config.mjs"],
  },
  {
    name: "playwright",
    category: "test",
    tier: "D",
    ecosystem: "js",
    manifestKeys: [
      { file: "package.json", path: "dependencies.@playwright/test" },
      { file: "package.json", path: "devDependencies.@playwright/test" },
    ],
    versionKey: { file: "package.json", path: "devDependencies.@playwright/test" },
    fileMarkers: ["playwright.config.js", "playwright.config.ts", "playwright.config.mjs"],
  },
];

/**
 * Count the full set of catalog entries (including the three grouped-under-
 * #19 and #20 slots). The research packet labels this "top-20", but each
 * entry here is a distinct emittable framework.
 */
export const FRAMEWORK_CATALOG_SIZE = FRAMEWORK_CATALOG.length;
