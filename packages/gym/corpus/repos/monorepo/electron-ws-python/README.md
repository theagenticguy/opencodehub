# electron-ws-python fixture

A deliberately minimal Electron + Python monorepo used as gym corpus input.

## What this fixture proves

Reproduces the Electron + Python monorepo pattern (renderer TSX, main
TS, Python WebSocket backend, contextBridge IPC) in under 300 lines of
source. Used by `@opencodehub/gym` to exercise multi-tsconfig LSP
handling (renderer and main TS projects with `references`) alongside a
Python ingestion phase in one pipeline, and to document WebSocket
message-type dispatch and Electron contextBridge exposure as v1 blind
spots via `waived: true` goldens — honest about what static reference
tooling cannot see.

## How it maps to the real world

Mirrors the layout of a production Electron desktop app we analyzed
(renderer under `app/renderer`, Electron main process under `app/main`,
Python WebSocket backend under `backend/`). It is NOT a submodule — it
lives in-tree because we want the source to be stable under our own
control rather than drifting with an upstream we don't own. Deps are
declared in `package.json` and `pyproject.toml` but are NEVER
installed: no `node_modules/`, no `.venv/`, no build outputs. The gym
harness reads the source only.

## Expected IDE diagnostics

Your TypeScript language server will flag `Cannot find module 'react'`,
`'electron'`, etc. on this fixture's `.ts`/`.tsx` files. That's by design —
the fixture has no installed deps, and the gym harness reads the source
statically without building. Ignore those diagnostics; they are not in any
CI gate. Biome's check excludes this path (`packages/**/corpus/repos`).

## The two boundaries we expose as waived goldens

1. **WebSocket message-type dispatch.** `chatStore.sendMessage` emits
   `{type: "user_message", ...}`; `backend/server.handle_message`
   dispatches to `handle_user_message` by matching that literal. Static
   reference tooling sees no CALLS edge across this boundary — only
   the string `"user_message"` in two files.
2. **Electron contextBridge.** `app/main/preload.ts` calls
   `contextBridge.exposeInMainWorld("desktop", { takeScreenshot, saveFile })`.
   `app/renderer/App.tsx` calls `window.desktop.takeScreenshot()`.
   The only static evidence is the string `"desktop"` on both sides.

Agents answering "what calls `handle_user_message`?" or "what implements
`window.desktop.takeScreenshot`?" will return LOW risk / no callers
unless the analyzer has runtime or string-level bridging.
