import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LEAD_TIME_CONFIG,
  weeksForBacklog,
  countUnshippedOrders,
  getLeadTime,
  handleLeadTime,
} from "../src/lead-time.js";

const NOW = new Date("2026-10-09T19:00:00Z");
const MIN = 60 * 1000;

/** BC /v2/orders/count shape. Unshipped (1,7,11,9) here sum to `unshipped`. */
function countsResponse(unshipped) {
  return {
    count: 99999,
    statuses: [
      { id: 0, name: "Incomplete", count: 427 },
      { id: 1, name: "Pending", count: 0 },
      { id: 7, name: "Awaiting Payment", count: 0 },
      { id: 11, name: "Awaiting Fulfillment", count: unshipped },
      { id: 9, name: "Awaiting Shipment", count: 0 },
      { id: 8, name: "Awaiting Pickup", count: 4 },
      { id: 3, name: "Partially Shipped", count: 4 },
      { id: 2, name: "Shipped", count: 37833 },
    ],
  };
}

function fakeBc(response) {
  return {
    subrequestCount: 0,
    paths: [],
    async get(path) {
      this.subrequestCount++;
      this.paths.push(path);
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
  };
}

function fakeKv(initial) {
  const store = new Map();
  if (initial !== undefined) store.set(LEAD_TIME_CONFIG.kvKey, JSON.stringify(initial));
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p) };
}

function quiet(fn) {
  return async () => {
    const { log, error } = console;
    console.log = () => {};
    console.error = () => {};
    try {
      await fn();
    } finally {
      console.log = log;
      console.error = error;
    }
  };
}

// --- Tier mapping -----------------------------------------------------------

test("tier mapping at every breakpoint", () => {
  const cases = [
    [0, 3], [10, 3],
    [11, 6], [40, 6],
    [41, 8], [100, 8],
    [101, 10], [5000, 10],
  ];
  for (const [count, weeks] of cases) {
    assert.equal(weeksForBacklog(count), weeks, `backlog ${count}`);
  }
});

test("tier mapping: nonsense counts get the fallback", () => {
  for (const bad of [NaN, -1, Infinity, undefined]) {
    assert.equal(weeksForBacklog(bad), LEAD_TIME_CONFIG.fallbackWeeks);
  }
});

test("config: fallback is the longest tier", () => {
  const longest = Math.max(...LEAD_TIME_CONFIG.tiers.map((t) => t.weeks));
  assert.equal(LEAD_TIME_CONFIG.fallbackWeeks, longest);
});

// --- Counting ---------------------------------------------------------------

test("counts only the configured statuses, with one BC call and no date filter", async () => {
  const bc = fakeBc({
    statuses: [
      { id: 1, count: 1 }, { id: 7, count: 4 }, { id: 11, count: 76 }, { id: 9, count: 2 },
      { id: 8, count: 4 }, { id: 3, count: 4 }, { id: 0, count: 427 }, { id: 14, count: 1143 },
    ],
  });
  assert.equal(await countUnshippedOrders(bc), 83);
  assert.deepEqual(bc.paths, ["/v2/orders/count"]);
});

test("age window, when turned on, adds min_date_created", async () => {
  const bc = fakeBc(countsResponse(5));
  const config = { ...LEAD_TIME_CONFIG, maxOrderAgeDays: 180 };
  await countUnshippedOrders(bc, config, NOW);
  assert.equal(bc.paths[0], `/v2/orders/count?min_date_created=${encodeURIComponent("2026-04-12T19:00:00.000Z")}`);
});

test("malformed count response is an error, not zero orders", async () => {
  await assert.rejects(countUnshippedOrders(fakeBc({ count: 3 })), /no statuses array/);
  await assert.rejects(
    countUnshippedOrders(fakeBc({ statuses: [{ id: 11, count: "lots" }] })),
    /Unexpected count/
  );
});

// --- getLeadTime: freshness, storage, failure --------------------------------

test("computes, returns the tier without the count, and stores it", quiet(async () => {
  const kv = fakeKv();
  const ctx = fakeCtx();
  const result = await getLeadTime({ LEAD_TIME_KV: kv }, ctx, { bc: fakeBc(countsResponse(88)), now: NOW });
  assert.deepEqual(result, {
    weeks: 8,
    message: "Hand Made to Order — Allow 8 weeks",
    updated_at: "2026-10-09T19:00:00.000Z",
  });
  await Promise.all(ctx.pending);
  assert.deepEqual(JSON.parse(kv.store.get(LEAD_TIME_CONFIG.kvKey)), {
    weeks: 8,
    updated_at: "2026-10-09T19:00:00.000Z",
  });
}));

test("fresh stored value is served without calling BC", quiet(async () => {
  const kv = fakeKv({ weeks: 6, updated_at: "2026-10-09T18:56:00.000Z" }); // 4 min old
  const bc = fakeBc(countsResponse(500));
  const result = await getLeadTime({ LEAD_TIME_KV: kv }, fakeCtx(), { bc, now: NOW });
  assert.equal(result.weeks, 6);
  assert.equal(result.updated_at, "2026-10-09T18:56:00.000Z");
  assert.equal(bc.subrequestCount, 0);
}));

test("stale stored value (5+ min) is recomputed", quiet(async () => {
  const kv = fakeKv({ weeks: 6, updated_at: new Date(NOW - 5 * MIN).toISOString() });
  const bc = fakeBc(countsResponse(150));
  const result = await getLeadTime({ LEAD_TIME_KV: kv }, fakeCtx(), { bc, now: NOW });
  assert.equal(result.weeks, 10);
  assert.equal(result.updated_at, NOW.toISOString());
  assert.equal(bc.subrequestCount, 1);
}));

test("BC failure with a stored value serves the stored value, however old", quiet(async () => {
  const kv = fakeKv({ weeks: 6, updated_at: "2026-10-01T00:00:00.000Z" });
  const result = await getLeadTime({ LEAD_TIME_KV: kv }, fakeCtx(), {
    bc: fakeBc(new Error("HTTP 500")),
    now: NOW,
  });
  assert.deepEqual(result, {
    weeks: 6,
    message: "Hand Made to Order — Allow 6 weeks",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(JSON.parse(kv.store.get(LEAD_TIME_CONFIG.kvKey)).weeks, 6, "stored value untouched");
}));

test("BC failure with nothing stored serves the 10-week fallback", quiet(async () => {
  const kv = fakeKv();
  const result = await getLeadTime({ LEAD_TIME_KV: kv }, fakeCtx(), {
    bc: fakeBc(new Error("HTTP 500")),
    now: NOW,
  });
  assert.deepEqual(result, {
    weeks: 10,
    message: "Hand Made to Order — Allow 10 weeks",
    updated_at: NOW.toISOString(),
    fallback: true,
  });
  assert.equal(kv.store.size, 0, "fallback is never stored");
}));

test("missing BC secrets serve the fallback", quiet(async () => {
  const result = await getLeadTime({ LEAD_TIME_KV: fakeKv() }, fakeCtx(), { now: NOW });
  assert.equal(result.fallback, true);
  assert.equal(result.weeks, 10);
}));

test("garbage in KV is ignored and recomputed", quiet(async () => {
  const kv = fakeKv({ weeks: "eight", updated_at: "nope" });
  const result = await getLeadTime({ LEAD_TIME_KV: kv }, fakeCtx(), { bc: fakeBc(countsResponse(3)), now: NOW });
  assert.equal(result.weeks, 3);
}));

test("KV read error or missing binding still answers", quiet(async () => {
  const brokenKv = { get: async () => { throw new Error("kv down"); }, put: async () => {} };
  const a = await getLeadTime({ LEAD_TIME_KV: brokenKv }, fakeCtx(), { bc: fakeBc(countsResponse(20)), now: NOW });
  assert.equal(a.weeks, 6);
  const b = await getLeadTime({}, fakeCtx(), { bc: fakeBc(countsResponse(20)), now: NOW });
  assert.equal(b.weeks, 6);
}));

// --- HTTP handler -----------------------------------------------------------

const URL_ = "https://worker.example/lead-time";

test("GET: JSON, browser cache header, no order count anywhere", quiet(async () => {
  const res = await handleLeadTime(new Request(URL_), { LEAD_TIME_KV: fakeKv() }, fakeCtx(), {
    bc: fakeBc(countsResponse(37)),
    now: NOW,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /application\/json/);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["message", "updated_at", "weeks"]);
  assert.equal(body.weeks, 6);
  assert.ok(!JSON.stringify(body).includes("37"), "count must not leak");
}));

test("CORS: allowed origins are echoed, others are not", quiet(async () => {
  for (const origin of ["https://shop.islandslipper.com", "http://localhost:3000"]) {
    const res = await handleLeadTime(
      new Request(URL_, { headers: { Origin: origin } }),
      { LEAD_TIME_KV: fakeKv() }, fakeCtx(), { bc: fakeBc(countsResponse(1)), now: NOW }
    );
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(res.headers.get("Vary"), "Origin");
  }
  const res = await handleLeadTime(
    new Request(URL_, { headers: { Origin: "https://evil.example" } }),
    { LEAD_TIME_KV: fakeKv() }, fakeCtx(), { bc: fakeBc(countsResponse(1)), now: NOW }
  );
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
}));

test("OPTIONS preflight is 204; POST is 405 and never calls BC", async () => {
  const bc = fakeBc(countsResponse(1));
  const pre = await handleLeadTime(
    new Request(URL_, { method: "OPTIONS", headers: { Origin: "https://shop.islandslipper.com" } }),
    {}, fakeCtx(), { bc }
  );
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), "https://shop.islandslipper.com");
  const post = await handleLeadTime(new Request(URL_, { method: "POST" }), {}, fakeCtx(), { bc });
  assert.equal(post.status, 405);
  assert.equal(bc.subrequestCount, 0);
});

// Routing (/lead-time public, /mcp still protected) is checked with
// wrangler dev + curl.exe: index.js imports the OAuth provider, which only
// loads inside the Workers runtime.
