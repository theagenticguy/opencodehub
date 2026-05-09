# @opencodehub/cobol-proleap

COBOL deep-parse bridge. Spawns a JVM subprocess that wraps the open-source
[uwol/cobol-parser](https://github.com/uwol/cobol-parser) library (v4.0.0 — an
ANTLR-based fixed/free-format COBOL parser) and maps its ASG onto SCIP-compatible
JSON records. Gated behind `--allow-build-scripts=proleap`; unset → regex hot
path from `@opencodehub/ingestion` only.

## Surface

```ts
import { parseCobolDeep } from "@opencodehub/cobol-proleap";

const result = await parseCobolDeep(["a.cbl", "b.cob"], {
  jarPath: "/home/me/.codehub/vendor/proleap/proleap-cobol-parser-4.0.0.jar",
  wrapperClassPath: "/home/me/.codehub/vendor/proleap/wrapper",
});
```

Returns `{ elements, diagnostics, fellBackToRegex }`. On a JVM crash or malformed
JSON, every input file is silently reparsed through the regex hot path so a
single bad file never aborts the run.

## Install

The library is NOT on Maven Central (per 2026-04 research: `search.maven.org`
returns 0 results for `io.github.uwol:proleap-cobol-parser`, and the latest
GitHub Release is v2.4.0 from 2018 even though the repo's `master` is on
v4.x).

`codehub setup --cobol-proleap` performs the one-time build-from-source
bootstrap:

```
# 1. grab the source
git clone https://github.com/uwol/cobol-parser --branch master <tmp>

# 2. build the JAR (produces target/proleap-cobol-parser-<v>.jar)
(cd <tmp> && mvn install -DskipTests)

# 3. compile the wrapper against the JAR
javac -cp <jar> packages/cobol-proleap/java/cobol_to_scip.java

# 4. atomic rename into ~/.codehub/vendor/proleap/
```

The wrapper uses **reflection** against `io.proleap.cobol.asg.*`, so it does
not have to import any ProLeap types at compile time. That means the SAME
`.java` source compiles against any v4.x point release — which is why the
build step needs only a JAR on the classpath, not a specific package name.
A vanilla `javac cobol_to_scip.java` (no classpath) succeeds too and produces
a runnable wrapper class, though running it without the JAR on
`-cp` will error out with the "required class … not on classpath" hint by
design.

### Prerequisites

- **JDK 17 or newer** on PATH (`java --version`). `javac` is required at
  install time; `java` is required at every `analyze` run.
- **Maven 3.8 or newer** on PATH. The library is not published to Maven Central,
  so we build from source.
- **git** on PATH.

If `java --version` reports < 17, both `codehub setup --cobol-proleap` and
`codehub analyze --allow-build-scripts=proleap` refuse to run with a clear
install hint.

## Anti-goals

- We do NOT vendor the JAR in git (per user-approved decision 2026-05-05).
- We do NOT modify the upstream grammar or ASG.
- We do NOT run the JVM by default — the user must opt in explicitly.

## Layout

- `src/index.ts` — public `parseCobolDeep()` entry.
- `src/subprocess.ts` — JVM subprocess management + batched file processing.
- `src/jre-probe.ts` — `java --version` gate + parsed major-version detection.
- `src/fallback.ts` — on crash, reparse via `parseCobolFile` from ingestion.
- `java/cobol_to_scip.java` — tiny wrapper that reads paths on stdin, walks
  the ProLeap ASG, emits NDJSON on stdout (one record per symbol ref).
