"""Pydantic mirrors of the TypeScript WsMessage union in app/shared/types.ts.

These are INTENTIONALLY not cross-linked to the TS side: the only shared
artifact is the literal value of the ``type`` discriminator. A rename on
one side will not propagate — that is the pattern this fixture
reproduces.
"""

from typing import Literal

from pydantic import BaseModel


class UserMessagePayload(BaseModel):
    text: str


class UserMessage(BaseModel):
    type: Literal["user_message"]
    payload: UserMessagePayload


class GetSettings(BaseModel):
    type: Literal["get_settings"]


class SettingsResponsePayload(BaseModel):
    theme: Literal["light", "dark"]
    model: str


class SettingsResponse(BaseModel):
    type: Literal["settings_response"]
    payload: SettingsResponsePayload


class ScreenshotSavedPayload(BaseModel):
    path: str


class ScreenshotSaved(BaseModel):
    type: Literal["screenshot_saved"]
    payload: ScreenshotSavedPayload
