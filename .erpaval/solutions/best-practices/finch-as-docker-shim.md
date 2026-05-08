---
title: Use finch as a drop-in docker via PATH shim on Amazon AL2023 devboxes
tags: [finch, docker, al2023, containers, emscripten, tree-sitter-cli]
first_applied: 2026-05-08
repos: [opencodehub]
---

## The pattern

CLIs that shell out to `docker` (like `tree-sitter build --wasm -d`,
which runs `docker run emscripten/emsdk ...`) don't know about Amazon
Finch. AL2023 devboxes typically have finch installed via
`/usr/bin/sudo finch ...` (aliased in zsh) but no `docker` on PATH. The
tool errors out with "You must have either emcc, docker, or podman on
your PATH".

Workaround: a 3-line shell shim.

## Fix

```bash
cat > /tmp/docker-shim.sh <<'EOF'
#!/usr/bin/env bash
exec sudo HOME=/home/$USER DOCKER_CONFIG=/home/$USER/.docker finch "$@"
EOF
chmod +x /tmp/docker-shim.sh
mkdir -p /tmp/docker-bin && ln -sf /tmp/docker-shim.sh /tmp/docker-bin/docker

PATH=/tmp/docker-bin:$PATH <your-tool-that-needs-docker>
```

Verified against `tree-sitter build --wasm -d` — finch pulled
`docker.io/emscripten/emsdk:3.1.64` (30 s), built kotlin/swift/dart
WASM grammars (~1 min each), output byte-identical to what a native
docker install would produce.

## Caveats

- `finch run -v /path:/path` works with volume mounts.
- The `sudo HOME=... DOCKER_CONFIG=...` wrapping matches Amazon's
  standard finch alias — without it, finch writes container state to
  `/root/` and breaks cache reuse.
- Warnings like `unsupported volume option "Z"` are harmless (SELinux
  label option that finch/nerdctl ignores).

## When to reach for this

One-off container needs where installing Docker Desktop or podman is
heavier than justifying — e.g. pre-building WASM artifacts to commit,
running a one-shot emsdk compile, or testing something in an
`emscripten/emsdk`-style official image.
