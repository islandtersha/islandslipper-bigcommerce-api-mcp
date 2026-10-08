import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BATCH,
  validateLaunchDateUpdates,
  planLaunchDateUpsert,
  launchDateRequest,
  apiTool,
} from "../src/tools/set-launch-date.js";
import { SUBREQUEST_SOFT_CAP } from "../src/bc-client.js";

const setLaunchDate = (args, bc) => apiTool.function(args, { bc, env: {} });

function product(id, fields = []) {
  return {
    id,
    name: `P${id}`,
    sku: `SKU${id}`,
    custom_fields: [{ id: id * 100, name: "Upper", value: "Leather" }, ...fields],
  };
}

/** In-memory BC: serves the id:in read and applies custom-field PUT/POST. */
function fakeBc(products) {
  const state = structuredClone(products);
  let nextId = 9000;
  return {
    subrequestCount: 0,
    calls: [],
    async get(path) {
      this.subrequestCount++;
      const ids = new URLSearchParams(path.split("?")[1]).get("id:in").split(",").map(Number);
      return { data: structuredClone(state.filter((p) => ids.includes(p.id))) };
    },
    async put(path, body) {
      this.subrequestCount++;
      this.calls.push({ method: "PUT", path, body });
      const [, pid, fid] = path.match(/products\/(\d+)\/custom-fields\/(\d+)$/).map(Number);
      Object.assign(state.find((p) => p.id === pid).custom_fields.find((f) => f.id === fid), body);
      return { data: {} };
    },
    async post(path, body) {
      this.subrequestCount++;
      this.calls.push({ method: "POST", path, body });
      const pid = Number(path.match(/products\/(\d+)\/custom-fields$/)[1]);
      state.find((p) => p.id === pid).custom_fields.push({ id: nextId++, ...body });
      return { data: {} };
    },
  };
}

// --- Validation -------------------------------------------------------------

test("validation: trims, then requires strict YYYY-MM-DD and a real date", () => {
  const { rows, problems } = validateLaunchDateUpdates([
    { product_id: 1, launch_date: " 2026-09-02 " },
    { product_id: 2, launch_date: "2026-02-30" },
    { product_id: 3, launch_date: "9/2/2026" },
  ]);
  assert.deepEqual(rows, [{ product_id: 1, launch_date: "2026-09-02", trimmed: true }]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /not a real calendar date/);
  assert.match(problems[1], /not YYYY-MM-DD/);
});

test("validation: bad ids, duplicates, empty, and oversize batches are rejected", () => {
  assert.match(validateLaunchDateUpdates([]).problems[0], /non-empty/);
  assert.match(validateLaunchDateUpdates([{ product_id: "491", launch_date: "2026-09-02" }]).problems[0], /positive integer/);
  assert.match(
    validateLaunchDateUpdates([
      { product_id: 5, launch_date: "2026-09-02" },
      { product_id: 5, launch_date: "2026-09-03" },
    ]).problems[0],
    /more than once/
  );
  const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ product_id: i + 1, launch_date: "2026-09-02" }));
  assert.match(validateLaunchDateUpdates(big).problems[0], /exceeds the maximum/);
});

test("MAX_BATCH always fits: n writes + read + read-back stay under the soft cap", () => {
  assert.ok(MAX_BATCH + 2 * Math.ceil(MAX_BATCH / 50) <= SUBREQUEST_SOFT_CAP);
  assert.ok(MAX_BATCH + 1 + 2 * Math.ceil((MAX_BATCH + 1) / 50) > SUBREQUEST_SOFT_CAP);
});

// --- Upsert logic -----------------------------------------------------------

test("upsert: creates when missing, with only name + value", () => {
  const plan = planLaunchDateUpsert(product(1), "2026-09-02");
  assert.deepEqual(plan, { action: "create", before: null });
  assert.deepEqual(launchDateRequest(1, plan, "2026-09-02"), {
    method: "POST",
    path: "/v3/catalog/products/1/custom-fields",
    body: { name: "~launch_date", value: "2026-09-02" },
  });
});

test("upsert: updates the existing field by its own id, sending only value", () => {
  const p = product(1, [{ id: 77, name: "~Launch_Date", value: "2020-01-01" }]);
  const plan = planLaunchDateUpsert(p, "2026-09-02");
  assert.deepEqual(plan, { action: "update", field_id: 77, before: "2020-01-01" });
  assert.deepEqual(launchDateRequest(1, plan, "2026-09-02"), {
    method: "PUT",
    path: "/v3/catalog/products/1/custom-fields/77",
    body: { value: "2026-09-02" },
  });
});

test("upsert: same value is no_changes; a padded stored value is cleaned up", () => {
  assert.equal(
    planLaunchDateUpsert(product(1, [{ id: 7, name: "~launch_date", value: "2026-09-02" }]), "2026-09-02").action,
    "no_changes"
  );
  assert.equal(
    planLaunchDateUpsert(product(1, [{ id: 7, name: "~launch_date", value: " 2026-09-02" }]), "2026-09-02").action,
    "update"
  );
});

test("upsert: more than one ~launch_date field is refused", () => {
  const plan = planLaunchDateUpsert(
    product(1, [
      { id: 7, name: "~launch_date", value: "2026-09-02" },
      { id: 8, name: "~LAUNCH_DATE", value: "2026-09-03" },
    ]),
    "2026-09-02"
  );
  assert.equal(plan.action, "refuse");
  assert.deepEqual(plan.before, ["2026-09-02", "2026-09-03"]);
  assert.match(plan.reason, /2 ~launch_date fields/);
});

// --- End to end (fake BigCommerce) ------------------------------------------

const CATALOG = [
  product(491),
  product(492, [{ id: 50, name: "~launch_date", value: "2020-01-01" }]),
  product(493, [{ id: 60, name: "~launch_date", value: "2026-09-22" }]),
  product(494, [
    { id: 70, name: "~launch_date", value: "2026-01-01" },
    { id: 71, name: "~launch_date", value: "2026-01-02" },
  ]),
];
const UPDATES = [
  { product_id: 491, launch_date: "2026-09-02" },
  { product_id: 492, launch_date: "2026-09-03" },
  { product_id: 493, launch_date: "2026-09-22" },
  { product_id: 494, launch_date: "2026-09-01" },
  { product_id: 999, launch_date: "2026-09-01" },
];

test("dry run sends no writes and reports one status per product", async () => {
  const bc = fakeBc(CATALOG);
  const r = await setLaunchDate({ updates: UPDATES }, bc);
  assert.equal(bc.calls.length, 0);
  assert.deepEqual(
    r.results.map((x) => [x.product_id, x.status]),
    [
      [491, "skipped_dry_run"],
      [492, "skipped_dry_run"],
      [493, "no_changes"],
      [494, "error"],
      [999, "error"],
    ]
  );
  assert.equal(r.max_batch_size, MAX_BATCH);
});

test("live run writes only ~launch_date, verifies, and leaves other fields alone", async () => {
  const bc = fakeBc(CATALOG);
  const r = await setLaunchDate({ updates: UPDATES, dry_run: false }, bc);
  assert.deepEqual(
    bc.calls.map((c) => [c.method, c.path, c.body]),
    [
      ["POST", "/v3/catalog/products/491/custom-fields", { name: "~launch_date", value: "2026-09-02" }],
      ["PUT", "/v3/catalog/products/492/custom-fields/50", { value: "2026-09-03" }],
    ]
  );
  assert.deepEqual(
    r.results.map((x) => x.status),
    ["updated", "updated", "no_changes", "error", "error"]
  );
  // Read back the store: the Upper field is untouched.
  const after = await bc.get("/v3/catalog/products?id:in=491,492");
  for (const p of after.data) assert.deepEqual(p.custom_fields[0], { id: p.id * 100, name: "Upper", value: "Leather" });
});

test("future dates are allowed and flagged", async () => {
  const bc = fakeBc([product(1)]);
  const r = await setLaunchDate({ updates: [{ product_id: 1, launch_date: "2099-01-01" }] }, bc);
  assert.equal(r.results[0].future, true);
  assert.equal(r.results[0].status, "skipped_dry_run");
});

test("any invalid input rejects the whole batch before reading", async () => {
  const bc = fakeBc(CATALOG);
  const r = await setLaunchDate(
    { updates: [{ product_id: 491, launch_date: "2026-09-02" }, { product_id: 492, launch_date: "Sept 3" }], dry_run: false },
    bc
  );
  assert.match(r.error, /rejected the whole batch/);
  assert.equal(bc.subrequestCount, 0);
});
