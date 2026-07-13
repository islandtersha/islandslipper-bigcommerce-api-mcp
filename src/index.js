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
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { mcpApiHandler } from "./mcp-api-handler.js";
import { defaultHandler } from "./auth-handler.js";

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
});
