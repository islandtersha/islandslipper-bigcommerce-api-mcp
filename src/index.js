/**
 * Cloudflare Workers entry point for the Island Slipper BigCommerce MCP server.
 *
 * The MCP endpoint is exposed over Streamable HTTP at /mcp and protected by
 * OAuth 2.0 via @cloudflare/workers-oauth-provider. The provider transparently
 * implements the endpoints a remote MCP client needs to complete Dynamic Client
 * Registration and the authorization code flow:
 *
 *   /.well-known/oauth-authorization-server  (RFC 8414 metadata)  — provider
 *   /register                                (RFC 7591 DCR)        — provider
 *   /token                                   (token exchange)      — provider
 *   /authorize                               (approval UI)         — defaultHandler
 *   /mcp                                     (protected API)       — apiHandler
 *
 * The provider validates the OAuth access token for /mcp before delegating to
 * mcpApiHandler. Everything else (including public /health and /info, and the
 * /authorize approval flow) is handled by defaultHandler.
 *
 * OAuth client registrations and tokens are stored in the OAUTH_KV namespace
 * bound in wrangler.toml. The MCP_AUTH_TOKEN secret is the master key an
 * operator pastes at /authorize to approve a new client.
 *
 * GET /lead-time (public made-to-order lead time for the storefront, see
 * lead-time.js) is answered here BEFORE the provider, so it never touches the
 * OAuth layer and /mcp keeps its protection unchanged.
 *
 * The `scheduled` handler runs the daily New Arrivals sync (cron in
 * wrangler.toml), which writes only when NEW_ARRIVALS_LIVE is "true".
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { mcpApiHandler } from "./mcp-api-handler.js";
import { defaultHandler } from "./auth-handler.js";
import { runScheduledNewArrivalsSync } from "./scheduled.js";
import { LEAD_TIME_PATH, handleLeadTime } from "./lead-time.js";

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
});

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === LEAD_TIME_PATH) {
      return handleLeadTime(request, env, ctx);
    }
    return provider.fetch(request, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledNewArrivalsSync(env));
  },
};
