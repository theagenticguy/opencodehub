"""Minimal Python fixture for the install-matrix smoke test."""

from dataclasses import dataclass


@dataclass
class Greeting:
    language: str
    text: str


def greet(name: str) -> Greeting:
    return Greeting(language="en", text=f"Hello, {name}!")
