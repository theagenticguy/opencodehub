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
