/**
 * audit_new_arrivals — READ-ONLY report of what the New Arrivals sync would do.
 *
 * Reads every product in one paginated sweep (custom_fields + the few fields
 * the rules need) and the category records via the category-trees endpoint,
 * then applies the shared rules in src/lib/new-arrivals.js. Makes no writes.
 *
 * Subrequests: ceil(products / 250) product pages + 2 category-tree reads
 * (the categories, then any parents not already fetched). 379 products = 4.
 */

import { fetchAllPages } from "./catalog-helpers.js";
import {
  computeNewArrivals,
  planCategorySync,
  readNewArrivalsConfig,
  todayHst,
  hstDateOf,
  daysBetween,
  findCustomFields,
  LEGACY_NEW_FIELD,
} from "../lib/new-arrivals.js";

/** Product sweep used by the audit and the sync. fetchAllPages adds page/limit. */
export const NEW_ARRIVALS_PRODUCT_SWEEP =
  "/v3/catalog/products?include=custom_fields" +
  "&include_fields=id,name,sku,is_visible,is_featured,date_created,categories";

/** Audit-only companions: New Men's / New Women's Footwear. Never written. */
const AUDIT_ONLY_CATEGORY_IDS = [115, 116];

/** Read every product the New Arrivals rules need. */
export async function loadNewArrivalsCatalog(bc, storeHash) {
  return fetchAllPages(bc, NEW_ARRIVALS_PRODUCT_SWEEP, storeHash);
}

/** Read category records (v3 category trees) for a list of ids. */
async function fetchCategories(bc, ids, storeHash) {
  if (ids.length === 0) return [];
  const q = new URLSearchParams({ "category_id:in": ids.join(","), limit: "250" });
  const data = await bc.get(`/v3/catalog/trees/categories?${q}`, { storeHash });
  return data.data || [];
}

const executeFunction = async ({ window_days, store_Hash } = {}, { bc, env }) => {
  try {
    const config = readNewArrivalsConfig(env, { window_days });
    const today = todayHst();
    const { categoryId } = config;

    // 1. One product sweep — membership, dates, flags, and custom fields.
    const products = await loadNewArrivalsCatalog(bc, store_Hash);

    // 2. Category records, then any parents we don't already have (for names).
    const reportIds = [categoryId, ...AUDIT_ONLY_CATEGORY_IDS.filter((id) => id !== categoryId)];
    const categories = await fetchCategories(bc, reportIds, store_Hash);
    const byId = new Map(categories.map((c) => [c.category_id, c]));
    const parentIds = [...new Set(categories.map((c) => c.parent_id))].filter(
      (id) => id && !byId.has(id)
    );
    for (const c of await fetchCategories(bc, parentIds, store_Hash)) byId.set(c.category_id, c);

    // 3. Apply the shared rules.
    const result = computeNewArrivals(products, {
      today,
      windowDays: config.windowDays,
      excludeCategoryIds: config.excludeCategoryIds,
      minCount: config.minCount,
    });
    const memberById = new Map(result.members.map((m) => [m.id, m]));
    const ev = (id) => result.evaluated.get(id);

    const whyNot = (id) => {
      if (memberById.has(id)) return null;
      const e = ev(id);
      if (e.ineligible) return e.ineligible;
      if (e.status === "future") return `future launch date (${e.effective.date})`;
      if (e.status === "no_date") return "no usable launch date or date_created";
      return `outside the ${config.windowDays}-day window (${e.days} days) and not needed for top-up`;
    };

    const basic = (p) => ({ id: p.id, name: p.name, sku: p.sku });
    const datedRow = (p) => {
      const e = ev(p.id);
      return {
        ...basic(p),
        is_visible: p.is_visible,
        date_created: p.date_created,
        effective_launch_date: e.effective.date,
        source: e.effective.source,
        days_since_launch: e.days,
      };
    };
    const membersOf = (catId) =>
      products
        .filter((p) => (p.categories || []).map(Number).includes(catId))
        .sort((a, b) => a.id - b.id);

    // --- 1. Would-be New Arrivals set
    const wouldBe = result.members.map((m) => ({
      position: m.position,
      ...basic(m.product),
      effective_launch_date: m.effective.date,
      source: m.effective.source,
      days_since_launch: m.days,
      membership: m.membership,
    }));

    // --- 2. Created inside the window with no valid ~launch_date
    const needsLaunchDate = products
      .map((p) => ({ p, e: ev(p.id) }))
      .filter(({ p, e }) => {
        if (e.effective.source === "launch_date") return false;
        const created = hstDateOf(p.date_created);
        if (!created) return false;
        const days = daysBetween(created, today);
        return days >= 0 && days < config.windowDays;
      })
      .map(({ p, e }) => ({
        ...basic(p),
        is_visible: p.is_visible,
        date_created: p.date_created,
        created_hst: hstDateOf(p.date_created),
        launch_date_issue: e.effective.issue,
        in_target_set: memberById.has(p.id),
      }))
      .sort((a, b) => (a.created_hst < b.created_hst ? 1 : -1) || b.id - a.id);

    // --- 3. Valid, malformed, and trimmed ~launch_date values
    const valid = [];
    const malformed = [];
    const trimmed = [];
    for (const p of products) {
      const e = ev(p.id).effective;
      if (e.source === "launch_date") {
        valid.push({
          ...basic(p),
          is_visible: p.is_visible,
          launch_date: e.date,
          created_hst: hstDateOf(p.date_created),
          in_target_set: memberById.has(p.id),
          why_not: whyNot(p.id),
        });
      }
      if (e.issue) malformed.push({ ...basic(p), raw: e.issue.raw, reason: e.issue.reason });
      if (e.trimmed) trimmed.push({ ...basic(p), raw: e.launch_date_raw });
    }

    // --- 4. is_featured audit
    const featured = products
      .filter((p) => p.is_featured === true)
      .map((p) => ({ ...basic(p), is_visible: p.is_visible }));

    // --- 5. Legacy ~new field (exact name, case-insensitive) + ~new* lookalikes
    const legacyNew = [];
    const lookalikes = {};
    for (const p of products) {
      for (const f of findCustomFields(p, LEGACY_NEW_FIELD)) {
        legacyNew.push({ ...basic(p), is_visible: p.is_visible, value: f.value });
      }
      for (const f of p.custom_fields || []) {
        const n = String(f.name || "").trim();
        if (n.toLowerCase().startsWith(LEGACY_NEW_FIELD) && n.toLowerCase() !== LEGACY_NEW_FIELD) {
          (lookalikes[n] ||= []).push(p.id);
        }
      }
    }

    // --- 7. Category details
    const categoryDetails = reportIds.map((id) => {
      const c = byId.get(id);
      if (!c) return { id, error: "category not found" };
      const parent = c.parent_id ? byId.get(c.parent_id) : null;
      const row = {
        id,
        name: c.name,
        url: c.url ? c.url.path : null,
        url_is_customized: c.url ? c.url.is_customized : null,
        is_visible: c.is_visible,
        default_product_sort: c.default_product_sort,
        parent_id: c.parent_id,
        parent_name: parent ? parent.name : null,
        role: id === categoryId ? "sync target" : "audit only (never written)",
      };
      if (id === categoryId && c.default_product_sort !== "featured") {
        row.warning =
          `default_product_sort is "${c.default_product_sort}", not "featured" — the sync's sort ` +
          `order won't control display until this is set to Featured in BC admin.`;
      }
      return row;
    });

    // --- 8. Current contents of the target + audit-only categories
    const currentContents = {};
    for (const id of reportIds) {
      currentContents[id] = membersOf(id).map((p) => ({
        ...datedRow(p),
        in_target_set: memberById.has(p.id),
        verdict: memberById.has(p.id) ? "stay" : "remove",
        why_not: whyNot(p.id),
      }));
    }

    // --- 9. Cleanup preview for the target category
    const currentTargetIds = membersOf(categoryId).map((p) => p.id);
    const plan = planCategorySync(result.members, currentTargetIds);
    const byProductId = new Map(products.map((p) => [p.id, p]));
    const cleanupPreview = {
      category_id: categoryId,
      add: plan.add.map((id) => ({ position: memberById.get(id).position, ...basic(byProductId.get(id)) })),
      remove: plan.remove.map((id) => ({ ...basic(byProductId.get(id)), why: whyNot(id) })),
      unchanged: plan.unchanged.map((id) => ({ position: memberById.get(id).position, ...basic(byProductId.get(id)) })),
      sort_order: plan.sort_order,
      note: `Removals are scoped to category ${categoryId} only; no product's other categories change.`,
    };

    return {
      read_only: true,
      as_of_hst: today,
      config: {
        category_id: categoryId,
        window_days: config.windowDays,
        min_count: config.minCount,
        exclude_category_ids: config.excludeCategoryIds,
      },
      products_read: products.length,
      would_be_new_arrivals: {
        count: wouldBe.length,
        in_window: wouldBe.filter((r) => r.membership === "in_window").length,
        top_up: wouldBe.filter((r) => r.membership === "top_up").length,
        rows: wouldBe,
      },
      needs_launch_date: needsLaunchDate,
      launch_date_issues: { valid, malformed, trimmed },
      featured_flag: featured,
      legacy_new_field: { field: LEGACY_NEW_FIELD, products: legacyNew, other_new_like_fields: lookalikes },
      category_details: categoryDetails,
      current_contents: currentContents,
      cleanup_preview: cleanupPreview,
      subrequests_used: bc.subrequestCount,
    };
  } catch (error) {
    if (error && error.code) throw error; // marked errors (e.g. budget) propagate
    return { error: `An error occurred while auditing New Arrivals: ${error.message}` };
  }
};

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "audit_new_arrivals",
      description:
        "READ-ONLY audit of the New Arrivals category sync. Applies the shared date rule (effective launch date = valid ~launch_date custom field, else date_created as an HST date; new when 0 <= days < window, default 60; future dates excluded) and membership rule (visible, not in excluded categories; top up to 4 with the most recent eligible products; newest first, ties by id desc). Returns: would_be_new_arrivals (position, effective date, source, in_window|top_up); needs_launch_date (created inside the window with no valid ~launch_date); launch_date_issues (valid, malformed, and trimmed values); featured_flag (is_featured products); legacy_new_field (~new, plus ~new* lookalikes); category_details for the target (default 114) and 115/116 with a warning if the target's default sort isn't Featured; current_contents of those categories with stay/remove verdicts; cleanup_preview (exact add/remove/sort_order the first sync would produce); subrequests_used. Makes no writes.",
      parameters: {
        type: "object",
        properties: {
          window_days: {
            type: "integer",
            description:
              "Optional window override in days. Defaults to NEW_ARRIVALS_WINDOW_DAYS, else 60.",
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
