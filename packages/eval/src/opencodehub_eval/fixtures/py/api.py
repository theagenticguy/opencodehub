"""HTTP-style entry points for the eval fixture."""

from __future__ import annotations

from .auth import Auth

auth = Auth()


def login(email: str, password: str) -> dict[str, object]:
    user = auth.login(email, password)
    if user is None:
        return {"ok": False}
    return {"ok": True, "email": user["email"]}


def register(email: str, password: str) -> dict[str, object]:
    user = auth.register(email, password)
    return {"ok": True, "email": user["email"]}
