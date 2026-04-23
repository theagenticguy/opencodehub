import { cProvider } from "./c.js";
import { cppProvider } from "./cpp.js";
import { csharpProvider } from "./csharp.js";
import { dartProvider } from "./dart.js";
import { goProvider } from "./go.js";
import { javaProvider } from "./java.js";
import { javascriptProvider } from "./javascript.js";
import { kotlinProvider } from "./kotlin.js";
import { phpProvider } from "./php.js";
import { pythonProvider } from "./python.js";
import { rubyProvider } from "./ruby.js";
import { rustProvider } from "./rust.js";
import { swiftProvider } from "./swift.js";
import { tsxProvider } from "./tsx.js";
import type { LanguageId, LanguageProvider } from "./types.js";
import { typescriptProvider } from "./typescript.js";

/**
 * Compile-time exhaustive provider table. `satisfies` forces every
 * `LanguageId` to map to a `LanguageProvider` — adding a language to the
 * union without registering it here becomes a type error.
 */
const providers = {
  typescript: typescriptProvider,
  tsx: tsxProvider,
  javascript: javascriptProvider,
  python: pythonProvider,
  go: goProvider,
  rust: rustProvider,
  java: javaProvider,
  csharp: csharpProvider,
  c: cProvider,
  cpp: cppProvider,
  ruby: rubyProvider,
  kotlin: kotlinProvider,
  swift: swiftProvider,
  php: phpProvider,
  dart: dartProvider,
} satisfies Record<LanguageId, LanguageProvider>;

export function getProvider(lang: LanguageId): LanguageProvider {
  return providers[lang];
}

export function listProviders(): readonly LanguageProvider[] {
  return Object.values(providers);
}
