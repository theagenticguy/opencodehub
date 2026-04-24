# Rust corpus

Golden corpus for the gym's rust-analyzer oracle. Cases are auto-labeled by
Opus-grade source reading against the pinned fixture at
`packages/gym/corpus/repos/rust/thiserror` (tag `2.0.17`, commit
`72ae716e6d6a7f7fdabdc394018c745b4d39ca45`). The fixture is a vendored
submodule and is treated as read-only; all expected sites are drawn from the
hand-written `src/` and `impl/src/` trees.

## Proc-macro-disabled tradeoff

`RustAnalyzerClient` (see `packages/lsp-oracle/src/rust-analyzer-client.ts`)
boots rust-analyzer with `procMacro.enable = false` by default. Under that
config, the output of `#[derive(Error)]` — which is thiserror's entire
public-facing value proposition — is **not visible** to static reference,
implementation, or caller resolution. Any case that counted derive-expansion
sites as expected would be permanently unachievable for the oracle and would
poison the regression baseline.

This corpus therefore deliberately targets the library's hand-written
internals and excludes derive-expansion cases:

- **References / implementations** are anchored on the facade crate's
  sealed helper traits (`AsDynError`, `AsDisplay`, per-module `Sealed`,
  `Var`) and on the proc-macro crate's own internal types
  (`ast::Input`, `expand::call_site_ident`). These resolve through plain
  `pub use` re-exports and explicit `impl … for …` blocks that
  rust-analyzer can see without expanding a single proc macro.
- **Callers** are chosen from intra-crate call chains inside
  `impl/src/` (`fallback::expand`, `call_site_ident`,
  `type_parameter_of_option`, `attr::get`). These are ordinary Rust
  function calls resolved by rust-analyzer's HIR, independent of macro
  expansion.
- **Cfg-gated code is filtered per default features.** The facade crate
  defaults to `std`, so the `placeholder` submodule in `src/display.rs`
  (`#[cfg(not(feature = "std"))]`) is excluded from expected sets. The
  `error_generic_member_access` cfg is off on stable rustc, so
  `src/provide.rs` (`ThiserrorProvide`) is omitted entirely from this
  corpus.

Flipping `procMacro.enable = true` would unlock an additional class of
cases (derive-expanded `impl Error for UserError`, etc.); those belong in
a separate, explicitly macro-expanded corpus rather than mixed into this
baseline, because proc-macro expansion introduces nondeterministic span
output that we would want to freeze under its own replay manifest.
