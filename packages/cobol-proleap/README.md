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
single bad file never aborts the run (spec AC-M4-6 success criterion #3).

## Install

The library is NOT on Maven Central. `codehub setup --cobol-proleap` performs
the one-time bootstrap:

1. `git clone https://github.com/uwol/cobol-parser --branch master
   <tmp>` — grabs the source.
2. `mvn install -DskipTests` — builds the JAR from source.
3. `javac -cp <jar> cobol_to_scip.java` — compiles our wrapper against the
   resulting JAR.
4. Atomic rename into `~/.codehub/vendor/proleap/`.

### Prerequisites

- **JDK 17 or newer** on PATH (`java --version`). `javac` is required at
  install time; `java` is required at every `analyze` run.
- **Maven 3.8 or newer** on PATH. The library is not published to Maven Central,
  so we build from source.
- **git** on PATH.

If `java --version` reports < 17, both `codehub setup --cobol-proleap` and
`codehub analyze --allow-build-scripts=proleap` refuse to run with a clear
install hint (spec S-M4-2).

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
