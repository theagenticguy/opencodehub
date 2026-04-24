"""Per-message-type handlers for the WebSocket backend.

The dispatcher in ``server.handle_message`` selects one of these by
string match on ``msg["type"]``. Static tools without runtime
instrumentation cannot see which handler pairs with which renderer
call site.
"""

from __future__ import annotations

import json
from typing import Any

from websockets.asyncio.server import ServerConnection

from .models import (
    ScreenshotSavedPayload,
    SettingsResponse,
    SettingsResponsePayload,
    UserMessagePayload,
)


async def handle_user_message(
    ws: ServerConnection, payload: UserMessagePayload
) -> None:
    reply: dict[str, Any] = {
        "type": "user_message_ack",
        "payload": {"echo": payload.text},
    }
    await ws.send(json.dumps(reply))


async def handle_get_settings(ws: ServerConnection) -> None:
    reply = SettingsResponse(
        type="settings_response",
        payload=SettingsResponsePayload(theme="dark", model="sonnet"),
    )
    await ws.send(reply.model_dump_json())


async def handle_screenshot_saved(
    ws: ServerConnection, payload: ScreenshotSavedPayload
) -> None:
    reply: dict[str, Any] = {
        "type": "screenshot_ack",
        "payload": {"path": payload.path},
    }
    await ws.send(json.dumps(reply))
