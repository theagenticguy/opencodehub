/**
 * Framework variant resolvers.
 *
 * Each catalog entry may list one or more variant axes (`VariantDefinition`)
 * with a `discriminator` id. This module maps those discriminator ids to a
 * pure resolver function that consumes readable inputs (repo relPaths, the
 * in-memory manifest cache, optional text snippets) and returns the variant
 * label, or `null` if no variant is determinable.
 *
 * Resolvers are pure and deterministic — they never touch disk outside the
 * input snapshot, so callers can unit-test them without a filesystem.
 *
 * Resolution happens after manifest-level detection has confirmed the
 * framework. The resolver may return `null`, in which case the emitted
 * `FrameworkDetection.variant` is omitted.
 */

/** Inputs available to every variant resolver. */
export interface VariantResolveInput {
  /** All repo relPaths (posix), already lower-cased in a companion set for case-insensitive look-ups. */
  readonly relPaths: ReadonlySet<string>;
  /**
   * Map of manifest filename → parsed JSON value, or `null` when the
   * manifest was not parseable. Non-JSON manifests (Gemfile, pom.xml,
   * build.gradle, Cargo.toml, requirements.txt) are stored as raw text
   * in `manifestText`.
   */
  readonly manifestJson: ReadonlyMap<string, unknown>;
  /** Raw text of each manifest, indexed by filename. */
  readonly manifestText: ReadonlyMap<string, string>;
}

/** Resolver signature. */
export type VariantResolver = (input: VariantResolveInput) => string | null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true if any relPath matches the predicate. Used by resolvers that
 * care about directory existence (e.g. "app/" under a Next.js project).
 */
function hasPathStartingWith(relPaths: ReadonlySet<string>, prefix: string): boolean {
  for (const p of relPaths) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

/** Check whether a dep (or devDep or peerDep) is declared in a parsed package.json. */
function hasJsDep(pkg: unknown, depName: string): boolean {
  if (typeof pkg !== "object" || pkg === null) return false;
  const rec = pkg as Record<string, unknown>;
  for (const bucket of ["dependencies", "devDependencies", "peerDependencies"]) {
    const map = rec[bucket];
    if (typeof map === "object" && map !== null && !Array.isArray(map)) {
      if (Object.hasOwn(map as Record<string, unknown>, depName)) return true;
    }
  }
  return false;
}

/** Whether any relPath ends with any of the given suffixes. */
function hasPathEndingWith(relPaths: ReadonlySet<string>, suffixes: readonly string[]): boolean {
  for (const p of relPaths) {
    for (const sfx of suffixes) {
      if (p.endsWith(sfx)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-framework resolvers
// ---------------------------------------------------------------------------

/**
 * React scaffold variant: Create React App, Vite, or custom.
 * Priority: `react-scripts` dep → cra; `vite` dep → vite; else → custom.
 * Next.js / React Native / Remix / Gatsby are handled as their own
 * top-level detections (with React as `parent`) so we never report them
 * under the React scaffold variant.
 */
export function resolveReactScaffold(input: VariantResolveInput): string | null {
  const pkg = input.manifestJson.get("package.json");
  if (hasJsDep(pkg, "react-scripts")) return "cra";
  if (hasJsDep(pkg, "vite")) return "vite";
  return "custom";
}

/**
 * Next.js router variant: app-router, pages-router, or hybrid.
 * Reads the scanned file list for `app/` and `pages/` top-level dirs.
 * When both are present we report `hybrid` (the Next build picks App
 * Router; downstream consumers can decide how to treat it).
 */
export function resolveNextjsRouter(input: VariantResolveInput): string | null {
  const hasApp =
    hasPathStartingWith(input.relPaths, "app/") ||
    hasPathStartingWith(input.relPaths, "src/app/");
  const hasPages =
    hasPathStartingWith(input.relPaths, "pages/") ||
    hasPathStartingWith(input.relPaths, "src/pages/");
  if (hasApp && hasPages) return "hybrid";
  if (hasApp) return "app-router";
  if (hasPages) return "pages-router";
  return null;
}

/**
 * NestJS adapter: Express (default) or Fastify.
 * Detected via the presence of `@nestjs/platform-fastify` in package.json.
 */
export function resolveNestjsAdapter(input: VariantResolveInput): string | null {
  const pkg = input.manifestJson.get("package.json");
  if (hasJsDep(pkg, "@nestjs/platform-fastify")) return "fastify";
  if (hasJsDep(pkg, "@nestjs/platform-express")) return "express";
  // Default adapter when unspecified is Express, so return it as the
  // default rather than null — callers want a defined variant.
  return "express";
}

/**
 * FastAPI data-layer / ORM variant.
 * Priority: SQLModel → SQLModel; Beanie → Beanie; Tortoise → Tortoise;
 * SQLAlchemy → SQLAlchemy. Returns null when no data-layer dep is seen
 * (the FastAPI project may be model-less).
 */
export function resolveFastapiOrm(input: VariantResolveInput): string | null {
  const py =
    (input.manifestText.get("pyproject.toml") ?? "") +
    "\n" +
    (input.manifestText.get("requirements.txt") ?? "");
  // Match whole-name dep tokens — avoid matching "sqlalchemy" inside "sqlmodel"
  // by requiring a word boundary on both sides.
  if (/(^|[\s"'[,])sqlmodel([\s"'\]<>=!~,]|$)/im.test(py)) return "sqlmodel";
  if (/(^|[\s"'[,])beanie([\s"'\]<>=!~,]|$)/im.test(py)) return "beanie";
  if (/(^|[\s"'[,])tortoise-orm([\s"'\]<>=!~,]|$)/im.test(py)) return "tortoise";
  if (/(^|[\s"'[,])sqlalchemy([\s"'\]<>=!~,]|$)/im.test(py)) return "sqlalchemy";
  return null;
}

/**
 * Spring Boot style: WebFlux (reactive) vs Web MVC (servlet).
 * Detected via `spring-boot-starter-webflux` vs `spring-boot-starter-web`
 * in pom.xml / build.gradle / build.gradle.kts.
 */
export function resolveSpringBootStyle(input: VariantResolveInput): string | null {
  const combined =
    (input.manifestText.get("pom.xml") ?? "") +
    "\n" +
    (input.manifestText.get("build.gradle") ?? "") +
    "\n" +
    (input.manifestText.get("build.gradle.kts") ?? "");
  if (/spring-boot-starter-webflux/i.test(combined)) return "webflux";
  if (/spring-boot-starter-web\b/i.test(combined)) return "web-mvc";
  return null;
}

/**
 * Tauri major version. v1 ships `tauri.conf.json` (with `tauri.allowlist`),
 * v2 drops `allowlist` for a `capabilities/` directory alongside
 * `tauri.conf.json`. We use the directory presence (plus a text match on
 * `allowlist` keeping v1) as the discriminator.
 */
export function resolveTauriVersion(input: VariantResolveInput): string | null {
  const hasCapabilities = hasPathStartingWith(input.relPaths, "src-tauri/capabilities/");
  if (hasCapabilities) return "v2";
  const conf =
    input.manifestText.get("src-tauri/tauri.conf.json") ??
    input.manifestText.get("src-tauri/tauri.conf.json5") ??
    input.manifestText.get("src-tauri/Tauri.toml") ??
    "";
  if (/\ballowlist\b/.test(conf)) return "v1";
  // Fallback: v1-era configs without allowlist literal are rare but we
  // prefer returning null over a misleading label.
  return null;
}

/**
 * React Native flavor.
 * - bare: `ios/` and `android/` native folders present, no `expo` dep.
 * - expo-managed: `expo` dep, no `ios/` / `android/`.
 * - expo-prebuild: `expo` dep AND native folders.
 */
export function resolveReactNativeFlavor(input: VariantResolveInput): string | null {
  const hasIos = hasPathStartingWith(input.relPaths, "ios/");
  const hasAndroid = hasPathStartingWith(input.relPaths, "android/");
  const hasNative = hasIos && hasAndroid;
  const pkg = input.manifestJson.get("package.json");
  const hasExpo = hasJsDep(pkg, "expo");
  if (hasExpo && hasNative) return "expo-prebuild";
  if (hasExpo) return "expo-managed";
  if (hasNative) return "bare";
  return null;
}

/**
 * Rails style: API-only vs standard.
 * An API-only Rails app declares `config.api_only = true` in
 * `config/application.rb`. Absence of `app/views/` is a secondary signal
 * but is redundant once we read application.rb.
 */
export function resolveRailsStyle(input: VariantResolveInput): string | null {
  const app = input.manifestText.get("config/application.rb") ?? "";
  if (/config\.api_only\s*=\s*true/.test(app)) return "api-only";
  // Fallback heuristic: API-only Rails rarely has app/views or app/helpers.
  const hasViews = hasPathStartingWith(input.relPaths, "app/views/");
  if (app.length > 0 && !hasViews) return "api-only";
  return "standard";
}

/**
 * ASP.NET Core style: minimal APIs, MVC, or Razor Pages.
 * Prefers the presence of `Program.cs` with `WebApplication.CreateBuilder`
 * (minimal-apis), else Pages/ (razor-pages), else Controllers/ (mvc).
 */
export function resolveAspnetCoreStyle(input: VariantResolveInput): string | null {
  const program = input.manifestText.get("Program.cs") ?? "";
  if (/WebApplication\.CreateBuilder/.test(program)) return "minimal-apis";
  const hasPages = hasPathEndingWith(input.relPaths, [".cshtml"]);
  if (hasPages) return "razor-pages";
  const hasControllers = hasPathStartingWith(input.relPaths, "Controllers/");
  if (hasControllers) return "mvc";
  return null;
}

// ---------------------------------------------------------------------------
// Registry mapping discriminator id → resolver.
// Catalog entries reference discriminators; this is the only binding.
// ---------------------------------------------------------------------------

export const VARIANT_RESOLVERS: ReadonlyMap<string, VariantResolver> = new Map([
  ["react-scaffold", resolveReactScaffold],
  ["nextjs-router", resolveNextjsRouter],
  ["nestjs-adapter", resolveNestjsAdapter],
  ["fastapi-orm", resolveFastapiOrm],
  ["spring-boot-style", resolveSpringBootStyle],
  ["tauri-version", resolveTauriVersion],
  ["react-native-flavor", resolveReactNativeFlavor],
  ["rails-style", resolveRailsStyle],
  ["aspnet-core-style", resolveAspnetCoreStyle],
]);
