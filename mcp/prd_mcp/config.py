import os
from dataclasses import dataclass


@dataclass
class Config:
    vault_path: str
    prds_dir: str
    openai_key: str
    openai_base: str
    embed_model: str
    minimax_key: str
    minimax_base: str
    chat_model: str
    chroma_path: str
    chunk_size: int
    chunk_overlap: int
    top_k: int
    request_timeout: int
    max_retries: int
    http_token: str


def load_config(env: dict, read_secret_fn) -> Config:
    vault = env.get("VAULT_PATH")
    if not vault:
        raise ValueError("VAULT_PATH env var is required")
    return Config(
        vault_path=vault,
        prds_dir=os.path.join(vault, "PRDs"),
        openai_key=read_secret_fn("ringkas-prd-embed", "openai-api-key"),
        openai_base=env.get("OPENAI_BASE", "https://api.openai.com/v1"),
        embed_model=env.get("EMBED_MODEL", "text-embedding-3-small"),
        minimax_key=read_secret_fn("ringkas-prd-enrich", "llm-api-key"),
        minimax_base=env.get("MINIMAX_BASE", "https://9router-1.dat-nguyen.me/v1"),
        chat_model=env.get("CHAT_MODEL", "minimax/MiniMax-M3"),
        chroma_path=env.get("CHROMA_PATH", os.path.join(vault, ".chroma-mcp")),
        chunk_size=int(env.get("CHUNK_SIZE", "1000")),
        chunk_overlap=int(env.get("CHUNK_OVERLAP", "150")),
        top_k=int(env.get("TOP_K", "8")),
        request_timeout=int(env.get("REQUEST_TIMEOUT", "60")),
        max_retries=int(env.get("MAX_RETRIES", "3")),
        http_token=env.get("MCP_AUTH_TOKEN", ""),
    )
