/**
 * Default (non-API) request handler for the OAuth provider.
 *
 * Responsibilities:
 *   - GET  /health, /info      → public, unauthenticated metadata
 *   - GET  /authorize          → render the Island Slipper approval page
 *   - POST /authorize          → verify the master token, then complete the
 *                                OAuth authorization and redirect back
 *
 * The OAuth provider itself serves /.well-known/oauth-authorization-server,
 * /token, and /register — those never reach this handler.
 *
 * SECURITY: approving a new OAuth client requires pasting the master token,
 * which is compared in constant time against env.MCP_AUTH_TOKEN. If that secret
 * is unset the endpoint fails closed. All dynamic values are HTML-escaped.
 */

import { SERVER_NAME, SERVER_VERSION } from "./mcp.js";

export const defaultHandler = {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/health":
        return json({
          status: "healthy",
          server: SERVER_NAME,
          version: SERVER_VERSION,
          transport: "streamable-http",
          auth: "oauth2",
        });

      case "/info":
        return json({
          name: SERVER_NAME,
          version: SERVER_VERSION,
          description:
            "BigCommerce MCP server (Island Slipper fork) for Cloudflare Workers.",
          capabilities: { tools: {} },
          transport: "streamable-http",
          endpoint: "/mcp",
          auth: "oauth2",
        });

      case "/authorize":
        if (request.method === "GET") return renderAuthorizePage(request, env);
        if (request.method === "POST") return handleApproval(request, env);
        return new Response("Method not allowed", { status: 405 });

      default:
        return new Response("Not found", { status: 404 });
    }
  },
};

// --- /authorize: render -----------------------------------------------------

async function renderAuthorizePage(request, env) {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!oauthReqInfo || !oauthReqInfo.clientId) {
    return htmlResponse(errorPage("Invalid authorization request."), 400);
  }

  let clientName = oauthReqInfo.clientId;
  try {
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
    clientName =
      client?.clientName || client?.client_name || oauthReqInfo.clientId;
  } catch {
    // Fall back to the client id if lookup fails.
  }

  const state = encodeState(oauthReqInfo);
  return htmlResponse(approvalPage({ clientName, state, error: null }));
}

// --- /authorize: approve ----------------------------------------------------

async function handleApproval(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return htmlResponse(errorPage("Malformed form submission."), 400);
  }

  const token = form.get("mcp_token");
  const stateRaw = form.get("state");

  let oauthReqInfo;
  try {
    oauthReqInfo = decodeState(stateRaw);
  } catch {
    return htmlResponse(errorPage("Malformed authorization state."), 400);
  }
  if (!oauthReqInfo || !oauthReqInfo.clientId) {
    return htmlResponse(errorPage("Invalid authorization request."), 400);
  }

  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) {
    // Fail closed: never approve a client if no master token is configured.
    return htmlResponse(
      errorPage("Server auth is not configured (MCP_AUTH_TOKEN is missing)."),
      503
    );
  }

  if (typeof token !== "string" || !timingSafeEqual(token, expected)) {
    return htmlResponse(
      approvalPage({
        clientName: oauthReqInfo.clientId,
        state: encodeState(oauthReqInfo),
        error: "That token is incorrect. Please try again.",
      }),
      401
    );
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: "island-slipper-operator",
    metadata: { label: "Island Slipper MCP" },
    scope: oauthReqInfo.scope || [],
    props: { authorizedAt: new Date().toISOString() },
  });

  return Response.redirect(redirectTo, 302);
}

// --- HTML ------------------------------------------------------------------

function approvalPage({ clientName, state, error }) {
  const safeClient = escapeHtml(clientName);
  const safeState = escapeHtml(state);
  const errorBlock = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Authorize · Island Slipper MCP</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #143851;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 24px;
  }
  .card {
    background: #ffffff;
    color: #1a2a33;
    width: 100%;
    max-width: 420px;
    padding: 32px;
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
    text-align: center;
  }
  h1 { font-size: 20px; margin: 0 0 4px; color: #143851; }
  .sub { font-size: 14px; color: #5a6b75; margin: 0 0 20px; }
  .note {
    font-size: 13px;
    line-height: 1.5;
    color: #40525c;
    background: #eef3f6;
    border-radius: 8px;
    padding: 12px 14px;
    text-align: left;
    margin: 0 0 20px;
  }
  .note strong { color: #143851; }
  label { display: block; text-align: left; font-size: 13px; font-weight: 600; margin: 0 0 6px; color: #143851; }
  input[type="password"] {
    width: 100%;
    padding: 11px 12px;
    font-size: 15px;
    border: 1px solid #c3d0d8;
    border-radius: 8px;
    margin: 0 0 16px;
  }
  input[type="password"]:focus { outline: none; border-color: #143851; box-shadow: 0 0 0 3px rgba(20, 56, 81, 0.15); }
  button {
    width: 100%;
    padding: 12px;
    font-size: 15px;
    font-weight: 600;
    color: #ffffff;
    background: #143851;
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover { background: #1d4d6e; }
  .error { color: #b3261e; font-size: 13px; margin: 0 0 14px; text-align: left; }
  .client { font-weight: 600; color: #143851; word-break: break-all; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorize access</h1>
    <p class="sub">Island Slipper BigCommerce MCP</p>
    <p class="note">
      The client <span class="client">${safeClient}</span> is requesting access to this
      MCP server, which can read <strong>orders, customers, products, sales, and
      inventory</strong> and can <strong>update inventory levels</strong>.
      To approve, paste your MCP Auth Token below. Only approve clients you trust.
    </p>
    ${errorBlock}
    <form method="POST" action="/authorize" autocomplete="off">
      <input type="hidden" name="state" value="${safeState}" />
      <label for="mcp_token">MCP Auth Token</label>
      <input id="mcp_token" name="mcp_token" type="password" required autofocus
             placeholder="Paste your MCP Auth Token" />
      <button type="submit">Authorize this client</button>
    </form>
  </div>
</body>
</html>`;
}

function errorPage(message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorization error · Island Slipper MCP</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #143851; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 24px;
  }
  .card {
    background: #ffffff; color: #1a2a33; max-width: 420px; width: 100%;
    padding: 32px; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); text-align: center;
  }
  h1 { font-size: 18px; color: #b3261e; margin: 0 0 8px; }
  p { font-size: 14px; color: #40525c; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorization error</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

// --- helpers ---------------------------------------------------------------

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

/** UTF-8-safe base64 encode of the oauth request info for the hidden field. */
function encodeState(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeState(str) {
  if (typeof str !== "string" || str === "") throw new Error("empty state");
  const bin = atob(str);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
