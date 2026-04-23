/**
 * Language detection from file path + optional first line (shebang).
 *
 * Extension-first, with shebang as a secondary hint for scripts that lack an
 * informative extension. Returns `undefined` when the file is not one of the
 * seven MVP languages — callers skip those files rather than throwing.
 */

import type { LanguageId } from "./types.js";

const EXTENSION_MAP: ReadonlyMap<string, LanguageId> = new Map([
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".cs", "csharp"],
  // --- Extended-language additions (C, C++, Ruby, Kotlin, Swift, PHP, Dart) ---
  [".c", "c"],
  // .h is ambiguous between C and C++ headers. We default to C here; a
  // dedicated C++ header detector (scanning the file for `class`, `template`,
  // `namespace`, etc.) can upgrade the classification in a later pass.
  [".h", "c"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],
  [".rb", "ruby"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".swift", "swift"],
  [".php", "php"],
  [".php3", "php"],
  [".php4", "php"],
  [".php5", "php"],
  [".php7", "php"],
  [".phtml", "php"],
  [".dart", "dart"],
]);

/**
 * Best-effort shebang parsing for the rare case where extension is missing.
 * Only covers interpreters we care about at MVP.
 */
function detectFromShebang(firstLine: string): LanguageId | undefined {
  if (!firstLine.startsWith("#!")) {
    return undefined;
  }
  const lowered = firstLine.toLowerCase();
  if (lowered.includes("python")) {
    return "python";
  }
  if (lowered.includes("node")) {
    return "javascript";
  }
  // Rust's `cargo script` style shebang
  if (lowered.includes("rust-script") || lowered.includes("cargo")) {
    return "rust";
  }
  return undefined;
}

function lastExtension(filePath: string): string {
  // We intentionally take the LAST dot, not the first, so `.d.ts` resolves to
  // `.ts` (a TypeScript declaration file) rather than the middle `d` part.
  const slashIdx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const baseName = slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath;
  const dotIdx = baseName.lastIndexOf(".");
  if (dotIdx <= 0) {
    // Dotfile without extension (e.g. ".gitignore") or no extension at all.
    return "";
  }
  return baseName.slice(dotIdx).toLowerCase();
}

/**
 * Return the language ID for a given file path, or `undefined` if unknown.
 *
 * @param filePath - Path to the file, either absolute or relative.
 * @param firstLineOrNull - Optional first line of the file (without trailing
 *   newline); used as a shebang fallback when the extension is missing.
 */
export function detectLanguage(filePath: string, firstLineOrNull?: string): LanguageId | undefined {
  const ext = lastExtension(filePath);
  const byExt = EXTENSION_MAP.get(ext);
  if (byExt !== undefined) {
    return byExt;
  }
  if (firstLineOrNull !== undefined && firstLineOrNull.length > 0) {
    return detectFromShebang(firstLineOrNull);
  }
  return undefined;
}
