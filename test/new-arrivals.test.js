import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseLaunchDate,
  hstDateOf,
  todayHst,
  daysBetween,
  effectiveLaunchDate,
  windowStatus,
  computeNewArrivals,
  planCategorySync,
  readNewArrivalsConfig,
} from "../src/lib/new-arrivals.js";

const TODAY = "2026-10-07";

/** A visible, eligible product; override any field. */
function product(id, { launch, created = "2020-01-01T00:00:00+00:00", ...rest } = {}) {
  const custom_fields = [{ name: "Upper", value: "Leather" }];
  if (launch !== undefined) custom_fields.push({ name: "~launch_date", value: launch });
  return {
    id,
    name: `P${id}`,
    is_visible: true,
    categories: [20],
    date_created: created,
    custom_fields,
    ...rest,
  };
}

const ids = (result) => result.members.map((m) => m.id);

// --- Required cases ---------------------------------------------------------

test("valid ~launch_date is the effective date", () => {
  const e = effectiveLaunchDate(product(1, { launch: "2026-09-01", created: "2026-10-07T12:00:00Z" }));
  assert.equal(e.date, "2026-09-01");
  assert.equal(e.source, "launch_date");
  assert.equal(e.issue, null);
});

test("missing ~launch_date falls back to date_created (as an HST date)", () => {
  const e = effectiveLaunchDate(product(1, { created: "2026-10-07T21:03:11+00:00" }));
  assert.equal(e.date, "2026-10-07");
  assert.equal(e.source, "date_created");
  assert.equal(e.issue, null);
});

test("malformed ~launch_date falls back to date_created and is flagged", () => {
  for (const bad of ["10/07/2026", "2026-10-7", "2026-02-30", "2026-13-01", "2026-10-07T00:00", ""]) {
    const e = effectiveLaunchDate(product(1, { launch: bad, created: "2026-10-01T12:00:00Z" }));
    assert.equal(e.source, "date_created", bad);
    assert.equal(e.date, "2026-10-01", bad);
    assert.ok(e.issue && e.issue.reason, `expected an issue for "${bad}"`);
  }
});

test("future-dated ~launch_date is not new and never tops up", () => {
  const products = [
    product(1, { launch: "2026-10-08" }), // tomorrow
    product(2, { launch: "2025-01-01" }),
    product(3, { launch: "2024-01-01" }),
  ];
  assert.equal(windowStatus("2026-10-08", TODAY, 60), "future");
  const r = computeNewArrivals(products, { today: TODAY, excludeCategoryIds: [] });
  assert.deepEqual(ids(r), [2, 3]); // top-up skips the future product entirely
  assert.ok(r.members.every((m) => m.membership === "top_up"));
});

test("HST day boundary: date_created converts at UTC-10, and today is the HST date", () => {
  // 09:59:59Z on Aug 9 is 23:59:59 HST on Aug 8 — 60 days before Oct 7, so out.
  assert.equal(hstDateOf("2026-08-09T09:59:59Z"), "2026-08-08");
  assert.equal(windowStatus(hstDateOf("2026-08-09T09:59:59Z"), TODAY, 60), "outside");
  // One second later it is Aug 9 in HST — 59 days, so in.
  assert.equal(hstDateOf("2026-08-09T10:00:00Z"), "2026-08-09");
  assert.equal(windowStatus(hstDateOf("2026-08-09T10:00:00Z"), TODAY, 60), "in_window");
  // "Today" also turns over at HST midnight, not UTC midnight.
  assert.equal(todayHst(new Date("2026-10-08T09:59:59Z")), "2026-10-07");
  assert.equal(todayHst(new Date("2026-10-08T10:00:00Z")), "2026-10-08");
  // Launch day itself is day 0 (new); day 59 is the last new day.
  assert.equal(windowStatus(TODAY, TODAY, 60), "in_window");
  assert.equal(daysBetween("2026-08-09", TODAY), 59);
  assert.equal(daysBetween("2026-08-08", TODAY), 60);
});

test("top-up to 4 uses the most recent eligible products outside the window", () => {
  const products = [
    product(1, { launch: "2026-10-01" }), // in window
    product(2, { launch: "2026-01-01" }),
    product(3, { launch: "2025-06-01" }),
    product(4, { launch: "2025-12-01" }),
    product(5, { launch: "2020-01-01" }),
    product(6, { launch: "2026-05-01", is_visible: false }), // ineligible: never tops up
  ];
  const r = computeNewArrivals(products, { today: TODAY, excludeCategoryIds: [] });
  assert.deepEqual(ids(r), [1, 2, 4, 3]);
  assert.deepEqual(
    r.members.map((m) => m.membership),
    ["in_window", "top_up", "top_up", "top_up"]
  );
  assert.deepEqual(r.members.map((m) => m.position), [1, 2, 3, 4]);
});

test("no top-up when the window already has 4 or more", () => {
  const products = [1, 2, 3, 4, 5].map((id) => product(id, { launch: "2026-10-01" }));
  products.push(product(9, { launch: "2025-01-01" }));
  const r = computeNewArrivals(products, { today: TODAY, excludeCategoryIds: [] });
  assert.equal(r.members.length, 5);
  assert.ok(r.members.every((m) => m.membership === "in_window"));
});

test("tie-break: same effective date sorts by product id descending", () => {
  const products = [
    product(10, { launch: "2026-10-01" }),
    product(30, { launch: "2026-10-01" }),
    product(20, { launch: "2026-10-01" }),
    product(5, { launch: "2026-10-05" }),
  ];
  const r = computeNewArrivals(products, { today: TODAY, excludeCategoryIds: [] });
  assert.deepEqual(ids(r), [5, 30, 20, 10]);
});

// --- Agreed edge cases ------------------------------------------------------

test("surrounding spaces are trimmed and reported; inner junk is malformed", () => {
  assert.deepEqual(parseLaunchDate("  2026-09-01 "), { ok: true, date: "2026-09-01", trimmed: true });
  assert.deepEqual(parseLaunchDate("2026-09-01"), { ok: true, date: "2026-09-01", trimmed: false });
  assert.equal(parseLaunchDate("2026 -09-01").ok, false);
  const e = effectiveLaunchDate(product(1, { launch: " 2026-09-01" }));
  assert.equal(e.source, "launch_date");
  assert.equal(e.trimmed, true);
});

test("leap day is a real date only in leap years", () => {
  assert.equal(parseLaunchDate("2028-02-29").ok, true);
  assert.equal(parseLaunchDate("2026-02-29").ok, false);
});

test("~launch_date field name matches case-insensitively; duplicates are flagged", () => {
  const p = product(1, { created: "2026-01-01T12:00:00Z" });
  p.custom_fields.push({ name: "~Launch_Date", value: "2026-09-01" });
  assert.equal(effectiveLaunchDate(p).date, "2026-09-01");

  p.custom_fields.push({ name: "~launch_date", value: "2026-09-02" });
  const e = effectiveLaunchDate(p);
  assert.equal(e.source, "date_created");
  assert.match(e.issue.reason, /2 ~launch_date fields/);
});

test("eligibility: hidden products and excluded categories are left out", () => {
  const products = [
    product(1, { launch: "2026-10-01" }),
    product(2, { launch: "2026-10-01", is_visible: false }),
    product(3, { launch: "2026-10-01", categories: [20, 113] }),
    product(4, { launch: "2026-10-01", categories: [84] }),
  ];
  const r = computeNewArrivals(products, { today: TODAY, excludeCategoryIds: [113, 83, 84, 85] });
  assert.deepEqual(ids(r), [1]);
  assert.equal(r.evaluated.get(2).ineligible, "not visible");
  assert.equal(r.evaluated.get(3).ineligible, "in excluded category 113");
});

test("window override changes the cutoff", () => {
  const products = [product(1, { launch: "2026-09-01" })]; // 36 days ago
  assert.equal(computeNewArrivals(products, { today: TODAY, windowDays: 60, excludeCategoryIds: [] }).members[0].membership, "in_window");
  assert.equal(computeNewArrivals(products, { today: TODAY, windowDays: 30, excludeCategoryIds: [] }).members[0].membership, "top_up");
});

test("planCategorySync: add/remove/unchanged and 0-based sort order", () => {
  const members = [{ id: 7 }, { id: 3 }, { id: 9 }];
  const plan = planCategorySync(members, [3, 5, 1]);
  assert.deepEqual(plan.add, [7, 9]);
  assert.deepEqual(plan.remove, [1, 5]);
  assert.deepEqual(plan.unchanged, [3]);
  assert.deepEqual(plan.sort_order, [
    { product_id: 7, sort_order: 0 },
    { product_id: 3, sort_order: 1 },
    { product_id: 9, sort_order: 2 },
  ]);
  // Idempotent: once applied, nothing to add or remove.
  const again = planCategorySync(members, [7, 3, 9]);
  assert.deepEqual([again.add, again.remove], [[], []]);
});

test("readNewArrivalsConfig: defaults, env, override, and loud failures", () => {
  assert.deepEqual(readNewArrivalsConfig({}), {
    categoryId: 114,
    windowDays: 60,
    excludeCategoryIds: [113, 83, 84, 85],
    minCount: 4,
  });
  const c = readNewArrivalsConfig(
    { NEW_ARRIVALS_WINDOW_DAYS: "45", NEW_ARRIVALS_EXCLUDE_CATEGORY_IDS: " 113, 99 " },
    { window_days: 30 }
  );
  assert.equal(c.windowDays, 30);
  assert.deepEqual(c.excludeCategoryIds, [113, 99]);
  assert.throws(() => readNewArrivalsConfig({ NEW_ARRIVALS_WINDOW_DAYS: "sixty" }), /positive integer/);
  assert.throws(() => readNewArrivalsConfig({ NEW_ARRIVALS_EXCLUDE_CATEGORY_IDS: "113,114" }), /itself/);
});
