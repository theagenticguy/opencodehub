# multi-lang fixture

Tiny TS/Python/Go fixture (~10 LOC each) used by the install-matrix smoke
test in `.github/workflows/verify-global-install.yml`. The script
`scripts/verify-global-install.sh` runs `codehub analyze` against this
directory after a global tarball install and asserts that
`codehub query 'export default'` finds at least one hit (the `greet`
function in `greeter.ts`).

Keep this fixture small. The matrix runs 9 cells across two OS classes;
analyze time multiplies. Do not add binaries, build artifacts, or large
generated files.
