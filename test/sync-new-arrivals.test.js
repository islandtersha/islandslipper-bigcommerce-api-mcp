import { test } from "node:test";
import assert from "node:assert/strict";

import { runNewArrivalsSync } from "../src/tools/sync-new-arrivals.js";
import { runScheduledNewArrivalsSync } from "../src/scheduled.js";
import { SUBREQUEST_BUDGET_EXHAUSTED } from "../src/bc-client.js";

const NOW = new Date("2026-10-07T20:00:00Z"); // 10:00 HST, 2026-10-07
const ENV = {}; // code defaults: 114 / 115 / 116, roots 1 / 3, exclude 113,83,84,85, window 60

// Men 1 > 76, Women 3 > 79, Featured 70 > New 114 > 115 / 116; 20 and 67 are elsewhere.
const TREE = [
  { category_id: 1, parent_id: 0 },
  { category_id: 76, parent_id: 1 },
  { category_id: 3, parent_id: 0 },
  { category_id: 79, parent_id: 3 },
  { category_id: 70, parent_id: 0 },
  { category_id: 114, parent_id: 70 },
  { category_id: 115, parent_id: 114 },
  { category_id: 116, parent_id: 114 },
  { category_id: 20, parent_id: 0 },
  { category_id: 67, parent_id: 0 },
];

const cat = (r, id) => r.categories.find((c) => c.category_id === id);

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
 * In-memory BigCommerce: answers the sweep, category-tree, sort-order, and
 * assignment reads, and applies PUT/DELETE so a second run sees the result.
 * Records every write. `ignoreProductFilter` (true, or one category id) makes
 * the assignments read drop product_id:in, as if BigCommerce ignored it.
 */
function fakeBc(products, { ignoreProductFilter = false } = {}) {
  const state = { products: structuredClone(products), sortOrder: {} };
  const sortPath = /^\/v3\/catalog\/categories\/(\d+)\/products\/sort-order/;
  const page = (data) => ({ data, meta: { pagination: { total_pages: 1 } } });
  const bc = {
    subrequestCount: 0,
    calls: [],
    async get(path) {
      this.subrequestCount++;
      if (path.startsWith("/v3/catalog/products?")) return page(structuredClone(state.products));
      if (path.startsWith("/v3/catalog/trees/categories")) return page(TREE);
      if (sortPath.test(path)) return page(state.sortOrder[path.match(sortPath)[1]] || []);
      if (path.startsWith("/v3/catalog/products/category-assignments?")) {
        const q = new URLSearchParams(path.split("?")[1]);
        const cat = Number(q.get("category_id:in"));
        const only = q.get("product_id:in");
        const ignore = ignoreProductFilter === true || ignoreProductFilter === cat;
        const ids = only && !ignore ? only.split(",").map(Number) : null;
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
        state.sortOrder[path.match(sortPath)[1]] = body;
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
  const n = cat(r, 114);
  assert.deepEqual(n.added.map((a) => a.id), [10, 11, 12, 13]);
  assert.deepEqual(n.removed.map((a) => a.id), [20, 21]);
  assert.deepEqual(n.writes.map((w) => w.step), ["add", "remove", "sort_order"]);
  assert.deepEqual([cat(r, 115).target_count, cat(r, 116).target_count], [0, 0]); // none in Men/Women
  assert.equal(r.writes_total, 3);
  assert.match(r.summary, /mode=dry_run status=ok .*cat114=target:4,added:4,removed:2/);
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
  assert.equal(cat(r, 114).verification.ok, true);
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
  for (const c of r.categories) {
    assert.deepEqual([c.added, c.removed, c.writes], [[], [], []]);
    assert.equal(c.sort_order_changed, false);
  }
  assert.equal(r.writes_total, 0);
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
  const bc = fakeBc(catalog, { ignoreProductFilter: true });
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
  const del = cat(r, 114).writes.find((w) => w.step === "remove");
  assert.equal(del.path, "/v3/catalog/products/category-assignments?product_id:in=20,21&category_id:in=114");
  assert.deepEqual(cat(r, 114).remove_filter_checks.map((c) => c.ok), [true]);
});

test("refuses before the first write when the budget won't cover the run", async () => {
  const bc = fakeBc(CATALOG);
  bc.subrequestCount = 40; // 40 + sweep + tree + 114 sort read + pre-check = 44; needs 3 writes + 1 verify
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

// --- Men's / women's subsets (115 / 116) -------------------------------------

// 30 men's (child of 1), 31 women's, 32 unisex (both trees), 33 neither,
// 34 hidden men's, 40 old men's sitting in 115 and in Men itself.
const SPLIT = [
  product(30, "2026-10-01", [76]),
  product(31, "2026-09-30", [79]),
  product(32, "2026-09-29", [76, 79]),
  product(33, "2026-09-28", [20]),
  product(34, "2026-09-27", [76], { is_visible: false }),
  product(40, "2019-01-01", [1, 115]),
];

test("115/116 get the target set's men's / women's products, newest first; unisex in both", async () => {
  const bc = fakeBc(SPLIT);
  const r = await runNewArrivalsSync(bc, ENV, { now: NOW });
  assert.deepEqual(cat(r, 114).sort_order.map((x) => x.product_id), [30, 31, 32, 33]);
  assert.deepEqual(cat(r, 115).sort_order, [
    { product_id: 30, sort_order: 0 },
    { product_id: 32, sort_order: 1 },
  ]);
  assert.deepEqual(cat(r, 116).sort_order.map((x) => x.product_id), [31, 32]);
  assert.deepEqual(cat(r, 115).removed.map((x) => x.id), [40]);
  assert.match(cat(r, 115).removed[0].why, /outside the 60-day window/);
  assert.match(r.summary, /cat115=target:2,added:2,removed:1,.* cat116=target:2,added:2,removed:0,/);
});

test("live run: each category's writes carry only its own id; other categories survive", async () => {
  const bc = fakeBc(SPLIT);
  const r = await runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW });
  for (const c of bc.calls) {
    if (c.method === "DELETE") {
      assert.equal(c.path, "/v3/catalog/products/category-assignments?product_id:in=40&category_id:in=115");
    } else if (c.path === "/v3/catalog/products/category-assignments") {
      assert.equal(new Set(c.body.map((a) => a.category_id)).size, 1);
    }
  }
  for (const id of [114, 115, 116]) assert.equal(cat(r, id).verification.ok, true);
  const after = (await bc.get("/v3/catalog/products?x")).data;
  const cats = (id) => after.find((p) => p.id === id).categories.sort((a, b) => a - b);
  assert.deepEqual(cats(40), [1]);
  assert.deepEqual(cats(32), [76, 79, 114, 115, 116]);
  assert.deepEqual(cats(33), [20, 114]);
  // Second run: nothing to do.
  const before = bc.calls.length;
  await runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW });
  assert.equal(bc.calls.length, before);
});

test("an empty 115 is allowed: its stale members are removed, 114 still syncs", async () => {
  const bc = fakeBc([...CATALOG, product(40, "2019-01-01", [1, 115])]);
  const r = await runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW });
  assert.equal(cat(r, 115).target_count, 0);
  assert.deepEqual(cat(r, 115).writes.map((w) => w.step), ["remove"]);
  assert.deepEqual(cat(r, 115).verification, { ok: true, missing: [], extra: [] });
  assert.deepEqual(cat(r, 116).writes, []);
  assert.equal(cat(r, 114).verification.ok, true);
});

test("a too-wide pre-check on 115 refuses every write, including 114's", async () => {
  // 30 is already in 115 and must stay; a wide read of 115 includes it.
  const catalog = SPLIT.map((p) => (p.id === 30 ? { ...p, categories: [76, 115] } : p));
  const bc = fakeBc(catalog, { ignoreProductFilter: 115 });
  await assert.rejects(
    runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW }),
    /category_id:in=115 matched 2 assignment\(s\), expected exactly 1 in category 115\. No writes were sent/
  );
  assert.equal(bc.calls.length, 0);
});

test("the budget projection covers all three categories before the first write", async () => {
  const dry = await runNewArrivalsSync(fakeBc(SPLIT), ENV, { now: NOW });
  // reads: sweep, tree, 3 sort reads, 1 pre-check (115) = 6; writes: 114 add+sort,
  // 115 add+remove+sort, 116 add+sort = 7; verifies: 3.
  assert.equal(dry.subrequests_used, 6);
  assert.equal(dry.writes_total, 7);
  assert.equal(dry.subrequests_projected_for_live, 16);
  const tight = fakeBc(SPLIT);
  tight.subrequestCount = 30; // 36 after the reads; needs 10 more, only 9 remain
  await assert.rejects(
    runNewArrivalsSync(tight, ENV, { dryRun: false, now: NOW }),
    (e) => e.code === SUBREQUEST_BUDGET_EXHAUSTED && /needs 10 more subrequests/.test(e.message)
  );
  assert.equal(tight.calls.length, 0);
});

test("refuses an empty product sweep before touching any category", async () => {
  const bc = fakeBc([]);
  await assert.rejects(
    runNewArrivalsSync(bc, ENV, { dryRun: false, now: NOW }),
    /Product sweep returned 0 products/
  );
  assert.equal(bc.calls.length, 0);
});

test("refuses when a root category is missing from the tree", async () => {
  const bc = fakeBc(CATALOG);
  await assert.rejects(
    runNewArrivalsSync(bc, { MENS_ROOT_CATEGORY_ID: "999" }, { dryRun: false, now: NOW }),
    /Category 999 was not found/
  );
  assert.equal(bc.calls.length, 0);
});

test("warns (only) about 114 products in neither the Men nor the Women tree", async () => {
  const bc = fakeBc(SPLIT);
  const r = await runNewArrivalsSync(bc, ENV, { now: NOW });
  const w = r.warnings.outside_men_women_trees;
  assert.equal(w.count, 1);
  assert.deepEqual(w.products, [{ id: 33, name: "P33", sku: "SKU33", categories: [20] }]);
  assert.ok(cat(r, 114).sort_order.some((x) => x.product_id === 33)); // still in 114
  assert.match(r.summary, / outside_trees=1 writes=/);
});
