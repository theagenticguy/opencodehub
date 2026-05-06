/**
 * Stage 3 — config-AST inspectors.
 *
 * Regex-pragmatic matchers for 4 framework config files. No tree-sitter,
 * no AST library — the matchers only need to recognize top-level option
 * shapes, which line-based scans handle reliably. Each inspector returns
 * a `ConfigAstFinding` describing what it observed; the dispatcher maps
 * findings into framework evidence.
 *
 * Files handled:
 *   - `next.config.{js,mjs,ts,cjs}` — App Router vs Pages Router
 *   - `astro.config.mjs` / `.ts` / `.js` — integrations declared
 *   - `vite.config.*` — plugins declared
 *   - `spring.factories` (META-INF) — Spring Boot auto-configurations
 *
 * Pure — caller supplies file contents; no I/O, no network, no subprocess.
 */

/** What a single config-AST inspector discovered. */
export interface ConfigAstFinding {
  /** Framework this finding implicates (`nextjs`, `astro`, `vite`, `spring-boot`). */
  readonly framework: string;
  /** Source filename that produced this finding (e.g. `next.config.ts`). */
  readonly source: string;
  /** Human-readable discovery (e.g. `nextjs router: app`). */
  readonly detail: string;
  /** Optional variant label the dispatcher can pass through to the detection. */
  readonly variant?: string;
}

const NEXT_CONFIG_NAMES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
];

const ASTRO_CONFIG_NAMES = ["astro.config.mjs", "astro.config.ts", "astro.config.js"];

const VITE_CONFIG_NAMES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
];

const SPRING_FACTORIES_PATH = "META-INF/spring.factories";

/**
 * Inspect every known config file present in `fileText` and return the
 * consolidated finding list. `fileText` is a map from relPath to raw
 * contents — typically pre-read by the caller from the repo root.
 *
 * Also reads `relPaths` for the Next.js App vs Pages Router discriminator
 * (the presence of `app/` or `pages/` dominates even without the config
 * option).
 */
export function inspectConfigAst(
  fileText: ReadonlyMap<string, string>,
  relPaths: ReadonlySet<string>,
): readonly ConfigAstFinding[] {
  const out: ConfigAstFinding[] = [];
  for (const name of NEXT_CONFIG_NAMES) {
    const text = fileText.get(name);
    if (text !== undefined) {
      out.push(...inspectNextConfig(name, text, relPaths));
    }
  }
  for (const name of ASTRO_CONFIG_NAMES) {
    const text = fileText.get(name);
    if (text !== undefined) {
      out.push(...inspectAstroConfig(name, text));
    }
  }
  for (const name of VITE_CONFIG_NAMES) {
    const text = fileText.get(name);
    if (text !== undefined) {
      out.push(...inspectViteConfig(name, text));
    }
  }
  const springText = fileText.get(SPRING_FACTORIES_PATH);
  if (springText !== undefined) {
    out.push(...inspectSpringFactories(springText));
  }
  return out;
}

/** Filenames stage-3 reads. Export so callers can pre-filter their reads. */
export const CONFIG_AST_FILES: readonly string[] = [
  ...NEXT_CONFIG_NAMES,
  ...ASTRO_CONFIG_NAMES,
  ...VITE_CONFIG_NAMES,
  SPRING_FACTORIES_PATH,
];

// ---------------------------------------------------------------------------
// next.config.*
// ---------------------------------------------------------------------------

function inspectNextConfig(
  name: string,
  text: string,
  relPaths: ReadonlySet<string>,
): readonly ConfigAstFinding[] {
  const out: ConfigAstFinding[] = [];
  // Presence alone is a finding — the dispatcher already has a fileMarker
  // for these but stage 3 produces structured evidence.
  out.push({ framework: "nextjs", source: name, detail: "next.config present" });
  // Router variant. Presence of `app/` or `src/app/` → app-router.
  // `pages/` or `src/pages/` → pages-router. `experimental.appDir: true`
  // is a legacy signal (Next 12-13) that still implies app-router.
  const hasAppDir = hasPathPrefix(relPaths, "app/") || hasPathPrefix(relPaths, "src/app/");
  const hasPagesDir = hasPathPrefix(relPaths, "pages/") || hasPathPrefix(relPaths, "src/pages/");
  const experimentalAppDir = /experimental\s*:\s*\{[^}]*appDir\s*:\s*true/.test(text);
  if (hasAppDir && hasPagesDir) {
    out.push({
      framework: "nextjs",
      source: name,
      detail: "nextjs router: hybrid (app + pages)",
      variant: "hybrid",
    });
  } else if (hasAppDir || experimentalAppDir) {
    out.push({
      framework: "nextjs",
      source: name,
      detail: "nextjs router: app-router",
      variant: "app-router",
    });
  } else if (hasPagesDir) {
    out.push({
      framework: "nextjs",
      source: name,
      detail: "nextjs router: pages-router",
      variant: "pages-router",
    });
  }
  return out;
}

function hasPathPrefix(relPaths: ReadonlySet<string>, prefix: string): boolean {
  for (const p of relPaths) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// astro.config.*
// ---------------------------------------------------------------------------

function inspectAstroConfig(name: string, text: string): readonly ConfigAstFinding[] {
  const out: ConfigAstFinding[] = [
    { framework: "astro", source: name, detail: "astro.config present" },
  ];
  // Regex-pragmatic match on `integrations: [ ... ]`. The array body may
  // span multiple lines; we capture until the matching `]`. Integrations
  // are reported as the function-call names (`react()`, `tailwind()`).
  const arrMatch = /integrations\s*:\s*\[([\s\S]*?)\]/m.exec(text);
  if (arrMatch !== null) {
    const body = arrMatch[1] ?? "";
    const integrations = [...body.matchAll(/([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1] ?? "");
    const dedupe = [...new Set(integrations.filter((s) => s.length > 0))].sort();
    for (const integration of dedupe) {
      out.push({
        framework: "astro",
        source: name,
        detail: `astro integration: ${integration}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// vite.config.*
// ---------------------------------------------------------------------------

function inspectViteConfig(name: string, text: string): readonly ConfigAstFinding[] {
  const out: ConfigAstFinding[] = [
    { framework: "vite", source: name, detail: "vite.config present" },
  ];
  const arrMatch = /plugins\s*:\s*\[([\s\S]*?)\]/m.exec(text);
  if (arrMatch !== null) {
    const body = arrMatch[1] ?? "";
    const plugins = [...body.matchAll(/([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1] ?? "");
    const dedupe = [...new Set(plugins.filter((s) => s.length > 0))].sort();
    for (const plugin of dedupe) {
      out.push({
        framework: "vite",
        source: name,
        detail: `vite plugin: ${plugin}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// META-INF/spring.factories
// ---------------------------------------------------------------------------

function inspectSpringFactories(text: string): readonly ConfigAstFinding[] {
  const out: ConfigAstFinding[] = [
    {
      framework: "spring-boot",
      source: SPRING_FACTORIES_PATH,
      detail: "spring.factories present",
    },
  ];
  // The file is a key=value manifest. Values may wrap over multiple lines
  // with trailing `\`. We scan for interesting keys.
  const interesting = [
    "org.springframework.boot.autoconfigure.EnableAutoConfiguration",
    "org.springframework.context.ApplicationContextInitializer",
    "org.springframework.context.ApplicationListener",
  ];
  for (const key of interesting) {
    if (text.includes(key)) {
      out.push({
        framework: "spring-boot",
        source: SPRING_FACTORIES_PATH,
        detail: `spring.factories key: ${key}`,
      });
    }
  }
  return out;
}
