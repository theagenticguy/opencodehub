/**
 * Tests for the structured framework-detection dispatcher.
 *
 * Covers:
 *   1. Positive fixture per framework in the top-20 catalog
 *      (one detection each — 23 entries across the 20 numbered rows).
 *   2. Variant-axis resolution for 8+ frameworks with multi-variant
 *      discriminators.
 *   3. False-positive corpus — three minimal repos with zero expected
 *      detections (plain Node library, plain Python CLI, static HTML site).
 *   4. Determinism — two runs on the same input produce byte-identical
 *      structured output, same insertion-order across runs.
 *
 * The detector works on an in-memory snapshot of relPaths + manifest text,
 * so no filesystem is needed — every fixture below is a literal object.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { FrameworkDetection } from "@opencodehub/core-types";
import { detectFrameworksStructured, type FrameworkDetectorInput } from "./framework-detector.js";
import { FRAMEWORK_CATALOG } from "./frameworks-catalog.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkInput(
  files: readonly string[],
  manifests: ReadonlyArray<readonly [string, string]>,
  detectedLanguages: readonly string[],
): FrameworkDetectorInput {
  return {
    relPaths: new Set(files),
    manifestText: new Map(manifests),
    detectedLanguages,
  };
}

function names(out: readonly FrameworkDetection[]): readonly string[] {
  return out.map((d) => d.name);
}

function findByName(
  out: readonly FrameworkDetection[],
  name: string,
): FrameworkDetection | undefined {
  return out.find((d) => d.name === name);
}

// ---------------------------------------------------------------------------
// Catalog coverage sanity
// ---------------------------------------------------------------------------

describe("FRAMEWORK_CATALOG", () => {
  it("covers all 20 numbered frameworks from the research packet", () => {
    const expected = [
      "react",
      "nodejs",
      "nextjs",
      "express",
      "angular",
      "aspnet-core",
      "vue",
      "flask",
      "spring-boot",
      "django",
      "wordpress",
      "fastapi",
      "laravel",
      "svelte",
      "nestjs",
      "rails",
      "react-native",
      "vite",
      "electron",
      "tauri",
      "jest",
      "vitest",
      "playwright",
    ];
    const got = FRAMEWORK_CATALOG.map((r) => r.name).sort();
    const want = [...expected].sort();
    assert.deepEqual(got, want);
  });

  it("every variant discriminator binds to a known resolver", async () => {
    const { VARIANT_RESOLVERS } = await import("./variant-detectors.js");
    for (const rule of FRAMEWORK_CATALOG) {
      if (!rule.variants) continue;
      const discriminator = rule.variants[0]?.discriminator;
      assert.ok(discriminator, `rule ${rule.name} has variants but no discriminator`);
      assert.ok(
        VARIANT_RESOLVERS.has(discriminator),
        `discriminator ${discriminator} on ${rule.name} has no resolver`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Per-framework positive fixtures (20 numbered rows, 23 distinct emitters).
// ---------------------------------------------------------------------------

describe("framework detection — positive fixtures per catalog entry", () => {
  it("1. React via dependencies.react", () => {
    const input = mkInput(
      ["package.json"],
      [["package.json", JSON.stringify({ dependencies: { react: "18.3.0" } })]],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    const react = findByName(out, "react");
    assert.ok(react, "react not detected");
    assert.equal(react.category, "ui");
    assert.equal(react.version, "18.3.0");
    assert.equal(react.confidence, "deterministic");
  });

  it("2. Node.js via engines.node", () => {
    const input = mkInput(
      ["package.json"],
      [["package.json", JSON.stringify({ engines: { node: ">=20" } })]],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "nodejs"));
  });

  it("3. Next.js via dependencies.next + config", () => {
    const input = mkInput(
      ["package.json", "next.config.js", "app/page.tsx"],
      [["package.json", JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } })]],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    const next = findByName(out, "nextjs");
    assert.ok(next, "nextjs not detected");
    assert.equal(next.category, "meta");
    assert.equal(next.parentName, "react");
    assert.equal(next.variant, "app-router");
  });

  it("4. Express via dependencies.express", () => {
    const input = mkInput(
      ["package.json"],
      [["package.json", JSON.stringify({ dependencies: { express: "4.18.0" } })]],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "express"));
  });

  it("5. Angular via @angular/core", () => {
    const input = mkInput(
      ["package.json", "angular.json"],
      [["package.json", JSON.stringify({ dependencies: { "@angular/core": "17.0.0" } })]],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "angular"));
  });

  it("6. ASP.NET Core via .csproj presence", () => {
    const input = mkInput(["WebApi.csproj", "Program.cs"], [], ["csharp"]);
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "aspnet-core"));
  });

  it("7. Vue via dependencies.vue", () => {
    const input = mkInput(
      ["package.json"],
      [["package.json", JSON.stringify({ dependencies: { vue: "3.4.0" } })]],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "vue"));
  });

  it("8. Flask via pyproject.toml dep", () => {
    const input = mkInput(
      ["pyproject.toml"],
      [["pyproject.toml", '[project]\ndependencies = ["flask>=2.0"]\n']],
      ["python"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "flask"));
  });

  it("9. Spring Boot via pom.xml parent", () => {
    const input = mkInput(
      ["pom.xml"],
      [
        [
          "pom.xml",
          `<?xml version="1.0"?><project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>`,
        ],
      ],
      ["java"],
    );
    const out = detectFrameworksStructured(input);
    const sb = findByName(out, "spring-boot");
    assert.ok(sb);
    assert.equal(sb.variant, "web-mvc");
  });

  it("10. Django via manage.py + pyproject dep", () => {
    const input = mkInput(
      ["manage.py", "pyproject.toml"],
      [["pyproject.toml", '[project]\ndependencies = ["django>=4.0"]\n']],
      ["python"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "django"));
  });

  it("11. WordPress via wp-config.php", () => {
    const input = mkInput(
      ["wp-config.php", "wp-content/themes/foo/style.css", "wp-admin/index.php"],
      [],
      ["php"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "wordpress"));
  });

  it("12. FastAPI via pyproject dep", () => {
    const input = mkInput(
      ["pyproject.toml"],
      [["pyproject.toml", '[project]\ndependencies = ["fastapi>=0.100"]\n']],
      ["python"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "fastapi"));
  });

  it("13. Laravel via composer.json require", () => {
    const input = mkInput(
      ["composer.json", "artisan"],
      [["composer.json", JSON.stringify({ require: { "laravel/framework": "^10.0" } })]],
      ["php"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "laravel"));
  });

  it("14. Svelte via dependencies.svelte", () => {
    const input = mkInput(
      ["package.json"],
      [["package.json", JSON.stringify({ dependencies: { svelte: "4.0.0" } })]],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "svelte"));
  });

  it("15. NestJS via @nestjs/core", () => {
    const input = mkInput(
      ["package.json"],
      [
        [
          "package.json",
          JSON.stringify({
            dependencies: { "@nestjs/core": "10.0.0", "@nestjs/platform-express": "10.0.0" },
          }),
        ],
      ],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    const nest = findByName(out, "nestjs");
    assert.ok(nest);
    assert.equal(nest.variant, "express");
  });

  it("16. Rails via Gemfile + config/routes.rb", () => {
    const input = mkInput(
      ["Gemfile", "config/routes.rb", "app/views/layouts/application.html.erb"],
      [["Gemfile", 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n']],
      ["ruby"],
    );
    const out = detectFrameworksStructured(input);
    const rails = findByName(out, "rails");
    assert.ok(rails);
    assert.equal(rails.variant, "standard");
  });

  it("17. React Native via dependencies.react-native", () => {
    const input = mkInput(
      ["package.json"],
      [
        [
          "package.json",
          JSON.stringify({ dependencies: { "react-native": "0.73.0", react: "18.0.0" } }),
        ],
      ],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    const rn = findByName(out, "react-native");
    assert.ok(rn);
    assert.equal(rn.parentName, "react");
  });

  it("18. Vite via devDependencies.vite", () => {
    const input = mkInput(
      ["package.json", "vite.config.ts"],
      [["package.json", JSON.stringify({ devDependencies: { vite: "5.0.0" } })]],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "vite"));
  });

  it("19a. Electron via dependencies.electron", () => {
    const input = mkInput(
      ["package.json"],
      [["package.json", JSON.stringify({ devDependencies: { electron: "28.0.0" } })]],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "electron"));
  });

  it("19b. Tauri via src-tauri/tauri.conf.json", () => {
    const input = mkInput(
      ["src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/capabilities/main.json"],
      [["src-tauri/tauri.conf.json", "{}"]],
      ["rust"],
    );
    const out = detectFrameworksStructured(input);
    const tauri = findByName(out, "tauri");
    assert.ok(tauri);
    assert.equal(tauri.variant, "v2");
  });

  it("20a. Jest via devDependencies.jest", () => {
    const input = mkInput(
      ["package.json", "jest.config.js"],
      [["package.json", JSON.stringify({ devDependencies: { jest: "29.0.0" } })]],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "jest"));
  });

  it("20b. Vitest via devDependencies.vitest", () => {
    const input = mkInput(
      ["package.json", "vitest.config.ts"],
      [["package.json", JSON.stringify({ devDependencies: { vitest: "1.6.0" } })]],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "vitest"));
  });

  it("20c. Playwright via @playwright/test", () => {
    const input = mkInput(
      ["package.json", "playwright.config.ts"],
      [["package.json", JSON.stringify({ devDependencies: { "@playwright/test": "1.40.0" } })]],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    assert.ok(findByName(out, "playwright"));
  });
});

// ---------------------------------------------------------------------------
// Variant-axis tests (8+ frameworks × multiple variants each)
// ---------------------------------------------------------------------------

describe("framework detection — variant axes", () => {
  it("Next.js pages-router when only pages/ exists", () => {
    const input = mkInput(
      ["package.json", "pages/_app.tsx", "pages/index.tsx"],
      [["package.json", JSON.stringify({ dependencies: { next: "12.0.0" } })]],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    const next = findByName(out, "nextjs");
    assert.equal(next?.variant, "pages-router");
  });

  it("Next.js hybrid when both app/ and pages/ exist", () => {
    const input = mkInput(
      ["package.json", "app/page.tsx", "pages/legacy.tsx"],
      [["package.json", JSON.stringify({ dependencies: { next: "13.5.0" } })]],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "nextjs")?.variant, "hybrid");
  });

  it("React scaffold — CRA via react-scripts", () => {
    const input = mkInput(
      ["package.json"],
      [
        [
          "package.json",
          JSON.stringify({ dependencies: { react: "18.0.0", "react-scripts": "5.0.0" } }),
        ],
      ],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "react")?.variant, "cra");
  });

  it("React scaffold — Vite via vite dep", () => {
    const input = mkInput(
      ["package.json"],
      [
        [
          "package.json",
          JSON.stringify({ dependencies: { react: "18.0.0" }, devDependencies: { vite: "5.0.0" } }),
        ],
      ],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "react")?.variant, "vite");
  });

  it("NestJS — Fastify adapter", () => {
    const input = mkInput(
      ["package.json"],
      [
        [
          "package.json",
          JSON.stringify({
            dependencies: {
              "@nestjs/core": "10.0.0",
              "@nestjs/platform-fastify": "10.0.0",
            },
          }),
        ],
      ],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "nestjs")?.variant, "fastify");
  });

  it("FastAPI — SQLModel ORM", () => {
    const input = mkInput(
      ["pyproject.toml"],
      [["pyproject.toml", '[project]\ndependencies = ["fastapi>=0.100", "sqlmodel>=0.0.14"]\n']],
      ["python"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "fastapi")?.variant, "sqlmodel");
  });

  it("FastAPI — Beanie ORM", () => {
    const input = mkInput(
      ["pyproject.toml"],
      [["pyproject.toml", '[project]\ndependencies = ["fastapi>=0.100", "beanie>=1.25"]\n']],
      ["python"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "fastapi")?.variant, "beanie");
  });

  it("Spring Boot — WebFlux variant", () => {
    const input = mkInput(
      ["pom.xml"],
      [
        [
          "pom.xml",
          `<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><dependencies><dependency><artifactId>spring-boot-starter-webflux</artifactId></dependency></dependencies></project>`,
        ],
      ],
      ["java"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "spring-boot")?.variant, "webflux");
  });

  it("Tauri v1 via allowlist in conf", () => {
    const input = mkInput(
      ["src-tauri/tauri.conf.json"],
      [["src-tauri/tauri.conf.json", JSON.stringify({ tauri: { allowlist: { all: false } } })]],
      ["rust"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "tauri")?.variant, "v1");
  });

  it("Tauri v2 via capabilities/ dir", () => {
    const input = mkInput(
      ["src-tauri/tauri.conf.json", "src-tauri/capabilities/main.json"],
      [["src-tauri/tauri.conf.json", "{}"]],
      ["rust"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "tauri")?.variant, "v2");
  });

  it("React Native — expo-managed", () => {
    const input = mkInput(
      ["package.json", "app.json"],
      [
        [
          "package.json",
          JSON.stringify({
            dependencies: { "react-native": "0.73.0", expo: "~50.0.0", react: "18.0.0" },
          }),
        ],
      ],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "react-native")?.variant, "expo-managed");
  });

  it("React Native — bare (native folders, no expo)", () => {
    const input = mkInput(
      ["package.json", "ios/Podfile", "android/build.gradle"],
      [
        [
          "package.json",
          JSON.stringify({ dependencies: { "react-native": "0.73.0", react: "18.0.0" } }),
        ],
      ],
      ["javascript"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "react-native")?.variant, "bare");
  });

  it("Rails — api-only variant (config.api_only = true)", () => {
    const input = mkInput(
      ["Gemfile", "config/routes.rb", "config/application.rb"],
      [
        ["Gemfile", 'gem "rails"\n'],
        [
          "config/application.rb",
          "module X\n  class Application < Rails::Application\n    config.api_only = true\n  end\nend\n",
        ],
      ],
      ["ruby"],
    );
    const out = detectFrameworksStructured(input);
    assert.equal(findByName(out, "rails")?.variant, "api-only");
  });
});

// ---------------------------------------------------------------------------
// False-positive corpus — 3 repos that should produce zero framework hits.
// ---------------------------------------------------------------------------

describe("framework detection — false-positive corpus", () => {
  it("plain Node library (package.json with no framework deps) emits no frameworks", () => {
    const input = mkInput(
      ["package.json", "src/lib.ts", "README.md"],
      [
        [
          "package.json",
          JSON.stringify({
            name: "just-a-lib",
            version: "1.0.0",
            dependencies: { lodash: "4.17.0" },
          }),
        ],
      ],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    assert.deepEqual(names(out), [], `unexpected frameworks: ${names(out).join(", ")}`);
  });

  it("plain Python CLI (pyproject with click only) emits no frameworks", () => {
    const input = mkInput(
      ["pyproject.toml", "src/my_cli/__init__.py"],
      [["pyproject.toml", '[project]\nname = "my-cli"\ndependencies = ["click>=8.0"]\n']],
      ["python"],
    );
    const out = detectFrameworksStructured(input);
    assert.deepEqual(names(out), [], `unexpected frameworks: ${names(out).join(", ")}`);
  });

  it("static HTML site (no manifests at all) emits no frameworks", () => {
    const input = mkInput(["index.html", "style.css", "script.js"], [], []);
    const out = detectFrameworksStructured(input);
    assert.deepEqual(names(out), []);
  });
});

// ---------------------------------------------------------------------------
// Profile-gating
// ---------------------------------------------------------------------------

describe("framework detection — profile gating", () => {
  it("skips Python detectors when python not in languages", () => {
    const input = mkInput(
      ["pyproject.toml"],
      [["pyproject.toml", '[project]\ndependencies = ["fastapi>=0.100"]\n']],
      ["javascript"], // python NOT present
    );
    const out = detectFrameworksStructured(input);
    assert.ok(!findByName(out, "fastapi"), "fastapi should be gated out");
  });

  it("skips JS detectors when JS/TS not in languages", () => {
    const input = mkInput(
      ["package.json"],
      [["package.json", JSON.stringify({ dependencies: { react: "18.0.0" } })]],
      ["python"], // JS NOT present
    );
    const out = detectFrameworksStructured(input);
    assert.ok(!findByName(out, "react"));
  });
});

// ---------------------------------------------------------------------------
// Mutual exclusion / parent linkage (FRM-UN-001)
// ---------------------------------------------------------------------------

describe("framework detection — parent linkage (FRM-UN-001)", () => {
  it("Next.js carries parent=react when both are present", () => {
    const input = mkInput(
      ["package.json", "app/page.tsx"],
      [["package.json", JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } })]],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    const react = findByName(out, "react");
    const next = findByName(out, "nextjs");
    assert.ok(react);
    assert.ok(next);
    assert.equal(next.parentName, "react");
  });
});

// ---------------------------------------------------------------------------
// Determinism (graphHash contract)
// ---------------------------------------------------------------------------

describe("framework detection — determinism", () => {
  it("two runs on identical input produce byte-identical JSON", () => {
    const input = mkInput(
      ["package.json", "next.config.js", "app/page.tsx", "vitest.config.ts"],
      [
        [
          "package.json",
          JSON.stringify({
            dependencies: { next: "14.0.0", react: "18.0.0" },
            devDependencies: { vitest: "1.6.0" },
          }),
        ],
      ],
      ["typescript"],
    );
    const a = detectFrameworksStructured(input);
    const b = detectFrameworksStructured(input);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("output is sorted alphabetically by name", () => {
    const input = mkInput(
      ["package.json", "next.config.js"],
      [
        [
          "package.json",
          JSON.stringify({
            dependencies: { next: "14.0.0", react: "18.0.0", vue: "3.0.0", express: "4.0.0" },
          }),
        ],
      ],
      ["typescript"],
    );
    const out = detectFrameworksStructured(input);
    const sorted = [...names(out)].sort();
    assert.deepEqual(names(out), sorted);
  });
});

// ---------------------------------------------------------------------------
// Malformed manifest guardrail (FRM-UN-002)
// ---------------------------------------------------------------------------

describe("framework detection — malformed manifest", () => {
  it("malformed package.json does not abort and produces no false positives", () => {
    const input = mkInput(
      ["package.json"],
      [["package.json", "{ this is not JSON at all"]],
      ["javascript"],
    );
    assert.doesNotThrow(() => detectFrameworksStructured(input));
    const out = detectFrameworksStructured(input);
    assert.deepEqual(names(out), []);
  });
});
