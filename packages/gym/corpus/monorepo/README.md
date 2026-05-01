# monorepo/ — cross-language corpus split

Schema: `corpusFileSchema` in `packages/gym/src/corpus.ts`.
See sibling corpora via `../repos/README.md` (fixture pins).

This directory holds goldens for the in-tree `electron-ws-python`
monorepo fixture (`packages/gym/corpus/repos/monorepo/electron-ws-python/`).
The fixture reproduces an Electron + Python monorepo: a React/TSX
renderer, an Electron main process, a shared TS package wired via
`tsconfig` project references, and a Python WebSocket backend.

## Why two files

The corpus manifest schema (`packages/gym/src/corpus.ts`) requires
exactly one language per manifest file (`python | typescript | go |
rust`). This fixture spans two languages, so the golden set is split:

- `electron-ws-python-typescript.yaml` — 5 cases (4 confirmed + 1
  waived). Targets the TS renderer/main/shared code and exercises the
  tsconfig-aware TypeScriptClient warmup shipped in commit 92d563c.
- `electron-ws-python-python.yaml` — 4 cases (3 confirmed + 1 waived).
  Targets the Python backend handlers and models.

Both files share the same `corpus.name` (`electron-ws-python`), the
same 40-char commit pin, and the same `corpus.path`
(`monorepo/electron-ws-python`). The gym harness loads them as two
independent manifests that happen to point at the same fixture tree.

## Confirmed vs waived

The confirmed cases (7 total across the two files) are refs/callers
that scip-typescript / scip-python **should** return correctly:

- Multi-tsconfig cross-project refs (`WsMessage`, `DesktopBridge`)
  where the renderer and main-process tsconfigs both include
  `app/shared` via `references`.
- Intra-package callers (`sendMessage`, `registerScreenshotHandler`,
  `handle_message`).
- Intra-package refs on a Pydantic model (`UserMessagePayload`).

The waived cases (2 total) mark patterns that static reference tooling
**cannot** resolve in v1 and shouldn't pretend to:

- `mono-ts.references.window.desktop.takeScreenshot` — the Electron
  `contextBridge.exposeInMainWorld("desktop", ...)` boundary. The
  only static link between `preload.ts` and the renderer's
  `window.desktop.takeScreenshot()` call is the string literal
  `"desktop"`.
- `mono-py.callers.handle_user_message_cross_language` — the
  WebSocket message-type dispatch boundary. The only static link
  between the renderer-side
  `JSON.stringify({type: "user_message", ...})` and the Python-side
  `match msg.get("type")` is the string literal `"user_message"`.

Both waived cases set `waived: true` with `expected: []` so the gate-3
regression check skips them. Keeping them in the corpus (rather than
deleting them) documents the boundary and lets a future string-aware
or protocol-aware analyzer un-waive them without rewriting goldens.

See the fixture's own README
(`packages/gym/corpus/repos/monorepo/electron-ws-python/README.md`)
for the full pattern context and the two boundaries exposed as waived
goldens.
