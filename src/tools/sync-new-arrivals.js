/**
 * sync_new_arrivals — keep the New Arrivals category (NEW_ARRIVALS_CATEGORY_ID,
 * default 114) and its men's / women's subsets (NEW_ARRIVALS_MENS_CATEGORY_ID /
 * NEW_ARRIVALS_WOMENS_CATEGORY_ID, default 115 / 116) in step with the shared
 * rules in src/lib/new-arrivals.js. Defaults to dry_run=true. The daily cron
 * (src/scheduled.js) calls the same runNewArrivalsSync().
 *
 * Endpoints (verified against BigCommerce's API reference, 2026-10-07):
 *   add       PUT    /v3/catalog/products/category-assignments  [{product_id, category_id}] -> 204
 *   remove    DELETE /v3/catalog/products/category-assignments?product_id:in=…&category_id:in=… -> 204
 *   read sort GET    /v3/catalog/categories/{id}/products/sort-order
 *   sort      PUT    /v3/catalog/categories/{id}/products/sort-order  [{product_id, sort_order}] -> 200
 *   verify    GET    /v3/catalog/products/category-assignments?category_id:in={id}
 *   tree      GET    /v3/catalog/trees/categories  (men's / women's subtrees)
 *
 * Safety (applied to each managed category on its own):
 *   - Writes touch ONLY that category. Adds carry only its category_id. Every
 *     DELETE carries BOTH product_id:in and category_id:in — BigCommerce
 *     accepts category_id:in alone and would then empty the whole category.
 *   - Refuses to run when the product sweep or the 114 target set is empty, so
 *     a bad read can never strip the category. An empty 115 / 116 is allowed:
 *     they are strict subsets of 114 with no top-up.
 *   - Before any DELETE, GETs the assignments with the identical filter and
 *     refuses unless it matches exactly the products being removed. Every
 *     check for every category runs before the first write.
 *   - Projects the subrequests a live run needs across all three categories and
 *     refuses BEFORE the first write if they won't fit, so the budget never
 *     stops a sync halfway.
 *   - Idempotent: an unchanged catalog plans zero writes (the current sort
 *     order is read, not stored, so an unchanged order costs no PUT).
 */

import { fetchAllPages, chunk } from "./catalog-helpers.js";
import {
  SUBREQUEST_SOFT_CAP,
  BudgetStopReason,
  markSubrequestBudgetError,
} from "../bc-client.js";
import { loadNewArrivalsCatalog, loadCategoryTree } from "./audit-new-arrivals.js";
import { planNewArrivals, readNewArrivalsConfig, todayHst } from "../lib/new-arrivals.js";

/** Products per write call. BigCommerce documents no maximum; stay modest. */
const ADD_CHUNK = 100;
const REMOVE_CHUNK = 50; // ids go in the URL for DELETE

const ASSIGNMENTS_PATH = "/v3/catalog/products/category-assignments";

/**
 * Plan (and unless dryRun, apply) one sync of all three categories. Throws on
 * any refusal; a thrown error after a write has landed says exactly which
 * writes were applied.
 */
export async function runNewArrivalsSync(
  bc,
  env,
  { dryRun = true, windowDays, storeHash, now } = {}
) {
  const config = readNewArrivalsConfig(env, { window_days: windowDays });
  const today = todayHst(now);

  // 1. Read: one product sweep (membership comes from each product's
  //    categories) and the category tree (for the men's / women's subtrees).
  const products = await loadNewArrivalsCatalog(bc, storeHash);
  if (products.length === 0) {
    throw new Error("Product sweep returned 0 products; refusing to sync (it would empty the categories).");
  }
  const categories = await loadCategoryTree(bc, storeHash);

  // 2. Target sets and diffs for 114, 115, 116.
  const { result, targets } = planNewArrivals(products, categories, config, today);
  if (result.members.length === 0) {
    throw new Error(
      `Target set is empty (no eligible products); refusing to sync rather than empty category ${config.categoryId}.`
    );
  }

  // 3. Per category: read the sort order, build the writes, check their
  //    scope, and pre-check every DELETE filter — all before any write.
  const byId = new Map(products.map((p) => [p.id, p]));
  const sections = [];
  for (const t of targets) sections.push(await prepareCategory(bc, t, storeHash));
  for (const s of sections) {
    const bad = s.removeChecks.find((c) => !c.ok);
    if (bad) {
      throw new Error(
        `Refusing to sync: the remove filter ${bad.path} matched ${bad.matched} assignment(s), ` +
          `expected exactly ${bad.expected} in category ${s.target.categoryId}. No writes were sent.`
      );
    }
  }

  // 4. Budget: a live run needs every write plus one verification read per
  //    category that gets written.
  const allWrites = sections.flatMap((s) => s.writes);
  const liveNeeds = allWrites.length + sections.filter((s) => s.writes.length).length;
  const remaining = SUBREQUEST_SOFT_CAP - bc.subrequestCount;

  const report = {
    dry_run: dryRun,
    as_of_hst: today,
    window_days: config.windowDays,
    categories: sections.map((s) => categoryReport(s, byId)),
    writes_total: allWrites.length,
    subrequests_projected_for_live: bc.subrequestCount + liveNeeds,
  };

  if (dryRun) {
    report.subrequests_used = bc.subrequestCount;
    report.summary = summaryLine(report, "dry_run");
    return report;
  }

  if (liveNeeds > remaining) {
    throw markSubrequestBudgetError(
      new Error(
        `sync_new_arrivals needs ${liveNeeds} more subrequests (${allWrites.length} writes + verification) ` +
          `but only ${remaining} remain under the ${SUBREQUEST_SOFT_CAP} soft cap. Refused before any ` +
          `write, so nothing changed. Split the work or raise the cap on a paid plan.`
      ),
      { reason: BudgetStopReason.PROJECTED_OVER_BUDGET, subrequestCount: bc.subrequestCount, attempt: 0 }
    );
  }

  // 5. Apply category by category (114, 115, 116); within each: add, remove,
  //    sort. Stop at the first failure.
  const applied = [];
  for (const s of sections) {
    s.applied = [];
    for (const w of s.writes) {
      try {
        if (w.method === "PUT") await bc.put(w.path, w.body, { storeHash });
        else await bc.delete(w.path, { storeHash });
        applied.push(describeWrite(w));
        s.applied.push(describeWrite(w));
      } catch (err) {
        const msg =
          `sync_new_arrivals stopped at category ${s.target.categoryId} ${w.step} (${w.method} ${w.path}) ` +
          `after ${applied.length} of ${allWrites.length} writes. Applied: ${JSON.stringify(applied)}. ` +
          `Error: ${err.message}. Re-running converges (the sync is idempotent); check the categories ` +
          `in BC admin first.`;
        if (err && err.code) {
          err.message = msg;
          throw err;
        }
        throw new Error(msg);
      }
    }
  }

  // 6. Verify each written category now holds exactly its target set.
  for (const [i, s] of sections.entries()) {
    const row = report.categories[i];
    row.writes = s.applied;
    if (!s.writes.length) continue;
    const { categoryId } = s.target;
    const after = await fetchAllPages(
      bc,
      `${ASSIGNMENTS_PATH}?${new URLSearchParams({ "category_id:in": String(categoryId) })}`,
      storeHash
    );
    const actual = new Set(
      after.filter((a) => Number(a.category_id) === categoryId).map((a) => Number(a.product_id))
    );
    const target = new Set(s.target.plan.sort_order.map((r) => r.product_id));
    const missing = [...target].filter((id) => !actual.has(id));
    const extra = [...actual].filter((id) => !target.has(id));
    row.verification = { ok: missing.length === 0 && extra.length === 0, missing, extra };
    if (!row.verification.ok) {
      throw new Error(
        `sync_new_arrivals applied ${applied.length} writes but verification failed: category ${categoryId} ` +
          `is missing ${JSON.stringify(missing)} and has extra ${JSON.stringify(extra)}. Writes: ${JSON.stringify(applied)}.`
      );
    }
  }

  report.subrequests_used = bc.subrequestCount;
  report.summary = summaryLine(report, "live");
  return report;
}

/**
 * Read one category's sort order (skipped when its target is empty: there is
 * nothing to order), build its writes, check their scope, and pre-check each
 * DELETE filter. Sends no writes.
 */
async function prepareCategory(bc, target, storeHash) {
  const { categoryId, plan } = target;
  let sortChanged = false;
  if (plan.sort_order.length) {
    const currentSort = await fetchAllPages(
      bc,
      `/v3/catalog/categories/${categoryId}/products/sort-order`,
      storeHash
    );
    const sortById = new Map(currentSort.map((r) => [Number(r.product_id), r.sort_order]));
    sortChanged = plan.sort_order.some((r) => sortById.get(r.product_id) !== r.sort_order);
  }

  const writes = buildWrites(plan, categoryId, sortChanged);
  assertWriteScope(writes, categoryId, new Set(target.currentIds));

  const removeChecks = [];
  for (const w of writes.filter((x) => x.step === "remove")) {
    removeChecks.push(await checkRemoveFilter(bc, w, categoryId, storeHash));
  }
  return { target, writes, sortChanged, removeChecks };
}

function categoryReport({ target, writes, sortChanged, removeChecks }, byId) {
  const memberById = new Map(target.members.map((m) => [m.id, m]));
  const memberRow = (id) => {
    const m = memberById.get(id);
    return {
      position: m.position,
      id,
      name: m.product.name,
      sku: m.product.sku,
      effective_launch_date: m.effective.date,
      source: m.effective.source,
      membership: m.membership,
    };
  };
  return {
    category_id: target.categoryId,
    label: target.label,
    root_category_id: target.rootId,
    target_count: target.members.length,
    added: target.plan.add.map(memberRow),
    removed: target.plan.remove.map((id) => ({
      id,
      name: byId.get(id).name,
      sku: byId.get(id).sku,
      why: target.whyNot(id),
    })),
    unchanged: target.plan.unchanged.map(memberRow),
    sort_order: target.plan.sort_order,
    sort_order_changed: sortChanged,
    writes: writes.map(describeWrite),
    remove_filter_checks: removeChecks,
  };
}

function buildWrites(plan, categoryId, sortChanged) {
  const writes = [];
  for (const group of chunk(plan.add, ADD_CHUNK)) {
    writes.push({
      step: "add",
      method: "PUT",
      path: ASSIGNMENTS_PATH,
      body: group.map((id) => ({ product_id: id, category_id: categoryId })),
    });
  }
  for (const group of chunk(plan.remove, REMOVE_CHUNK)) {
    // Literal form, exactly as BigCommerce documents it (ids are integers, so
    // nothing needs encoding).
    writes.push({
      step: "remove",
      method: "DELETE",
      path: removeQueryPath(group, categoryId),
      product_ids: group,
    });
  }
  if (sortChanged) {
    writes.push({
      step: "sort_order",
      method: "PUT",
      path: `/v3/catalog/categories/${categoryId}/products/sort-order`,
      body: plan.sort_order,
    });
  }
  return writes;
}

function removeQueryPath(productIds, categoryId) {
  return `${ASSIGNMENTS_PATH}?product_id:in=${productIds.join(",")}&category_id:in=${categoryId}`;
}

/**
 * Before a DELETE, GET the assignments with the IDENTICAL filter string and
 * confirm it matches exactly the products being removed, in the target
 * category only. If BigCommerce ever ignored a filter, this read would come
 * back too wide and the DELETE is refused. Returns a check summary.
 */
async function checkRemoveFilter(bc, write, categoryId, storeHash) {
  const rows = await fetchAllPages(bc, write.path, storeHash);
  const want = new Set(write.product_ids);
  const ok =
    rows.length === want.size &&
    rows.every((r) => Number(r.category_id) === categoryId && want.has(Number(r.product_id)));
  return { path: write.path, matched: rows.length, expected: want.size, ok };
}

/** Last line of defence: every write must stay inside its own category. */
function assertWriteScope(writes, categoryId, currentIds) {
  for (const w of writes) {
    if (w.step === "add") {
      if (!w.body.length || w.body.some((a) => a.category_id !== categoryId)) {
        throw new Error(`Refusing add: assignment outside category ${categoryId}.`);
      }
    } else if (w.step === "remove") {
      const params = new URLSearchParams(w.path.split("?")[1]);
      const ids = (params.get("product_id:in") || "").split(",").filter(Boolean).map(Number);
      if (
        !ids.length ||
        params.get("category_id:in") !== String(categoryId) ||
        ids.some((id) => !currentIds.has(id))
      ) {
        throw new Error(
          `Refusing remove: a DELETE must name product ids currently in category ${categoryId} AND category_id:in=${categoryId}.`
        );
      }
    } else if (w.step === "sort_order") {
      if (w.path !== `/v3/catalog/categories/${categoryId}/products/sort-order` || !w.body.length) {
        throw new Error(`Refusing sort-order write outside category ${categoryId}.`);
      }
    } else {
      throw new Error(`Unknown write step "${w.step}".`);
    }
  }
}

function describeWrite(w) {
  const out = { step: w.step, method: w.method, path: w.path };
  if (w.body) out.body = w.body;
  return out;
}

function summaryLine(r, mode) {
  const cats = r.categories
    .map(
      (c) =>
        `cat${c.category_id}=target:${c.target_count},added:${c.added.length},removed:${c.removed.length},` +
        `sort_changed:${c.sort_order_changed}`
    )
    .join(" ");
  return (
    `new_arrivals_sync mode=${mode} status=ok date=${r.as_of_hst} ${cats} ` +
    `writes=${r.writes_total} subrequests=${r.subrequests_used}`
  );
}

const executeFunction = async ({ dry_run = true, window_days, store_Hash } = {}, { bc, env }) => {
  try {
    return await runNewArrivalsSync(bc, env, {
      dryRun: dry_run !== false,
      windowDays: window_days,
      storeHash: store_Hash,
    });
  } catch (error) {
    if (error && error.code) throw error; // marked errors (e.g. budget) propagate
    return { error: error.message };
  }
};

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "sync_new_arrivals",
      description:
        "Sync the New Arrivals category (NEW_ARRIVALS_CATEGORY_ID, default 114) and its men's / women's subsets (default 115 / 116) with the shared launch-date rule. 114 = the target set (topped up to 4). 115 / 116 = the target-set products assigned to Men (MENS_ROOT_CATEGORY_ID, default 1) / Women (WOMENS_ROOT_CATEGORY_ID, default 3) or any descendant; no top-up, may be empty. For each category: adds missing products, removes stale ones FROM THAT CATEGORY ONLY (a product's other categories are never touched), and sets the sort order newest first. Same rules as audit_new_arrivals. WRITE TOOL — defaults to dry_run=true, which returns the exact writes without sending them. Refuses to run on an empty product sweep or empty 114 target set, pre-checks every delete filter, and refuses before the first write if the run would exceed the subrequest budget. Idempotent: an unchanged catalog plans zero writes. A live run verifies each written category afterwards. Returns { dry_run, as_of_hst, window_days, categories[] (per category: category_id, label, root_category_id, target_count, added[], removed[], unchanged[], sort_order[], sort_order_changed, writes[], remove_filter_checks[], verification? (live)), writes_total, subrequests_used, subrequests_projected_for_live, summary }.",
      parameters: {
        type: "object",
        properties: {
          dry_run: {
            type: "boolean",
            description: "When true (default), report the planned writes without sending them.",
          },
          window_days: {
            type: "integer",
            description: "Optional window override in days. Defaults to NEW_ARRIVALS_WINDOW_DAYS, else 60.",
          },
          store_Hash: {
            type: "string",
            description: "Optional store hash. If not provided, uses the BC_STORE_HASH secret.",
          },
        },
        required: [],
      },
    },
  },
};

export { apiTool };
