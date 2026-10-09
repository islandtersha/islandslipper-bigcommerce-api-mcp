/**
 * Public made-to-order lead time: GET /lead-time.
 *
 * The storefront PDP reads this to say "Hand Made to Order — Allow N weeks",
 * where N grows with the order backlog (orders not yet shipped). Public and
 * unauthenticated, routed in index.js BEFORE the OAuth provider so /mcp stays
 * exactly as protected as before.
 *
 * Response (never the order count — backlog volume is private):
 *   { "weeks": 8, "message": "Hand Made to Order — Allow 8 weeks",
 *     "updated_at": "2026-10-09T19:00:00.000Z" }
 * plus "fallback": true when no tier could be loaded at all.
 *
 * Freshness: the last result is stored in the LEAD_TIME_KV namespace. A request
 * that finds it older than freshMs recomputes it with ONE BigCommerce call
 * (GET /v2/orders/count returns every status's count at once). The Cache API is
 * not used because it does nothing on *.workers.dev. Worst-case lag is freshMs
 * plus KV propagation (~60s) plus the browser max-age.
 *
 * On a BigCommerce error: serve the last stored result, however old; with none
 * stored, serve the fallback (the longest lead time, never a shorter promise).
 */

import { createBcClient } from "./bc-client.js";

export const LEAD_TIME_PATH = "/lead-time";

/**
 * Everything Tersha may want to tune. Change breakpoints here, not in logic.
 * Tiers are checked in order; the first whose maxOrders >= backlog wins.
 */
export const LEAD_TIME_CONFIG = {
  tiers: [
    { maxOrders: 10, weeks: 3 },
    { maxOrders: 40, weeks: 6 },
    { maxOrders: 100, weeks: 8 },
    { maxOrders: Infinity, weeks: 10 },
  ],
  // Served when no tier can be loaded. Keep it the longest tier.
  fallbackWeeks: 10,
  // BC order status ids counted as "not yet shipped":
  // 1 Pending, 7 Awaiting Payment ("Order Received"),
  // 11 Awaiting Fulfillment ("In Production"), 9 Awaiting Shipment.
  // (8 Awaiting Pickup and 3 Partially Shipped are NOT counted.)
  statusIds: [1, 7, 11, 9],
  // Only count orders created in the last N days. null = all time (off).
  maxOrderAgeDays: null,
  // Recompute when the stored result is older than this.
  freshMs: 5 * 60 * 1000,
  // Browser cache for the response (seconds).
  browserMaxAgeSec: 60,
  allowedOrigins: ["https://shop.islandslipper.com", "http://localhost:3000"],
  kvKey: "lead-time:v1",
};

export function leadTimeMessage(weeks) {
  return `Hand Made to Order — Allow ${weeks} weeks`;
}

/** Map an unshipped-order count to weeks. */
export function weeksForBacklog(count, config = LEAD_TIME_CONFIG) {
  if (!Number.isFinite(count) || count < 0) return config.fallbackWeeks;
  const tier = config.tiers.find((t) => count <= t.maxOrders);
  return tier ? tier.weeks : config.fallbackWeeks;
}

/** Sum the configured statuses from one GET /v2/orders/count call. */
export async function countUnshippedOrders(bc, config = LEAD_TIME_CONFIG, now = new Date()) {
  let path = "/v2/orders/count";
  if (config.maxOrderAgeDays != null) {
    const since = new Date(now.getTime() - config.maxOrderAgeDays * 86400000);
    path += `?min_date_created=${encodeURIComponent(since.toISOString())}`;
  }
  const res = await bc.get(path);
  if (!res || !Array.isArray(res.statuses)) {
    throw new Error("Unexpected /v2/orders/count response: no statuses array");
  }
  let total = 0;
  for (const status of res.statuses) {
    if (!config.statusIds.includes(Number(status.id))) continue;
    const n = Number(status.count);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Unexpected count for order status ${status.id}`);
    }
    total += n;
  }
  return total;
}

/**
 * The public record for the response, or null for anything malformed.
 * Shared by the KV read so a bad stored value is treated as missing.
 */
function toRecord(stored) {
  if (!stored || !Number.isInteger(stored.weeks) || stored.weeks < 1) return null;
  const updated = Date.parse(stored.updated_at);
  if (Number.isNaN(updated)) return null;
  return {
    weeks: stored.weeks,
    message: leadTimeMessage(stored.weeks),
    updated_at: new Date(updated).toISOString(),
  };
}

/**
 * Resolve the current lead time: fresh stored value, else recompute, else the
 * last stored value, else the fallback.
 * @param {object} env Worker env (LEAD_TIME_KV, BC_STORE_HASH, BC_ACCESS_TOKEN)
 * @param {object} ctx Worker ctx (waitUntil); optional
 * @param {object} [deps] test seams: bc, now, config
 */
export async function getLeadTime(env, ctx, { bc, now = new Date(), config = LEAD_TIME_CONFIG } = {}) {
  const kv = env.LEAD_TIME_KV;

  let stored = null;
  if (kv) {
    try {
      stored = toRecord(await kv.get(config.kvKey, "json"));
    } catch (e) {
      console.error(`lead_time status=kv_read_error error=${JSON.stringify(e.message)}`);
    }
  } else {
    console.error("lead_time status=no_kv_binding (LEAD_TIME_KV)");
  }

  if (stored && now.getTime() - Date.parse(stored.updated_at) < config.freshMs) {
    return stored;
  }

  let client;
  try {
    client = bc || createBcClient(env);
    client.toolName = "lead_time";
    const count = await countUnshippedOrders(client, config, now);
    const weeks = weeksForBacklog(count, config);
    const record = { weeks, message: leadTimeMessage(weeks), updated_at: now.toISOString() };

    // Private log only (Workers Logs): the count helps tune breakpoints.
    console.log(`lead_time status=refreshed backlog=${count} weeks=${weeks}`);

    if (kv) {
      const write = kv
        .put(config.kvKey, JSON.stringify({ weeks, updated_at: record.updated_at }))
        .catch((e) => console.error(`lead_time status=kv_write_error error=${JSON.stringify(e.message)}`));
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(write);
      else await write;
    }
    return record;
  } catch (e) {
    console.error(
      `lead_time status=bc_error served=${stored ? "last_stored" : "fallback"} ` +
        `subrequests=${client ? client.subrequestCount : 0} error=${JSON.stringify(e.message)}`
    );
    if (stored) return stored;
    return {
      weeks: config.fallbackWeeks,
      message: leadTimeMessage(config.fallbackWeeks),
      updated_at: now.toISOString(),
      fallback: true,
    };
  }
}

function corsHeaders(request, config) {
  const headers = { Vary: "Origin" };
  const origin = request.headers.get("Origin");
  if (origin && config.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
  }
  return headers;
}

/** fetch handler for /lead-time. */
export async function handleLeadTime(request, env, ctx, deps = {}) {
  const config = deps.config || LEAD_TIME_CONFIG;
  const cors = corsHeaders(request, config);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "Access-Control-Max-Age": "86400" },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...cors, Allow: "GET, HEAD, OPTIONS" },
    });
  }

  const record = await getLeadTime(env, ctx, { ...deps, config });
  return new Response(request.method === "HEAD" ? null : JSON.stringify(record), {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${config.browserMaxAgeSec}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
