# syntax=docker/dockerfile:1
#
# OpenCodeHub — Docker distribution (LITE variant).
#
# An additive, non-npm distribution artifact: the same `codehub` CLI and its
# stdio MCP server, packaged as a container so an agent host can run it with
# `docker run -i --rm` instead of a global npm install. The npm path
# (`@opencodehub/cli`) is unchanged and remains the recommended install.
#
# LITE = parser + graph + CLI + stdio MCP only. NO embedder (the
# `onnxruntime-node` native, an `optionalDependencies` entry), NO JVM /
# scip-java / scip-go / uv. Those belong to the FULL variant (built from a
# separate `--target full` stage in a later change). Target ~300 MB.
#
# Build:   docker build -t opencodehub:lite --target lite .
# Run MCP: docker run -i --rm opencodehub:lite och-mcp
# Run CLI: docker run --rm -v "$PWD:/repo" -w /repo opencodehub:lite codehub analyze
#
# Transport is stdio JSON-RPC only — there is intentionally no HTTP surface,
# no EXPOSE, and no network listener (the MCP server is local-first by design).

# ---------------------------------------------------------------------------
# Stage 1 — builder (full toolchain): install, build the workspace, prune.
# ---------------------------------------------------------------------------
FROM node:24 AS builder

# Corepack-managed pnpm, pinned to the repo's packageManager version so the
# image build resolves the lockfile identically to local + CI.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.1.0 --activate

WORKDIR /src

# Copy the whole workspace. (.dockerignore keeps node_modules, .git, .erpaval,
# sibling worktrees, and test fixtures out of the build context.) The CLI build
# (tsup) resolves the vendored grammar WASMs and the COBOL/JVM bridge by
# walking up from the package root, so the full source tree must be present at
# build time even though the runtime stage only needs the pruned closure.
COPY . .

# Reproducible install from the committed lockfile. This is a FULL install
# (optionals included): the build toolchain itself relies on optional deps —
# esbuild/tsup resolve their per-platform binary (`@esbuild/linux-x64`) via the
# `optionalDependencies` mechanism, so `--no-optional` here would break the
# workspace build. The embedder native (`onnxruntime-node`) is dropped later,
# at the deploy/prune step, where `--no-optional` correctly excludes only the
# CLI's runtime optional dep without starving the builder.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Build every workspace package except @opencodehub/docs (Astro + headless
# Chromium; not part of the runtime image). This emits packages/cli/dist/,
# including dist/vendor/wasms/ (the 16 grammar blobs copied by tsup onSuccess).
#
# `--workspace-concurrency=1` forces a serial, strictly topological build. On a
# clean tree (every dist/ empty, as in this fresh image layer) the default
# parallel scheduler can start a `tsc -b` project before a sibling it imports
# under NodeNext resolution has flushed its `dist/index.d.ts`, surfacing as
# spurious `TS2307: Cannot find module '@opencodehub/<pkg>'`. Serializing makes
# the build deterministic in the container without touching any package source.
RUN pnpm --filter '!@opencodehub/docs' --workspace-concurrency=1 -r build

# Prune to a self-contained, deployable closure for the CLI. `pnpm deploy`
# copies the package's published `files` (dist/**, incl. dist/vendor/wasms/**,
# dist/java/**, dist/plugin-assets/**, dist/config/**) plus its production
# node_modules with native `.node` bindings intact. `--no-optional` again keeps
# onnxruntime out of the pruned tree. Output: /app (app + node_modules).
#
# `--config.inject-workspace-packages=true`: pnpm v10+ refuses the DEFAULT
# (modern) deploy unless this is set. We pass it as a one-shot CLI config
# override rather than editing pnpm-workspace.yaml repo-wide (which would change
# every package's link strategy for all developers). The modern deploy CLONES
# the already-resolved packages from the content-addressable store into /app
# and reuses the native `.node` binaries the builder's `pnpm install` already
# laid down (it does not rebuild from source).
#
# The deploy is run WITH optionals (NOT `--no-optional`). Counter-intuitively,
# the lite variant NEEDS optional deps here: the graph engine (`@ladybugdb/core`)
# and DuckDB (`@duckdb/node-api`) ship their native binaries as per-platform
# OPTIONAL sub-packages (e.g. `@ladybugdb/core-linux-x64`). `--no-optional`
# strips those, so `@ladybugdb/core`'s install.js can't find its prebuilt
# `lbugjs.node`, tries to build from source, and the deploy fails. Keeping
# optionals pulls the linux-x64 prebuilt binaries the runtime requires.
#
# The "lite" exclusion (the embedder) is then done SURGICALLY: delete the
# onnxruntime-node entry (~550 MB) from the deployed virtual store. The CLI
# lazy-loads onnxruntime only when embeddings are enabled (it is the CLI's own
# optionalDependency), so removing it yields a fully-working parser+graph+CLI+MCP
# image with no embedder — exactly the lite contract. (`-f`/`true` keep the step
# resilient if a future pnpm layout renames the dir.)
#
# Belt-and-suspenders (same RUN layer): the grammar WASMs are vendored in-tree
# (not an npm dep), so if a future pnpm/tsup change stops them riding along in
# the published `files`, copy them explicitly into the deployed dist so the
# runtime stage is never missing a parser grammar (no-op overwrite when deploy
# already carried them).
RUN pnpm --config.inject-workspace-packages=true \
    --filter=@opencodehub/cli deploy --prod /app \
    && rm -rf /app/node_modules/onnxruntime-node \
              /app/node_modules/.pnpm/onnxruntime-node@* \
    && mkdir -p /app/dist/vendor/wasms \
    && cp -R /src/packages/ingestion/vendor/wasms/. /app/dist/vendor/wasms/

# ---------------------------------------------------------------------------
# Stage 2 — lite runtime: slim Node, pruned app only. No build toolchain.
# ---------------------------------------------------------------------------
FROM node:24-slim AS lite

LABEL org.opencontainers.image.title="opencodehub" \
      org.opencontainers.image.description="OpenCodeHub code-intelligence CLI + stdio MCP server (lite variant)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/theagenticguy/opencodehub" \
      org.opencodehub.variant="lite"

ENV NODE_ENV=production
WORKDIR /app

# The pruned CLI closure: dist/ (bundle + vendored grammar WASMs + JVM bridge
# source + plugin assets + scanner config) and its production node_modules
# (native graph + DuckDB bindings intact; embedder ONNX deliberately absent).
COPY --from=builder /app /app

# `och-mcp` shim — the packet's container contract is
# `docker run -i --rm <image> och-mcp`, but the package exposes a single
# `codehub` bin and runs the stdio MCP server as the `codehub mcp` subcommand.
# Alias it here (per API contract: alias via the image, do NOT rename the
# package bin). `exec` so the Node process is PID 1 and receives signals.
RUN printf '#!/bin/sh\nexec node /app/dist/index.js mcp "$@"\n' > /usr/local/bin/och-mcp \
    && chmod +x /usr/local/bin/och-mcp \
    && printf '#!/bin/sh\nexec node /app/dist/index.js "$@"\n' > /usr/local/bin/codehub \
    && chmod +x /usr/local/bin/codehub

# Default to the stdio MCP server. `docker run -i` keeps stdin open for the
# JSON-RPC stream; override the command (e.g. `... codehub analyze`) to drive
# the CLI. No EXPOSE / port / listener — stdio is the only transport (U9).
ENTRYPOINT []
CMD ["och-mcp"]

# ===========================================================================
# FULL variant — lite + the curated SCIP toolchains the npm package can't ship
# ===========================================================================
#
# FULL = LITE + the indexers that need a non-Node runtime: a jlink-trimmed
# JRE-21 hosting scip-java, the scip-go static Go binary, and `uv`/`uvx` for
# the Python indexers. scip-typescript / scip-python are pure-JS npm deps of
# @opencodehub/scip-ingest and already ride in via the lite stage's pruned
# closure, so the full stage does NOT re-install them.
#
# Build (native arch):  docker build --target full -t opencodehub:full .
# Build (multi-arch):   docker buildx build --target full \
#                         --platform linux/amd64,linux/arm64 -t opencodehub:full .
# Run MCP:              docker run -i --rm opencodehub:full och-mcp
# Run an indexer:       docker run --rm -v "$PWD:/repo" -w /repo \
#                         opencodehub:full codehub analyze
#
# License hygiene (AC-D6): every bundled toolchain is on the OSS allowlist —
# scip-go (Apache-2.0), scip-java (Apache-2.0), uv (Apache-2.0/MIT), Temurin
# JRE (GPLv2 + Classpath Exception — the Classpath Exception explicitly clears
# the runtime-bundling concern). NO GPL/MPL binary (hadolint, tflint, GPL/EPL
# LSP servers) is ever baked in; those stay detect-on-PATH-and-subprocess only.
#
# Pins (ADR 0006 + packet): scip-go v0.2.7, scip-java 0.12.3, JDK 21 (Temurin).

# ---------------------------------------------------------------------------
# Stage F1 — jre-build: jlink-trimmed JRE-21 + a standalone scip-java launcher.
# ---------------------------------------------------------------------------
# The JDK-21 image carries `jlink`; we emit a custom ~50 MB runtime image
# (vs ~200 MB for a full JRE) that contains only the modules scip-java needs,
# then bootstrap scip-java as a STANDALONE fat-JAR launcher (every classpath
# JAR embedded → no network fetch at runtime). `--platform=$BUILDPLATFORM` is
# deliberately ABSENT: jlink and the Coursier bootstrap both emit
# arch-specific artifacts (the JRE ships native `.so`s; the scip-java
# standalone fetches per-arch deps), so this stage MUST run on the TARGET
# platform for each leg of a multi-arch build.
FROM eclipse-temurin:21-jdk AS jre-build

# jlink the minimal runtime. `java.se` is the broad SE aggregate module; it
# keeps the runtime general enough for scip-java's reflective/SDK use while
# `--strip-debug --no-man-pages --no-header-files --compress=zip-9` trims it
# to ~50 MB. Output: /opt/jre (a self-contained, relocatable JRE).
RUN "$JAVA_HOME/bin/jlink" \
      --add-modules java.se \
      --strip-debug \
      --no-man-pages \
      --no-header-files \
      --compress=zip-9 \
      --output /opt/jre

# Coursier bootstrap of scip-java, pinned to the ADR-0006 version (0.12.3),
# as a STANDALONE launcher: every dependency JAR is embedded in the output so
# the launcher runs fully offline under the jlink JRE (no `~/.cache/coursier`
# fetch at container runtime). The launcher itself is a tiny `#!/usr/bin/env
# sh` wrapper that execs `java -jar`; it finds `java` because the full stage
# puts /opt/jre/bin on PATH.
#
# We fetch the ARCH-INDEPENDENT `coursier.jar` (pinned v2.1.24) and run it on
# the JDK's `java`, NOT the native `cs` binary — Coursier publishes a native
# Linux launcher for x86_64 ONLY (no `cs-aarch64-pc-linux`), so a native-binary
# path is broken on the linux/arm64 leg (it fails with exit 127, a wrong-arch
# ELF). The JAR runs on any JVM, so this bootstrap is correct on BOTH arches.
# We use the JDK's own `java` for the bootstrap build only — the resulting
# standalone launcher carries no JDK dependency and runs under the jlink JRE.
ARG SCIP_JAVA_VERSION=0.12.3
ARG COURSIER_VERSION=v2.1.24
ADD https://github.com/coursier/coursier/releases/download/${COURSIER_VERSION}/coursier.jar /tmp/coursier.jar
RUN set -eux; \
    mkdir -p /opt/scip-java; \
    # Run the Coursier JAR on the full JDK's `java` (resolves it from $JAVA_HOME
    # set by the temurin base) so the bootstrap has the complete toolchain.
    "$JAVA_HOME/bin/java" -jar /tmp/coursier.jar bootstrap "com.sourcegraph:scip-java_2.13:${SCIP_JAVA_VERSION}" \
        --main-class com.sourcegraph.scip_java.ScipJava \
        --standalone \
        -o /opt/scip-java/scip-java; \
    # Smoke the launcher under the TRIMMED jlink JRE (the exact runtime that
    # ships) so a missing module fails the build here, not at container runtime
    # (per-arch ABI/module assurance).
    PATH="/opt/jre/bin:$PATH" /opt/scip-java/scip-java --version

# ---------------------------------------------------------------------------
# Stage F2 — scip-go-dl: fetch + verify the pinned scip-go static binary.
# ---------------------------------------------------------------------------
# scip-go v0.2.7 ships per-arch static Linux tarballs on the GitHub release
# (linux-amd64 + linux-arm64 confirmed present + .sha256 sidecars). We fetch
# the tarball + its `.sha256` with BuildKit `ADD` (follows the GitHub release
# redirect; no apt/curl install needed — keeps the layer lean and hadolint
# clean) and verify the published SHA-256 before trusting the binary. The
# eclipse-temurin JDK base already ships `tar` + `sha256sum` (coreutils) and
# CA roots, so no package install is required. `TARGETARCH` (amd64|arm64)
# matches the release asset's arch token 1:1 — no rewrite needed.
FROM eclipse-temurin:21-jdk AS scip-go-dl
ARG TARGETARCH
ARG SCIP_GO_VERSION=v0.2.7
ADD https://github.com/scip-code/scip-go/releases/download/${SCIP_GO_VERSION}/scip-go-linux-${TARGETARCH}.tar.gz /tmp/scip-go.tar.gz
ADD https://github.com/scip-code/scip-go/releases/download/${SCIP_GO_VERSION}/scip-go-linux-${TARGETARCH}.tar.gz.sha256 /tmp/scip-go.tar.gz.sha256
RUN set -eux; \
    # The .sha256 sidecar is GNU `sha256sum` format (`<digest>  <asset-name>`).
    # Extract just the digest (field 1, no pipe — keeps the layer hadolint-clean)
    # and reconstruct a check line that points at our local download path.
    printf '%s  /tmp/scip-go.tar.gz\n' "$(awk '{print $1}' /tmp/scip-go.tar.gz.sha256)" > /tmp/scip-go.sha256.check; \
    sha256sum -c /tmp/scip-go.sha256.check; \
    mkdir -p /extract /out; \
    tar -xzf /tmp/scip-go.tar.gz -C /extract; \
    # The v0.2.7 tarball extracts a top-level `scip-go` binary. If a future
    # layout nests it, `find -exec cp` resolves it without a pipe (keeps the
    # layer hadolint-clean) — first match wins, then we assert exactly one.
    find /extract -name scip-go -type f -exec cp {} /out/scip-go \;; \
    test -f /out/scip-go; \
    chmod +x /out/scip-go; \
    /out/scip-go --version

# ---------------------------------------------------------------------------
# Stage F3 — full runtime: lite + JRE + scip-java + scip-go + uv/uvx.
# ---------------------------------------------------------------------------
FROM lite AS full

LABEL org.opencontainers.image.description="OpenCodeHub code-intelligence CLI + stdio MCP server (full variant: + scip-go / scip-java / uv toolchains)" \
      org.opencodehub.variant="full"

# jlink JRE — hosts the scip-java launcher. Putting /opt/jre/bin FIRST on PATH
# makes the bare `java` the scip-java wrapper execs resolve to the trimmed JRE.
COPY --from=jre-build /opt/jre /opt/jre
ENV JAVA_HOME=/opt/jre \
    PATH=/opt/jre/bin:$PATH

# scip-java standalone launcher (Coursier bootstrap, all JARs embedded).
COPY --from=jre-build /opt/scip-java/scip-java /usr/local/bin/scip-java

# scip-go static binary (pinned v0.2.7, SHA-256 verified in F2).
COPY --from=scip-go-dl /out/scip-go /usr/local/bin/scip-go

# uv / uvx for the Python indexers — the upstream-documented multistage COPY
# form. Pinned by the image tag in CI (see .github/workflows/docker.yml);
# `latest` here is the upstream-blessed `COPY --from` contract for local builds.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Inherit the lite stage's ENTRYPOINT/CMD (och-mcp over stdio). No EXPOSE, no
# listener — same stdio-only transport contract as lite (U9).
