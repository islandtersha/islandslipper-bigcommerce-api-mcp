/**
 * Cloudflare Workers entry point for the Island Slipper BigCommerce MCP server.
 *
 * Exposes the MCP server over Streamable HTTP at POST /mcp, protected by a
 * bearer token (MCP_AUTH_TOKEN). Also serves /health and /info for probing.
 */

import { handleMcpMessage, SERVER_NAME, SERVER_VERSION } from "./mcp.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    switch (url.pathname) {
      case "/health":
        return json(
          {
            status: "healthy",
            server: SERVER_NAME,
            version: SERVER_VERSION,
            transport: "streamable-http",
          },
          200
        );

      case "/info":
        return json(
          {
            name: SERVER_NAME,
            version: SERVER_VERSION,
            description:
              "BigCommerce MCP server (Island Slipper fork) for Cloudflare Workers.",
            capabilities: { tools: {} },
            transport: "streamable-http",
            endpoint: "/mcp",
          },
          200
        );

      case "/mcp":
        return handleMcp(request, env);

      default:
        return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    }
  },
};

async function handleMcp(request, env) {
  if (request.method !== "POST") {
    return rpcError(null, -32000, "Method not allowed; use POST for /mcp.", 405);
  }

  const authFailure = checkAuth(request, env);
  if (authFailure) return authFailure;

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
    // If the batch was all notifications, there is nothing to return.
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
}

/**
 * Bearer-token gate. Fails closed: if MCP_AUTH_TOKEN is not configured, all
 * requests are rejected (this is a public URL).
 * @returns a Response to short-circuit with, or null when the request is allowed.
 */
function checkAuth(request, env) {
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) {
    return rpcError(
      null,
      -32001,
      "Server auth is not configured (MCP_AUTH_TOKEN secret missing).",
      503
    );
  }

  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) {
    return rpcError(
      null,
      -32001,
      "Unauthorized: missing or malformed Authorization header.",
      401
    );
  }

  const token = header.slice("Bearer ".length);
  if (!timingSafeEqual(token, expected)) {
    return rpcError(null, -32001, "Unauthorized: invalid token.", 401);
  }

  return null;
}

/** Constant-time string comparison to avoid leaking the token via timing. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function rpcError(id, code, message, status) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}
