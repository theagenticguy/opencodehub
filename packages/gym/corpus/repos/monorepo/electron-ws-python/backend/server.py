"""WebSocket server with a string-dispatched message router.

``handle_message`` is the Python equivalent of the renderer's
WebSocket ``send({type: ...})`` call sites — they are linked only by
the literal ``type`` string.
"""

from __future__ import annotations

import asyncio
import json

from websockets.asyncio.server import ServerConnection, serve

from .handlers import handle_get_settings, handle_screenshot_saved, handle_user_message
from .models import ScreenshotSavedPayload, UserMessagePayload


async def handle_message(ws: ServerConnection, raw: str) -> None:
    msg = json.loads(raw)
    match msg.get("type"):
        case "user_message":
            await handle_user_message(ws, UserMessagePayload(**msg["payload"]))
        case "get_settings":
            await handle_get_settings(ws)
        case "screenshot_saved":
            await handle_screenshot_saved(ws, ScreenshotSavedPayload(**msg["payload"]))
        case _:
            await ws.send(json.dumps({"type": "error", "reason": "unknown_type"}))


async def _connection(ws: ServerConnection) -> None:
    async for raw in ws:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        await handle_message(ws, text)


async def main() -> None:
    async with serve(_connection, "localhost", 8765):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
