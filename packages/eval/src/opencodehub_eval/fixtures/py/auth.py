"""A tiny auth module used as an eval fixture."""

from __future__ import annotations


class Auth:
    """Minimal in-memory auth store."""

    def __init__(self) -> None:
        self._users: dict[str, dict[str, str]] = {}

    def login(self, email: str, password: str) -> dict[str, str] | None:
        user = self._users.get(email)
        if user is None:
            return None
        if user["passwordHash"] != _hash(password):
            return None
        return user

    def register(self, email: str, password: str) -> dict[str, str]:
        user = {"email": email, "passwordHash": _hash(password)}
        self._users[email] = user
        return user


def _hash(raw: str) -> str:
    return f"sha256:{len(raw)}:{raw}"
