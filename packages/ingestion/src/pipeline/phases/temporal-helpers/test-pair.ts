/**
 * Per-language test-pair heuristics.
 *
 * Given a source file relative path, return candidate test-file relative
 * paths whose touches should be cross-referenced for the `testRatio` signal.
 * Also provides a cheap `isTestFile` predicate so source files that are
 * themselves test files short-circuit the candidate lookup with ratio=1.
 *
 * All paths are POSIX-separated and relative to repo root.
 */

/** Heuristic check: is `relPath` a test file? */
export function isTestFile(relPath: string): boolean {
  const base = baseName(relPath);
  const dir = dirName(relPath);
  // Any segment named `tests`, `test`, or `__tests__` under the path root.
  const segs = relPath.split("/");
  for (const s of segs) {
    if (s === "tests" || s === "test" || s === "__tests__") return true;
  }
  // Python convention.
  if (/^test_.+\.py$/.test(base)) return true;
  if (/^.+_test\.py$/.test(base)) return true;
  // Go convention.
  if (/^.+_test\.go$/.test(base)) return true;
  // TS/JS/Rust conventions.
  if (/^.+\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(base)) return true;
  // Java: *Test.java.
  if (/^.+Test\.java$/.test(base)) return true;
  // C#: *Tests.cs or *.Tests.cs
  if (/^.+Tests\.cs$/.test(base)) return true;
  if (/^.+\.Tests\.cs$/.test(base)) return true;
  // Keep dir in mind for Rust suffix heuristic — Rust inline tests are
  // indistinguishable from production, so we mark only explicit `tests/` dirs.
  if (dir.endsWith("/tests") || dir === "tests") return true;
  return false;
}

/**
 * Return the set of candidate test-file relative paths paired with the given
 * source file. Unknown languages yield an empty array.
 */
export function pairedTestCandidates(relPath: string): readonly string[] {
  if (isTestFile(relPath)) return [];
  const base = baseName(relPath);
  const dir = dirName(relPath);
  const ext = extOf(base);
  const stem = base.slice(0, base.length - ext.length - 1); // strip ".ext"
  if (stem.length === 0) return [];
  const out = new Set<string>();
  const prefix = dir === "" ? "" : `${dir}/`;

  const addWithStem = (ts: string, newExt: string) => {
    out.add(`${prefix}${ts}.${newExt}`);
  };

  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      addWithStem(`${stem}.test`, ext);
      addWithStem(`${stem}.spec`, ext);
      break;
    case "py":
      // Same-directory variants.
      out.add(`${prefix}test_${stem}.py`);
      out.add(`${prefix}${stem}_test.py`);
      // tests/ sibling.
      out.add(`tests/test_${stem}.py`);
      break;
    case "go":
      out.add(`${prefix}${stem}_test.go`);
      break;
    case "rs":
      // Inline `#[cfg(test)]` is unreliable to detect from git metadata; look
      // for a sibling `tests/<stem>.rs` under a `tests/` directory at repo
      // root.
      out.add(`tests/${stem}.rs`);
      break;
    case "java":
      out.add(`${prefix}${capitalize(stem)}Test.java`);
      break;
    case "cs":
      out.add(`${prefix}${capitalize(stem)}Tests.cs`);
      out.add(`${prefix}${capitalize(stem)}.Tests.cs`);
      break;
    default:
      break;
  }

  return [...out].sort();
}

function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}

function dirName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? "" : p.slice(0, idx);
}

function extOf(base: string): string {
  const idx = base.lastIndexOf(".");
  return idx < 0 ? "" : base.slice(idx + 1);
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
