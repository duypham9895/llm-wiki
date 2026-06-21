import os

# (service, account) -> env var name. These are the only secrets the core requests
# (see config.py load_config: ringkas-prd-embed/openai-api-key, ringkas-prd-enrich/llm-api-key).
_ENV_BY_PAIR = {
    ("ringkas-prd-embed", "openai-api-key"): "OPENAI_API_KEY",
    ("ringkas-prd-enrich", "llm-api-key"): "LLM_API_KEY",
}


def read_secret_from_env(service: str, account: str) -> str:
    """Env-backed replacement for keychain.read_secret on Linux (PRD_SECRETS=env)."""
    var = _ENV_BY_PAIR[(service, account)]  # KeyError on an unknown pair = programmer error
    val = os.environ.get(var)
    if not val:
        raise ValueError(f"{var} env var is required (PRD_SECRETS=env mode)")
    return val
