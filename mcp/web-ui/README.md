# PRD Dashboard Web UI

## Build

Run `npm run build` to emit `dist/`. The output is static: runtime serving needs no Node process. Run the build locally or in CI before deploying.

## Caddy deploy note

Caddy serves `dist/` at the dashboard origin and reverse-proxies `/api/*` to the loopback Plan A FastAPI door. The operator sets the Plan A FastAPI loopback port.

Use SPA fallback for non-API paths so React Router can handle client-side routes: `try_files {path} /index.html`.

The Ask tab streams answers via Server-Sent Events over `/api/chat/.../messages`, so the API `reverse_proxy` must NOT buffer the response — `flush_interval -1` (shown in the snippet) ensures tokens stream live instead of arriving all at once.

Same-origin is required: the SPA and `/api` must share one origin so Phase 2's SameSite cookie and the `X-Requested-With: prd-app` CSRF header work without CORS. Do not host the SPA on a separate origin/CDN without revisiting the cookie/CORS model.

```caddyfile
dashboard.example.com {
    # API: proxy /api/* to the loopback Plan A FastAPI door.
    # flush_interval -1 disables response buffering so the Ask tab's
    # Server-Sent Events stream token-by-token instead of buffering.
    handle /api/* {
        reverse_proxy 127.0.0.1:PLAN_A_PORT {
            flush_interval -1
        }
    }

    # SPA: serve the static build; fall back to index.html for client-side routes.
    handle {
        root * /srv/llm-wiki/mcp/web-ui/dist
        try_files {path} /index.html
        file_server
    }
}
```
