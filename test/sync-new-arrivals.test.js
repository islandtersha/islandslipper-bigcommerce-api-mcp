import { test } from "node:test";
import assert from "node:assert/strict";

import { runNewArrivalsSync } from "../src/tools/sync-new-arrivals.js";
import { runScheduledNewArrivalsSync } from "../src/scheduled.js";
import { SUBREQUEST_BUDGET_EXHAUSTED } from "../src/bc-client.js";

const NOW = new Date("2026-10-07T20:00:00Z"); // 10:00 HST, 2026-10-07
const ENV = {}; // code defaults: category 114, exclude 113,83,84,85, window 60

function product(id, launch, categories = [20], extra = {}) {
  return {
    id,
    name: `P${id}`,
    sku: `SKU${id}`,
    is_visible: true,
    categories,
    date_created: "2020-01-01T00:00:00Z",
    custom_fields: [{ name: "~launch_date", value: launch }],
    ...extra,
  };
}

/**
 * In-memory BigCommerce: answers the sweep, sort-order, and assignment reads,
 * and applies PUT/DELETE so a second run sees the result. Records every write.
 */
function fakeBc(products, sortOrder = [], { ignoreProductFilter = false } = {}) {
  const state = { products: structuredClone(products), sortOrder: [...sortOrder] };
  const page = (data) => ({ data, meta: { pagination: { total_pages: 1 } } });
  const bc = {
    subrequestCount: 0,
    calls: [],
    async get(path) {
      this.subrequestCount++;
      if (path.startsWith("/v3/catalog/products?")) return page(structuredClone(state.products));
      if (/\/products\/sort-order/.test(path)) return page(state.sortOrder);
      if (path.startsWith("/v3/catalog/products/category-assignments?")) {
        const q = new URLSearchParams(path.split("?")[1]);
        const cat = Number(q.get("category_id:in"));
        const only = q.get("product_id:in");
        const ids = only && !ignoreProductFilter ? only.split(",").map(Number) : null;
        return page(
          state.products
            .filter((p) => p.categories.includes(cat) && (!ids || ids.includes(p.id)))
            .map((p) => ({ product_id: p.id, category_id: cat }))
        );
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async put(path, body) {
      this.subrequestCount++;
      this.calls.push({ method: "PUT", path, body });
      if (path === "/v3/catalog/products/category-assignments") {
        for (const a of body) {
          const p = state.products.find((x) => x.id === a.product_id);
          if (!p.categories.includes(a.category_id)) p.categories.push(a.category_id);
        }
      } else {
        state.sortOrder = body;
      }
      return { data: [] };
    },
    async delete(path) {
      this.subrequestCount++;
      this.calls.push({ method: "DELETE", path });
      const q = new URLSearchParams(path.split("?")[1]);
      const ids = q.get("product_id:in").split(",").map(Number);
      const cat = Number(q.get("category_id:in"));
      for (const p of state.products) {
        if (ids.includes(p.id)) p.categories = p.categories.filter((c) => c !== cat);
      }
      return { data: [] };
    },
  };
  return bc;
}

// Three new products, one old product already in 114 that must leave, and an
// old product in 114 AND another category whose other category must survive.
const CATALOG = [
  product(10, "2026-10-01"),
  product(11, "2026-09-20"),
  product(12, "2026-09-01"),
  product(13, "2025-01-01"), // top-up #4
  product(20, "2019-01-01", [114, 67]),
  product(21, "2018-01-01", [114]),
];

test("dry run sends no writes and reports the exact plan", async () => {
  const bc = fakeBc(CATALOG);
  const r = await runNewArrivalsSync(bc, ENV, { now: NOW });
  assert.equal(bc.calls.length, 0);
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.added.map((a) => a.id), [10, 11, 12, 13]);
  assert.deepEqual(r.removed.map((a) => a.id), [20, 21]);
  assert.deepEqual(r.writes.map((w) => w.step), ["add", "remove", "sort_order"]);
  assert.match(r.summary, /mode=dry_run status=ok/);
});

test("live run: removals name both filters and only category 114; other categories survive", async () => {
  const bc = fakeBc(CATALOG);
  const r = await runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW });
  const del = bc.calls.find((c) => c.method === "DELETE");
  const q = new URLSearchParams(del.path.split("?")[1]);
  assert.equal(q.get("category_id:in"), "114");
  assert.equal(q.get("product_id:in"), "20,21");
  const add = bc.calls.find((c) => c.path === "/v3/catalog/products/category-assignments" && c.method === "PUT");
  assert.ok(add.body.every((a) => a.category_id === 114));
  assert.equal(r.verification.ok, true);
  // Product 20 keeps its other category.
  const after = await bc.get("/v3/catalog/products?x");
  assert.deepEqual(after.data.find((p) => p.id === 20).categories, [67]);
});

test("idempotent: a second run with no catalog changes makes zero writes", async () => {
  const bc = fakeBc(CATALOG);
  await runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW });
  const before = bc.calls.length;
  const r = await runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW });
  assert.equal(bc.calls.length, before);
  assert.deepEqual([r.added, r.removed, r.writes], [[], [], []]);
  assert.equal(r.sort_order_changed, false);
});

test("refuses to run when the target set is empty (never empties the category)", async () => {
  const hidden = CATALOG.map((p) => ({ ...p, is_visible: false }));
  const bc = fakeBc(hidden);
  await assert.rejects(runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW }), /Target set is empty/);
  assert.equal(bc.calls.length, 0);
});

test("refuses every write if the remove filter's pre-check comes back too wide", async () => {
  // Simulate BigCommerce ignoring product_id:in: the GET returns the whole
  // category, which is what the DELETE would then have removed.
  // Product 10 is already in 114 and must STAY; a wide read includes it.
  const catalog = CATALOG.map((p) => (p.id === 10 ? { ...p, categories: [20, 114] } : p));
  const bc = fakeBc(catalog, [], { ignoreProductFilter: true });
  bc.calls.length = 0;
  await assert.rejects(
    runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW }),
    /Refusing to sync: the remove filter/
  );
  assert.equal(bc.calls.length, 0);
});

test("DELETE uses the literal documented filter form", async () => {
  const bc = fakeBc(CATALOG);
  const r = await runNewArrivalsSync(bc, ENV, { now: NOW });
  const del = r.writes.find((w) => w.step === "remove");
  assert.equal(del.path, "/v3/catalog/products/category-assignments?product_id:in=20,21&category_id:in=114");
  assert.deepEqual(r.remove_filter_checks.map((c) => c.ok), [true]);
});

test("refuses before the first write when the budget won't cover the run", async () => {
  const bc = fakeBc(CATALOG);
  bc.subrequestCount = 41; // 41 + sweep + sort read = 43; needs 3 writes + 1 verify
  await assert.rejects(
    runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW }),
    (e) => e.code === SUBREQUEST_BUDGET_EXHAUSTED && /Refused before any write/.test(e.message)
  );
  assert.equal(bc.calls.length, 0);
});

test("cron is a dry run unless NEW_ARRIVALS_LIVE is exactly \"true\"", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    for (const value of [undefined, "false", "TRUE", "yes", " true"]) {
      const bc = fakeBc(CATALOG);
      const r = await runScheduledNewArrivalsSync({ NEW_ARRIVALS_LIVE: value }, { bc, now: NOW });
      assert.equal(r.dry_run, true, String(value));
      assert.equal(bc.calls.length, 0, String(value));
    }
    const bc = fakeBc(CATALOG);
    const r = await runScheduledNewArrivalsSync({ NEW_ARRIVALS_LIVE: "true" }, { bc, now: NOW });
    assert.equal(r.dry_run, false);
    assert.ok(bc.calls.length > 0);
  } finally {
    console.log = log;
  }
});
