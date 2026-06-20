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

        web_settings = load_settings()  # reads os.environ; NO keychain, NO Chroma
        engine = make_engine(web_settings.database_url)
        sm = make_sessionmaker(engine)
        application = create_app(web_settings, sm, run_startup=True)
        uvicorn.run(
            application, host=args.host, port=args.port,
            workers=1, forwarded_allow_ips="127.0.0.1",  # trust XFF only from Caddy on loopback
        )
        return 0

    # index/serve only past this point — these require the keychain + Chroma:
    cfg = load_config(os.environ, read_secret)
    store = Store.open(cfg.chroma_path)

    if args.cmd == "index":
        llm = make_client(cfg)
        res = run_index(cfg, store, llm.embed, force=args.force)
        print(f"indexed {res['indexed']} · skipped {res['skipped']} · "
              f"removed {res['removed']} · errors {res['errors']}")
        return 1 if res["errors"] else 0

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
