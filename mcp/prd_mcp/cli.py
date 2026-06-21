import os, sys, argparse
from prd_mcp.config import load_config
from prd_mcp.keychain import read_secret
from prd_mcp.store import Store
from prd_mcp.llm import make_client
from prd_mcp.index import run_index
from prd_mcp.server import build_server


def main() -> int:
    parser = argparse.ArgumentParser(prog="prd-mcp")
    sub = parser.add_subparsers(dest="cmd", required=True)
    idx = sub.add_parser("index", help="build/refresh the PRD index")
    idx.add_argument("--force", action="store_true",
                     help="re-embed every doc (ignore body_hash skip-guard)")
    serve = sub.add_parser("serve", help="run the MCP server")
    serve.add_argument("--http", action="store_true", help="streamable-http transport (token-gated)")
    web = sub.add_parser("web", help="run the FastAPI auth web app (uvicorn, single worker)")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8300)
    args = parser.parse_args()

    if args.cmd == "web":
        import uvicorn
        from prd_mcp.web.settings import load_settings
        from prd_mcp.web.db import make_engine, make_sessionmaker
        from prd_mcp.web.app import create_app
        from prd_mcp.web.coredeps import Core

        web_settings = load_settings()  # reads os.environ; NO keychain, NO Chroma
        engine = make_engine(web_settings.database_url)
        sm = make_sessionmaker(engine)
        # Build the PRD core (cfg/store/llm) the same way index/serve do.
        if os.environ.get("PRD_SECRETS") == "env":
            from prd_mcp.env_secret import read_secret_from_env as secret_reader
        else:
            secret_reader = read_secret
        cfg = load_config(os.environ, secret_reader)
        store = Store.open(cfg.chroma_path)
        llm = make_client(cfg)
        application = create_app(web_settings, sm, run_startup=True, core=Core(cfg=cfg, store=store, llm=llm))
        uvicorn.run(
            application, host=args.host, port=args.port,
            workers=1, forwarded_allow_ips="127.0.0.1",  # trust XFF only from Caddy on loopback
        )
        return 0

    # index/serve only past this point — these require the keychain + Chroma:
    # index/serve require the LLM/embed secrets:
    if os.environ.get("PRD_SECRETS") == "env":
        from prd_mcp.env_secret import read_secret_from_env as secret_reader
    else:
        secret_reader = read_secret
    cfg = load_config(os.environ, secret_reader)
    store = Store.open(cfg.chroma_path)

    if args.cmd == "index":
        from datetime import datetime, timezone
        from prd_mcp.web.manifests import write_index_manifest
        llm = make_client(cfg)
        started = datetime.now(timezone.utc).isoformat()
        res = run_index(cfg, store, llm.embed, force=args.force)
        run_id = os.environ.get("RUN_ID", started)
        # Codex #4 + new[major]: compute index_nonempty ONCE and make the process exit code
        # AGREE with the manifest's exit_code (an empty index is a failure). Otherwise the
        # orchestrator's exit-vs-manifest reconciliation (Task 8) would halt on a false
        # "disagreement" instead of the intended empty-index gate.
        index_nonempty = bool(store.stored_hashes())
        write_index_manifest(cfg.vault_path, run_id, started,
                             datetime.now(timezone.utc).isoformat(), res,
                             index_nonempty=index_nonempty)
        print(f"indexed {res['indexed']} · skipped {res['skipped']} · "
              f"removed {res['removed']} · errors {res['errors']}")
        return 1 if (res["errors"] or not index_nonempty) else 0

    # serve
    llm = make_client(cfg)
    mcp = build_server(cfg, store, llm)
    if args.http:
        if not cfg.http_token:
            print("MCP_AUTH_TOKEN is required for --http", file=sys.stderr)
            return 1
        mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
