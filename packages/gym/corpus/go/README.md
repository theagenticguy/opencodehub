# go corpus

Golden goldens for the `gopls` differential SCIP indexer. The single corpus here
targets `spf13/cobra` v1.9.1 (commit
`40b5bc1437a564fc795d388b23835e84f54cd1d1`), vendored as a read-only submodule
under `packages/gym/corpus/repos/go/cobra`. All 13 cases in `cobra.yaml` were
labeled by reading the cobra source directly — no live scip-go runs were used to
produce the expected sets, so the file is a pure source-of-truth that a running
gopls must agree with. Distribution: 2 `implementations`, 5 `references`, 6
`callers`. One `implementations` case (`SliceValue`) is waived because the only
implementors live in `github.com/spf13/pflag` outside the fixture; once pflag is
pinned into the corpus or we decide how to encode external-dependency impls, the
waiver can be lifted. Cobra v1.9.1 is surprisingly interface-poor for its size
— `PositionalArgs` is a function type and `SliceValue` is the only real
`interface` — so the `implementations` slice is smaller than the sibling
Rust/TypeScript corpora; we compensate with denser `callers` coverage
(`Command.execute`, `Command.Execute`, `Command.ExecuteC`, `Command.AddCommand`,
`Command.PersistentFlags`, `Command.FlagErrorFunc`) that exercises single-site
targets, self-recursion, and high-fanout accessors.
