import pytest
from prd_mcp.env_secret import read_secret_from_env


def test_maps_known_service_account_pairs(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "embed-key")
    monkeypatch.setenv("LLM_API_KEY", "chat-key")
    assert read_secret_from_env("ringkas-prd-embed", "openai-api-key") == "embed-key"
    assert read_secret_from_env("ringkas-prd-enrich", "llm-api-key") == "chat-key"


def test_missing_env_raises_clearly(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        read_secret_from_env("ringkas-prd-embed", "openai-api-key")


def test_unknown_pair_raises(monkeypatch):
    with pytest.raises(KeyError):
        read_secret_from_env("unknown-service", "unknown-account")
