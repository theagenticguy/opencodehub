/**
 * SQLite runtime guard — import this BEFORE any `node:sqlite` import.
 *
 * On Node ≥24.15 the built-in `node:sqlite` module is enabled by default,
 * but loading it emits a one-shot `ExperimentalWarning` to stderr. For the
 * `codehub` CLI that is cosmetic noise; for the **stdio MCP server** stderr
 * is a real channel a client may surface, so an unsolicited warning is a
 * correctness wart. This module makes the dependency on `node:sqlite`
 * explicit and silences *only* that one warning, leaving every other
 * process warning intact.
 *
 * Why an in-process filter rather than a `--node-flag` / shebang: it works
 * no matter how the process was launched — the published CLI bin, the MCP
 * server spawned by an arbitrary agent host, `node --test`, or a downstream
 * library embedding `@opencodehub/storage`. There is no single launch site
 * we control, so the guard travels with the code that needs it.
 *
 * The override is installed exactly once (idempotent) and delegates every
 * non-SQLite warning to the original `process.emitWarning`.
 */

const FLAG = Symbol.for("opencodehub.sqlite-runtime.installed");

interface Guarded {
  [FLAG]?: true;
}

function isSqliteExperimentalWarning(warning: string | Error, type?: string): boolean {
  const text = typeof warning === "string" ? warning : warning.message;
  // Node's text is: "SQLite is an experimental feature and might change at any time".
  // Match on the SQLite mention scoped to the ExperimentalWarning type so we
  // never swallow an unrelated experimental warning.
  const isExperimental = type === "ExperimentalWarning" || /experimental/i.test(text);
  return isExperimental && /sqlite/i.test(text);
}

export function installSqliteRuntimeGuard(): void {
  const proc = process as unknown as Guarded;
  if (proc[FLAG]) return;
  proc[FLAG] = true;

  const original = process.emitWarning.bind(process);
  // Node overloads emitWarning(warning, type?, code?, ctor?) and
  // emitWarning(warning, options?). We sniff the SQLite warning across both.
  function patched(
    warning: string | Error,
    typeOrOptions?: string | { type?: string },
    ...rest: unknown[]
  ): void {
    const type =
      typeof typeOrOptions === "string"
        ? typeOrOptions
        : typeOrOptions?.type;
    if (isSqliteExperimentalWarning(warning, type)) return;
    // Delegate everything else untouched.
    (original as (...a: unknown[]) => void)(warning, typeOrOptions, ...rest);
  }
  process.emitWarning = patched as typeof process.emitWarning;
}

// Side effect on import: installing the guard is the whole point of importing
// this module, so callers write `import "./sqlite-runtime.js";` ahead of the
// `node:sqlite` import and get the behavior with no call site.
installSqliteRuntimeGuard();
