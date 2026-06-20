import pytest
from prd_mcp.config import load_config


def fake_read(service, account):
    return {"ringkas-prd-embed": "sk-openai", "ringkas-prd-enrich": "mm-key"}[service]


BASE = {"VAULT_PATH": "/tmp/vault"}


def test_defaults_and_keys():
    c = load_config(BASE, fake_read)
    assert c.vault_path == "/tmp/vault"
    assert c.prds_dir.endswith("/PRDs")
    assert c.openai_key == "sk-openai"
    assert c.minimax_key == "mm-key"
    assert c.embed_model == "text-embedding-3-small"
    assert c.chat_model == "minimax/MiniMax-M3"
    assert c.openai_base == "https://api.openai.com/v1"
    assert c.minimax_base == "https://9router-1.dat-nguyen.me/v1"
    assert c.chroma_path.endswith("/.chroma-mcp")
    assert c.chunk_size == 1000 and c.chunk_overlap == 150 and c.top_k == 8
    assert c.request_timeout == 60 and c.max_retries == 3
    assert c.http_token == ""


def test_requires_vault_path():
    with pytest.raises(ValueError, match="VAULT_PATH"):
        load_config({}, fake_read)


def test_env_overrides():
    c = load_config({**BASE, "TOP_K": "5", "MCP_AUTH_TOKEN": "secret"}, fake_read)
    assert c.top_k == 5
    assert c.http_token == "secret"


def test_score_threshold_default_and_override():
    from prd_mcp.config import load_config
    def fake_secret(s, a): return "k"
    base = {"VAULT_PATH": "/tmp/v"}
    cfg = load_config(base, fake_secret)
    assert cfg.score_threshold == -0.15
    cfg2 = load_config({**base, "PRD_SCORE_THRESHOLD": "-0.30"}, fake_secret)
    assert cfg2.score_threshold == -0.30
