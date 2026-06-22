"""Task 8 scaffold: verify create_app accepts an optional PRD core and
stashes it on app.state — Phase 2-only callers (core=None) are unaffected."""
from __future__ import annotations

import types
import pytest

from prd_mcp.web.app import create_app
from prd_mcp.web.coredeps import Core


def _fake_core() -> Core:
    """Return a Core built from simple fakes (no real Chroma / LLM needed)."""
    cfg = types.SimpleNamespace(chroma_path="/tmp/fake")
    store = types.SimpleNamespace()
    llm = types.SimpleNamespace()
    return Core(cfg=cfg, store=store, llm=llm)


def test_create_app_with_core_sets_app_state(settings, sessionmaker_):
    """When core= is supplied, app.state.core must be that core."""
    core = _fake_core()
    app = create_app(settings, sessionmaker_, run_startup=False, core=core)
    assert app.state.core is core


def test_create_app_without_core_leaves_state_clean(settings, sessionmaker_):
    """When core= is omitted (Phase 2-only callers), app.state.core must be absent / None."""
    app = create_app(settings, sessionmaker_, run_startup=False)
    assert getattr(app.state, "core", None) is None
