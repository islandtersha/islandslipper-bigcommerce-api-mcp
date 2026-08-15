# Island Slipper BigCommerce MCP (Cloudflare Workers)

A [Model Context Protocol](https://modelcontextprotocol.io/) server for the
Island Slipper BigCommerce store, running on **Cloudflare Workers** and reachable
as a **remote MCP connector** (Claude / Cowork) over **Streamable HTTP**.

This is a fork of [isaacgounton/bigcommerce-api-mcp](https://github.com/isaacgounton/bigcommerce-api-mcp),
adapted from a local Node.js stdio server into a stateless Worker. The `/mcp`
endpoint is protected by **OAuth 2.0** (via
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)),
which is what Claude's custom connector requires — Dynamic Client Registration
plus the authorization code flow. A single **master token** (`MCP_AUTH_TOKEN`)
is pasted once per client to approve it.

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
| `get_daily_sales` | Daily P&L for one HST day: order count, subtotal, shipping, tax, discounts, gross/refund/net revenue, AOV, and top-5 SKUs by units and by revenue. Excludes Incomplete/Cancelled/Declined/Refunded orders. Input: optional `date` (YYYY-MM-DD, defaults to yesterday in HST). |
| `get_refunds_summary` | Refund activity over an HST date window: refund count/total, unique orders refunded, avg days from order to refund, breakdown by original-order month, and top-10 refunds. Input: `start_date` (required), optional `end_date` (defaults to today in HST). |
| `get_inventory_levels` | Inventory for a list of `skus` (or a `product_id`), including variants. |
| `update_inventory` | Set `inventory_level` for a batch of SKUs. Defaults to `dry_run=true`. Respects BigCommerce rate limits. |
| `update_product` | Update one product's `name`, `description`, and/or `is_visible`. Defaults to `dry_run=true`. **URL changes are not supported** — see below. |

### `update_product` — URL handling

`update_product` changes only `name`, `description`, and `is_visible`. It does
**not** write product URLs:

- `updates.url` (at any depth) and the old `allow_url_regeneration` argument are
  **rejected** with a clear error. BigCommerce's V3 Catalog API does not create a
  301 redirect when a URL changes (only the BC admin UI does), so an API-driven
  URL change would silently break the indexed link with no recovery.
- On **every rename** the product's existing `custom_url` is pinned back —
  `url` kept **byte-identical**, `is_customized` set `true` — in the same PUT, so
  BigCommerce never regenerates the slug from the new name. That pin is the
  enforcement mechanism for the never-change-the-URL invariant.
- A rename of a product that has **no `custom_url` to pin** returns
  `status: "refused"` (there is no escape hatch — set the URL in BC admin first).
- On a live rename the read-back verifies the URL did not move; a move is an
  **invariant violation** and a hard error.

**Reversibility:** URL changes are intentionally not supported. If MCP Tool 4
(`set_redirect`) ships, `updates.url` can return to this tool paired with an
automatic 301. Until then this invariant holds.

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

This installs `@cloudflare/workers-oauth-provider` (the OAuth layer) and
`wrangler` (the deploy CLI).

### 2. Create the OAuth KV namespace
The OAuth provider stores client registrations and tokens in a Workers KV
namespace that **must** be bound as `OAUTH_KV`. Create it (and a preview
namespace for `wrangler dev`), then paste the returned IDs into
`wrangler.toml`:

```sh
wrangler kv namespace create OAUTH_KV
wrangler kv namespace create OAUTH_KV --preview
```

Each command prints an ID. Put them in the `[[kv_namespaces]]` block of
`wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<id from the first command>"
preview_id = "<preview_id from the second command>"
```

### 3. Set the required secrets
These are **Workers Secrets** — set once per environment; values are never
stored in the repo or `wrangler.toml`:

```sh
wrangler secret put BC_STORE_HASH      # BigCommerce store hash
wrangler secret put BC_ACCESS_TOKEN    # BigCommerce API access token (X-Auth-Token)
wrangler secret put MCP_AUTH_TOKEN     # Master key: pasted at /authorize to approve clients
```

Generate a strong `MCP_AUTH_TOKEN`, e.g. `openssl rand -hex 32`.

### 4. Deploy
```sh
npm run deploy      # wrangler deploy
```

Wrangler prints your Worker URL. The MCP endpoint is that URL + `/mcp`, e.g.
`https://islandslipper-bc-mcp.<subdomain>.workers.dev/mcp`.

## Connecting a client (OAuth)

Add the Worker's `/mcp` URL as a **custom connector** in Claude. No API key
field is needed — the connector discovers the OAuth endpoints automatically and
walks the flow:

1. Claude reads `/.well-known/oauth-authorization-server` and registers itself
   via `/register` (Dynamic Client Registration).
2. Claude opens `/authorize` in your browser. You'll see the Island Slipper
   approval page: **paste your `MCP_AUTH_TOKEN`** to approve this client.
3. On success you're redirected back and Claude exchanges the code at `/token`
   for an access token, which it uses on every `/mcp` request.

The `MCP_AUTH_TOKEN` is the **master key**: it isn't sent on API calls, it only
approves new clients at the `/authorize` step. If `MCP_AUTH_TOKEN` is not set on
the Worker, approval fails closed (no client can be authorized). An incorrect
token is rejected with a clear error on the approval page.

## Test locally with `wrangler dev`

1. Copy the secrets template and fill in real values (this file is gitignored):
   ```sh
   cp .dev.vars.example .dev.vars
   ```
2. `wrangler dev` needs a **preview** KV namespace — make sure `preview_id` is
   filled in (step 2 of setup). Then start the dev server:
   ```sh
   npm run dev      # wrangler dev — serves http://localhost:8787
   ```
3. Probe the public endpoints (no auth):
   ```sh
   curl http://localhost:8787/health
   curl http://localhost:8787/.well-known/oauth-authorization-server
   ```
4. `/mcp` now requires an **OAuth access token**, so it can't be called with a
   raw bearer token via curl. Test it by adding the local `http://localhost:8787/mcp`
   URL as a custom connector in an MCP client (e.g. the
   [MCP Inspector](https://github.com/modelcontextprotocol/inspector)) and
   completing the OAuth flow — pasting your `.dev.vars` `MCP_AUTH_TOKEN` on the
   approval page.

Use `npm run tail` (`wrangler tail`) to stream live logs from a deployed Worker.

## Endpoints

| Path | Method | Auth | Description |
| --- | --- | --- | --- |
| `/mcp` | POST | OAuth access token | MCP Streamable HTTP (JSON-RPC 2.0). |
| `/authorize` | GET/POST | Master token (on POST) | Approval page; approve a client by pasting `MCP_AUTH_TOKEN`. |
| `/token` | POST | OAuth | Token exchange (served by the OAuth provider). |
| `/register` | POST | none | Dynamic Client Registration (RFC 7591). |
| `/.well-known/oauth-authorization-server` | GET | none | OAuth metadata discovery (RFC 8414). |
| `/health` | GET | none | Liveness probe. |
| `/info` | GET | none | Server metadata. |

## Notes

- **Transport:** Streamable HTTP only (no stdio, no SSE). Stateless — no
  sessions or Durable Objects (OAuth state lives in the `OAUTH_KV` namespace).
- **Auth:** `/mcp` is gated by the OAuth provider; the `MCP_AUTH_TOKEN` master
  key is only used to approve clients at `/authorize`.
- **Credentials:** read from the Worker `env` bindings; there is no `.env`
  file at runtime and no `process.env` in the Worker.
- **Rate limits:** the BigCommerce client honors `Retry-After` /
  `X-Rate-Limit-Time-Reset-Ms` on `429` and backs off automatically;
  `update_inventory` writes sequentially.

## Subrequest budget (tool authors)

Cloudflare Workers cap **outbound subrequests per incoming request**. On the
**Free plan** the hard ceiling is **50**; once a request crosses it the Worker
aborts opaquely, mid-tool, with no usable error.

The budget is **per REQUEST, not per helper**. Every `bc.get` / `bc.put` in a
single `tools/call` draws from the same pool — a category-tree sweep, the
`resolveProduct` lookup, the write itself, and read-back verification all count
together. A guard that only watches its own calls (e.g. `fetchAllPages`
counting pages) can therefore report itself within limits while the request as
a whole blows the ceiling.

To keep this visible and fail cleanly:

- The request-scoped `bc` client carries a shared `subrequestCount`, incremented
  on every ACTUAL fetch — the first attempt **and each 429 retry** (a retry is a
  real Cloudflare subrequest). When it reaches `SUBREQUEST_SOFT_CAP` (45, set
  below 50 as margin against Cloudflare's opaque abort — not as an allowance for
  uncounted retries), the next fetch throws a clear error naming the tool and the
  count instead of letting Cloudflare abort. The error distinguishes the
  pre-flight case (over-fetching → narrow the query) from exhaustion mid-retry
  (the store is being throttled → back off), and carries
  `code = "SUBREQUEST_BUDGET_EXHAUSTED"` so the dispatcher can report it
  distinctly from a transient BigCommerce error.
- `fetchAllPages` consults that shared counter in addition to its own `maxPages`
  cap, so a sweep that runs after other subrequests stops early.

**Any new tool that does a full-tree sweep AND per-item work must budget for
both** — estimate `pages + per_item_calls × items + fixed overhead` against 45,
and split the work across calls (or paginate more narrowly) if it won't fit.

Upgrading to a **paid Workers plan raises the ceiling to 1000**; at that point
`fetchAllPages`'s `maxPages` default can go back up and `SUBREQUEST_SOFT_CAP`
can be raised accordingly.

## Known gaps

- `update_product` accepts one product at a time. Batch form deferred until
  whole-style retirement work.

## Upstream

Forked from **[isaacgounton/bigcommerce-api-mcp](https://github.com/isaacgounton/bigcommerce-api-mcp)**.

## License

MIT.
