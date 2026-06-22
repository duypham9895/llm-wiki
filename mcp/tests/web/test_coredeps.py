import pytest
from types import SimpleNamespace
from prd_mcp.web.coredeps import Core, set_core, get_core


def test_set_and_get_core():
    app = SimpleNamespace(state=SimpleNamespace())
    core = Core(cfg="C", store="S", llm="L")
    set_core(app, core)
    request = SimpleNamespace(app=app)
    got = get_core(request)
    assert (got.cfg, got.store, got.llm) == ("C", "S", "L")


def test_get_core_unset_raises():
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    with pytest.raises(RuntimeError, match="core not initialized"):
        get_core(request)
