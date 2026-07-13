/**
 * OAuth-protected MCP API handler.
 *
 * @cloudflare/workers-oauth-provider validates the Bearer access token for the
 * `apiRoute` (/mcp) BEFORE this handler runs, so there is NO token check here —
 * reaching this code already means the request is authenticated. The granted
 * OAuth props are available on `ctx.props`.
 *
 * This handler only speaks the MCP Streamable HTTP wire protocol: parse the
 * JSON-RPC body, dispatch it, and return the JSON-RPC response.
 */

import { handleMcpMessage } from "./mcp.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export const mcpApiHandler = {
  async fetch(request, env, _ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return rpcError(null, -32000, "Method not allowed; use POST for /mcp.", 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return rpcError(null, -32700, "Parse error: invalid JSON.", 400);
    }

    // JSON-RPC batch support.
    if (Array.isArray(body)) {
      const responses = [];
      for (const message of body) {
        const response = await handleMcpMessage(message, env);
        if (response) responses.push(response);
      }
      if (responses.length === 0) {
        return new Response(null, { status: 202, headers: CORS_HEADERS });
      }
      return json(responses, 200);
    }

    const response = await handleMcpMessage(body, env);
    if (response === null) {
      // Notification: acknowledge with no body.
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }
    return json(response, 200);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function rpcError(id, code, message, status) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}
