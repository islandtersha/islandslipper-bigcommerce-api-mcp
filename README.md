# Island Slipper BigCommerce MCP (Cloudflare Workers)

A [Model Context Protocol](https://modelcontextprotocol.io/) server for the
Island Slipper BigCommerce store, running on **Cloudflare Workers** and reachable
as a **remote MCP connector** (Claude / Cowork) over **Streamable HTTP**.

This is a fork of [isaacgounton/bigcommerce-api-mcp](https://github.com/isaacgounton/bigcommerce-api-mcp),
adapted from a local Node.js stdio server into a stateless Worker. The endpoint
is protected by a bearer token so only authorized clients can call it.

## What this fork is for

- Run the BigCommerce MCP tools as an always-on remote connector (no local
  Node process, no Claude Desktop stdio config).
- Keep BigCommerce credentials in **Cloudflare Workers Secrets**, never in code.
- Add store-operations tooling on top of the original read tools:
  daily sales reporting and inventory read/write.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_all_products` | List products (Catalog API v3). |
| `get_all_customers` | List/filter customers (Customers API v3). |
| `get_all_orders` | List/filter orders (Orders API v2). |
| `get_daily_sales` | Sales summary for one HST day: order count, gross/net revenue, AOV, top-5 SKUs by units and by revenue. Excludes Incomplete/Cancelled/Declined/Refunded orders. Input: optional `date` (YYYY-MM-DD, defaults to yesterday in HST). |
| `get_inventory_levels` | Inventory for a list of `skus` (or a `product_id`), including variants. |
| `update_inventory` | Set `inventory_level` for a batch of SKUs. Defaults to `dry_run=true`. Respects BigCommerce rate limits. |

## Install & deploy

### Prerequisites
- [Node.js 18+](https://nodejs.org/) (to run Wrangler locally)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers enabled
- BigCommerce API credentials (Advanced Settings → API Accounts) with
  **Products**, **Orders**, and **Customers** scopes (Modify for `update_inventory`)

### 1. Clone and install
```sh
git clone https://github.com/islandtersha/islandslipper-bigcommerce-api-mcp.git
cd islandslipper-bigcommerce-api-mcp
npm install
```

### 2. Set the required secrets
These are **Workers Secrets** — set once per environment; values are never
stored in the repo or `wrangler.toml`:

```sh
wrangler secret put BC_STORE_HASH      # BigCommerce store hash
wrangler secret put BC_ACCESS_TOKEN    # BigCommerce API access token (X-Auth-Token)
wrangler secret put MCP_AUTH_TOKEN     # Bearer token clients must present to /mcp
```

Generate a strong `MCP_AUTH_TOKEN`, e.g. `openssl rand -hex 32`.

### 3. Deploy
```sh
npm run deploy      # wrangler deploy
```

Wrangler prints your Worker URL. The MCP endpoint is that URL + `/mcp`, e.g.
`https://islandslipper-bc-mcp.<subdomain>.workers.dev/mcp`.

## Connecting a client

Configure the connector with the `/mcp` URL and an Authorization header:

```
Authorization: Bearer <your MCP_AUTH_TOKEN>
```

Every request without a valid bearer token is rejected with `401`. If
`MCP_AUTH_TOKEN` is not set on the Worker, the endpoint fails closed (rejects
all requests).

## Test locally with `wrangler dev`

1. Copy the secrets template and fill in real values (this file is gitignored):
   ```sh
   cp .dev.vars.example .dev.vars
   ```
2. Start the local dev server:
   ```sh
   npm run dev      # wrangler dev — serves http://localhost:8787
   ```
3. Probe it (replace the token with your `.dev.vars` value):
   ```sh
   # Health check (no auth)
   curl http://localhost:8787/health

   # List tools (auth required)
   curl -s http://localhost:8787/mcp \
     -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

   # Call a tool
   curl -s http://localhost:8787/mcp \
     -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_daily_sales","arguments":{}}}'
   ```

Use `npm run tail` (`wrangler tail`) to stream live logs from a deployed Worker.

## Endpoints

| Path | Method | Auth | Description |
| --- | --- | --- | --- |
| `/mcp` | POST | Bearer | MCP Streamable HTTP (JSON-RPC 2.0). |
| `/health` | GET | none | Liveness probe. |
| `/info` | GET | none | Server metadata. |

## Notes

- **Transport:** Streamable HTTP only (no stdio, no SSE). Stateless — no
  sessions or Durable Objects.
- **Credentials:** read from the Worker `env` bindings; there is no `.env`
  file at runtime and no `process.env` in the Worker.
- **Rate limits:** the BigCommerce client honors `Retry-After` /
  `X-Rate-Limit-Time-Reset-Ms` on `429` and backs off automatically;
  `update_inventory` writes sequentially.

## Upstream

Forked from **[isaacgounton/bigcommerce-api-mcp](https://github.com/isaacgounton/bigcommerce-api-mcp)**.

## License

MIT.
