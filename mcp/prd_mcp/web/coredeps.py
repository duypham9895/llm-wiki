"""Holds the shared PRD core (cfg/store/llm) on app.state so the HTTP door's
routers can reach the SAME core that cli.py builds for index/serve."""
from __future__ import annotations

from dataclasses import dataclass
from fastapi import Request


@dataclass
class Core:
    cfg: object
    store: object
    llm: object


def set_core(app, core: Core) -> None:
    app.state.core = core


def get_core(request: Request) -> Core:
    core = getattr(request.app.state, "core", None)
    if core is None:
        raise RuntimeError("core not initialized; pass core= to create_app for the web door")
    return core
