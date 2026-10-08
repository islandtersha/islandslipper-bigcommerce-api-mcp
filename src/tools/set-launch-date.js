/**
 * set_launch_date — upsert ONLY the `~launch_date` custom field on a batch of
 * products. Defaults to dry_run=true.
 *
 * Endpoints (verified against BigCommerce's API reference, 2026-10-07; both
 * need the API account's "Products modify" scope):
 *   update  PUT  /v3/catalog/products/{product_id}/custom-fields/{custom_field_id}  { value } -> 200
 *   create  POST /v3/catalog/products/{product_id}/custom-fields  { name, value } -> 200
 *
 * Never touches name, URL, visibility, categories, or any other custom field:
 * an update sends only `value` to the existing ~launch_date field's own id; a
 * create adds one new field named "~launch_date".
 *
 * Budget: one read per 50 products, one write per changed product, and one
 * read-back per 50 written products. MAX_BATCH is the largest batch that
 * always fits under the subrequest soft cap; the exact cost is projected up
 * front and the whole batch is refused if it won't fit (no partial batches).
 */

import { chunk } from "./catalog-helpers.js";
import {
  SUBREQUEST_SOFT_CAP,
  BudgetStopReason,
  markSubrequestBudgetError,
} from "../bc-client.js";
import {
  LAUNCH_DATE_FIELD,
  findCustomFields,
  parseLaunchDate,
  todayHst,
} from "../lib/new-arrivals.js";

const ID_CHUNK = 50;

/** Largest n with n writes + 2 * ceil(n / 50) reads <= SUBREQUEST_SOFT_CAP. */
export const MAX_BATCH = (() => {
  let n = 0;
  while (n + 1 + 2 * Math.ceil((n + 1) / ID_CHUNK) <= SUBREQUEST_SOFT_CAP) n++;
  return n;
})();

/**
 * Validate the whole input before any read. Returns { rows, problems }:
 * rows are { product_id, launch_date (normalized), trimmed }. Any problem
 * rejects the whole batch.
 */
export function validateLaunchDateUpdates(updates) {
  const problems = [];
  if (!Array.isArray(updates) || updates.length === 0) {
    return { rows: [], problems: ["`updates` must be a non-empty array of { product_id, launch_date }."] };
  }
  if (updates.length > MAX_BATCH) {
    problems.push(`Batch of ${updates.length} exceeds the maximum of ${MAX_BATCH}; split it.`);
  }
  const rows = [];
  const seen = new Set();
  updates.forEach((u, i) => {
    const where = `updates[${i}]`;
    if (!u || typeof u !== "object" || Array.isArray(u)) {
      problems.push(`${where} must be an object.`);
      return;
    }
    if (!Number.isInteger(u.product_id) || u.product_id < 1) {
      problems.push(`${where}.product_id must be a positive integer (got ${JSON.stringify(u.product_id)}).`);
      return;
    }
    if (seen.has(u.product_id)) {
      problems.push(`${where}: product_id ${u.product_id} appears more than once.`);
      return;
    }
    seen.add(u.product_id);
    const parsed = parseLaunchDate(u.launch_date);
    if (!parsed.ok) {
      problems.push(
        `${where} (product ${u.product_id}): launch_date ${JSON.stringify(u.launch_date)} is invalid (${parsed.reason}); use YYYY-MM-DD.`
      );
      return;
    }
    rows.push({ product_id: u.product_id, launch_date: parsed.date, trimmed: parsed.trimmed });
  });
  return { rows, problems };
}

/**
 * Decide what to do for one product. Returns
 *   { action: "create", before: null }
 *   { action: "update", field_id, before }
 *   { action: "no_changes", field_id, before }
 *   { action: "refuse", before: [values], reason }   — more than one ~launch_date field
 */
export function planLaunchDateUpsert(product, launchDate) {
  const fields = findCustomFields(product, LAUNCH_DATE_FIELD);
  if (fields.length > 1) {
    return {
      action: "refuse",
      before: fields.map((f) => f.value),
      reason: `product has ${fields.length} ${LAUNCH_DATE_FIELD} fields (ids ${fields
        .map((f) => f.id)
        .join(", ")}); remove the extras in BC admin, then re-run.`,
    };
  }
  if (fields.length === 0) return { action: "create", before: null };
  const f = fields[0];
  if (f.value === launchDate) return { action: "no_changes", field_id: f.id, before: f.value };
  return { action: "update", field_id: f.id, before: f.value };
}

/** The exact request for a create/update plan. */
export function launchDateRequest(productId, plan, launchDate) {
  if (plan.action === "update") {
    return {
      method: "PUT",
      path: `/v3/catalog/products/${productId}/custom-fields/${plan.field_id}`,
      body: { value: launchDate },
    };
  }
  if (plan.action === "create") {
    return {
      method: "POST",
      path: `/v3/catalog/products/${productId}/custom-fields`,
      body: { name: LAUNCH_DATE_FIELD, value: launchDate },
    };
  }
  return null;
}

async function fetchProductsWithCustomFields(bc, ids, storeHash) {
  const out = [];
  for (const group of chunk(ids, ID_CHUNK)) {
    const q = new URLSearchParams({
      "id:in": group.join(","),
      include: "custom_fields",
      include_fields: "id,name,sku",
      limit: "250",
    });
    const data = await bc.get(`/v3/catalog/products?${q}`, { storeHash });
    out.push(...(data.data || []));
  }
  return out;
}

const executeFunction = async ({ updates, dry_run = true, store_Hash } = {}, { bc }) => {
  try {
    const dryRun = dry_run !== false;
    const { rows, problems } = validateLaunchDateUpdates(updates);
    if (problems.length) {
      return { error: `set_launch_date rejected the whole batch; nothing was read or written. ${problems.join(" ")}` };
    }

    const today = todayHst();
    const products = await fetchProductsWithCustomFields(
      bc,
      rows.map((r) => r.product_id),
      store_Hash
    );
    const byId = new Map(products.map((p) => [p.id, p]));

    const entries = rows.map((r) => {
      const p = byId.get(r.product_id);
      const base = {
        product_id: r.product_id,
        name: p ? p.name : null,
        sku: p ? p.sku : null,
        after: r.launch_date,
      };
      if (r.launch_date > today) {
        base.future = true;
        base.note = `launch_date is after today (${today} HST); the product won't count as new until then.`;
      }
      if (!p) return { ...base, before: null, status: "error", error_message: "Product not found." };
      const plan = planLaunchDateUpsert(p, r.launch_date);
      if (plan.action === "refuse") {
        return { ...base, before: plan.before, status: "error", error_message: plan.reason };
      }
      if (plan.action === "no_changes") return { ...base, before: plan.before, status: "no_changes" };
      return {
        ...base,
        before: plan.before,
        action: plan.action,
        request: launchDateRequest(r.product_id, plan, r.launch_date),
      };
    });

    const toWrite = entries.filter((e) => e.request);
    const liveNeeds = toWrite.length + chunk(toWrite, ID_CHUNK).length; // writes + read-back
    const projected = bc.subrequestCount + liveNeeds;
    if (projected > SUBREQUEST_SOFT_CAP) {
      throw markSubrequestBudgetError(
        new Error(
          `set_launch_date would need ${projected} subrequests (soft cap ${SUBREQUEST_SOFT_CAP}); ` +
            `the whole batch is refused and nothing was written. Split it (max ${MAX_BATCH} products).`
        ),
        { reason: BudgetStopReason.PROJECTED_OVER_BUDGET, subrequestCount: bc.subrequestCount, attempt: 0 }
      );
    }

    const report = (results) => ({
      dry_run: dryRun,
      as_of_hst: today,
      max_batch_size: MAX_BATCH,
      subrequests_projected_for_live: projected,
      subrequests_used: bc.subrequestCount,
      results,
    });

    if (dryRun) {
      return report(
        entries.map((e) => (e.request ? { ...e, status: "skipped_dry_run" } : e))
      );
    }

    // Live: write each change; one product's failure doesn't stop the others.
    for (const e of toWrite) {
      try {
        if (e.request.method === "PUT") await bc.put(e.request.path, e.request.body, { storeHash: store_Hash });
        else await bc.post(e.request.path, e.request.body, { storeHash: store_Hash });
        e.status = "updated";
      } catch (err) {
        if (err && err.code) throw err;
        e.status = "error";
        e.error_message = err.message;
      }
    }

    // Read back every written product: exactly one ~launch_date, with the new value.
    const written = toWrite.filter((e) => e.status === "updated");
    if (written.length) {
      const after = await fetchProductsWithCustomFields(bc, written.map((e) => e.product_id), store_Hash);
      const afterById = new Map(after.map((p) => [p.id, p]));
      for (const e of written) {
        const fields = findCustomFields(afterById.get(e.product_id) || {}, LAUNCH_DATE_FIELD);
        if (fields.length !== 1 || fields[0].value !== e.after) {
          e.status = "error";
          e.error_message =
            `Write was sent but read-back shows ${JSON.stringify(fields.map((f) => f.value))}; ` +
            `check the product in BC admin before re-running.`;
        }
      }
    }

    return report(entries);
  } catch (error) {
    if (error && error.code) throw error;
    return { error: `An error occurred while setting launch dates: ${error.message}` };
  }
};

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "set_launch_date",
      description:
        `Set the ~launch_date custom field on a batch of products (max ${MAX_BATCH}). Writes ONLY that field: updates the existing ~launch_date (sending only its value) or creates it if missing; never touches name, URL, visibility, categories, or other custom fields. A product with more than one ~launch_date field is refused and reported. launch_date is trimmed, then must be strict YYYY-MM-DD and a real calendar date; any invalid input rejects the whole batch before anything is read. Future dates are allowed and flagged. WRITE TOOL — defaults to dry_run=true, which shows each exact request without sending it. The subrequest cost is projected up front and the whole batch is refused if it won't fit. A live run reads every written product back to verify. Returns { dry_run, as_of_hst, max_batch_size, subrequests_projected_for_live, subrequests_used, results: [{ product_id, name, sku, before, after, status: 'updated'|'no_changes'|'skipped_dry_run'|'error', action?, request?, future?, note?, error_message? }] }.`,
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            description: `Products to set, at most ${MAX_BATCH}. Each product_id may appear once.`,
            items: {
              type: "object",
              properties: {
                product_id: { type: "integer", description: "BigCommerce product id." },
                launch_date: {
                  type: "string",
                  description: "Original launch date, YYYY-MM-DD (spaces are trimmed).",
                },
              },
              required: ["product_id", "launch_date"],
            },
          },
          dry_run: {
            type: "boolean",
            description: "When true (default), report each planned request without sending it.",
          },
          store_Hash: {
            type: "string",
            description: "Optional store hash. If not provided, uses the BC_STORE_HASH secret.",
          },
        },
        required: ["updates"],
      },
    },
  },
};

export { apiTool };
