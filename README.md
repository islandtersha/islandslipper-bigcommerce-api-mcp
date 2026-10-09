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
  daily sales reporting, inventory read/write, and the New Arrivals sync.

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
| `get_categories` | Full category tree with breadcrumb paths; optional product counts and hidden-category pruning. |
| `audit_new_arrivals` | Read-only report of what the New Arrivals sync would do. See [New Arrivals sync](#new-arrivals-sync). |
| `sync_new_arrivals` | Sync the New Arrivals category with the launch-date rule. Defaults to `dry_run=true`. |
| `set_launch_date` | Set only the `~launch_date` custom field on up to 43 products. Defaults to `dry_run=true`. |

## New Arrivals sync

The homepage "New" section used BigCommerce's built-in New Products panel,
which sorts by `date_created`. Splitting a legacy parent into one product per
color creates new products, so years-old colors showed up as New. This job
keeps category **114 (Featured > New, `/featured/new`)** in step with each
product's real launch date instead.

### The rule

- **Effective launch date** = the `~launch_date` custom field (`YYYY-MM-DD`)
  when it is present and valid; otherwise `date_created` as a Hawaii (HST)
  calendar date. Surrounding spaces are trimmed; anything that isn't a real
  `YYYY-MM-DD` date counts as missing and is flagged by the audit.
- **New** = launched 0–59 days ago in HST (`NEW_ARRIVALS_WINDOW_DAYS`, default
  60). A future date isn't new yet.
- **Eligible** = visible, and not in any `NEW_ARRIVALS_EXCLUDE_CATEGORY_IDS`
  category (Last Call and the Vault tree).
- **Category contents** = every eligible new product. If that's fewer than 4,
  it's topped up with the most recently launched eligible products (never
  future-dated ones).
- **Order** = newest launch date first; ties go to the higher product ID.
- **Men's / women's subsets**: category **115 (New Men's Footwear)** gets the
  products in 114 that are also in **Men (1)** or any of its subcategories.
  Category **116 (New Women's Footwear)** works the same way for **Women (3)**.
  Unisex products in both trees go in both. Products in neither tree stay in
  114 only; the audit and sync list them under
  `warnings.outside_men_women_trees` (and the cron logs `outside_trees=N`) so
  their categories can be fixed in BC admin. 115 and 116 aren't topped up, because category pages also show
  products from child categories, so they can be empty. They use 114's order.
- When splitting a color off a parent, set `~launch_date` to the **original**
  color's launch date (use `2020-01-01` for legacy styles with unknown dates).

The rule lives in one place, [`src/lib/new-arrivals.js`](src/lib/new-arrivals.js),
and is covered by `npm test`.

### What the sync changes

- For each of 114, 115 and 116 it adds missing products, removes stale ones
  **from that category only**, and sets that category's sort order. A
  product's other categories are never touched. It writes 114 first, then 115,
  then 116.
- Each category's default sort must be **Featured** in BC admin, or the sort
  order the sync sets won't control what shoppers see. The audit warns if it isn't.
- Safety checks, for each category: before any delete, it reads the assignments
  with the exact same filter and refuses unless they match. All of these checks
  run before the first write. It refuses to run on an empty catalog read or an
  empty 114 target set (an empty 115 or 116 is fine). It refuses if a root
  category is missing or if a managed category sits inside the Men or Women
  tree. It checks the subrequest budget for all three categories before the
  first write. It reads each written category back after a live run.
- A day with no catalog changes sends no writes.

### Settings (`[vars]` in `wrangler.toml`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEW_ARRIVALS_CATEGORY_ID` | `114` | The New Arrivals category the sync manages. |
| `NEW_ARRIVALS_MENS_CATEGORY_ID` | `115` | New Men's Footwear: 114's products in the Men tree. |
| `NEW_ARRIVALS_WOMENS_CATEGORY_ID` | `116` | New Women's Footwear: 114's products in the Women tree. |
| `MENS_ROOT_CATEGORY_ID` | `1` | Root of the Men tree (it and every subcategory count). |
| `WOMENS_ROOT_CATEGORY_ID` | `3` | Root of the Women tree (it and every subcategory count). |
| `NEW_ARRIVALS_EXCLUDE_CATEGORY_IDS` | `113,83,84,85` | Never included: Last Call (113) and the Vault tree (83–85). |
| `NEW_ARRIVALS_WINDOW_DAYS` | `60` | How many days a product counts as new. |
| `NEW_ARRIVALS_LIVE` | `false` | The daily cron writes only when this is exactly `true`. |

`wrangler deploy` resets these to the values in `wrangler.toml`, so change them
there and redeploy. A dashboard edit would be overwritten on the next deploy.

### Daily cron

Runs at 15:00 UTC (5:00 AM HST) and calls the same sync. Unless
`NEW_ARRIVALS_LIVE` is exactly `"true"` it runs as a dry run. Each run writes
one line to Workers Logs, e.g.
`new_arrivals_sync mode=live status=ok date=2026-10-08 cat114=target:5,added:1,removed:1,sort_changed:true cat115=… cat116=… outside_trees=0 writes=7 subrequests=14`.
A failed run logs `status=error` and shows as failed in the Cloudflare dashboard.

### Running it (in Claude, through the connector)

1. **Audit:** `audit_new_arrivals`. This is read-only.
2. **Set launch dates** where needed: `set_launch_date` with
   `updates: [{ product_id, launch_date }]`. Check the dry run, then repeat with
   `dry_run: false`.
3. **Dry run:** `sync_new_arrivals`. It defaults to `dry_run: true` and shows the
   exact add, remove, and sort-order requests for 114, 115 and 116.
4. **Live run:** `sync_new_arrivals` with `dry_run: false`. Check `/featured/new`
   and the two subcategory pages.
5. **Turn on the daily cron:** set `NEW_ARRIVALS_LIVE = "true"` in
   `wrangler.toml`, commit, and redeploy.

New tools appear only after you **disconnect and reconnect** the connector in
Claude; tool lists are read when the connector connects.

### Rolling back

1. Set `NEW_ARRIVALS_LIVE` to anything other than `"true"` (e.g. `"false"`) in
   `wrangler.toml` and redeploy. The cron goes back to dry runs.
2. If needed, empty categories 114, 115 and 116 (or restore their old
   products) in BC admin.

`~launch_date` values written by `set_launch_date` can be edited or deleted
on the product in BC admin.

### PowerShell (Windows)

```powershell
# Deploy (from an up-to-date main)
git checkout main
git pull
npx wrangler deploy

# Confirm the deployed version and watch the cron's log line
npx wrangler deployments list
npx wrangler tail --format pretty

# Run the cron locally as a dry run (NEW_ARRIVALS_LIVE is "false" in wrangler.toml)
npx wrangler dev --test-scheduled
# in a second PowerShell window:
curl.exe "http://localhost:8787/__scheduled?cron=0+15+*+*+*"

# Unit tests
npm test
```

No new secrets are needed. The settings above are plain `[vars]`, and
`set_launch_date` / `sync_new_arrivals` use the existing `BC_ACCESS_TOKEN`,
which needs the **Products: modify** scope.

## Made-to-order lead time (`/lead-time`)

Public endpoint the storefront PDP reads to say "Hand Made to Order — Allow N
weeks". N comes from the count of BigCommerce orders not yet shipped:

| Unshipped orders | Weeks |
| --- | --- |
| 0–10 | 3 |
| 11–40 | 6 |
| 41–100 | 8 |
| 101+ | 10 |

```json
{ "weeks": 8, "message": "Hand Made to Order — Allow 8 weeks", "updated_at": "2026-10-09T19:00:00.000Z" }
```

- **Never returns the order count.** The count is only logged (Workers Logs).
- **Settings** (breakpoints, counted status ids, optional order-age window,
  freshness, CORS origins) live in `LEAD_TIME_CONFIG` in `src/lead-time.js`.
- **Freshness:** the last result is stored in the `LEAD_TIME_KV` namespace and
  recomputed with one BigCommerce call (`GET /v2/orders/count`) once it is
  5 minutes old. Browsers may cache the response for 60 seconds.
- **On a BigCommerce error** it serves the last stored result; with none stored,
  the longest lead time (10 weeks) with `"fallback": true`.
- **CORS:** `https://shop.islandslipper.com` and `http://localhost:3000`.
- The BigCommerce token needs the **Orders: read-only** scope (already required).

## Install & deploy

### Prerequisites
- [Node.js 18+](https://nodejs.org/) (to run Wrangler locally)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers enabled
- BigCommerce API credentials (Advanced Settings → API Accounts) with
  **Products**, **Orders**, and **Customers** scopes (Products: modify for
  `update_inventory`, `sync_new_arrivals`, and `set_launch_date`)

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
| `/lead-time` | GET | none | Made-to-order lead time for the storefront (see below). |

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
SKU lookups, the write itself, and read-back verification all count
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

## Upstream

Forked from **[isaacgounton/bigcommerce-api-mcp](https://github.com/isaacgounton/bigcommerce-api-mcp)**.

## License

MIT.
