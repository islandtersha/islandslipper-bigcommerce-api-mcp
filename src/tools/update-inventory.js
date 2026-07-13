/**
 * update_inventory — set the absolute inventory level for a batch of
 * BigCommerce SKUs.
 *
 * Writes via BigCommerce's Inventory Adjustments API
 * (PUT /v3/inventory/adjustments/absolute) rather than the Catalog variant PUT.
 * BC's own docs state the Inventory API is the most direct way to update
 * inventory, and — critically — the adjustments endpoint runs NO SKU-uniqueness
 * validation, so it is immune to the HTTP 409 "Sku is not unique" failures the
 * Catalog variant PUT raised for SKUs that are substrings of other catalog SKUs
 * (e.g. "PT202-WHIS-9" colliding with "EVAPT202-WHIS-9").
 *
 * The SKU -> variant lookup (Catalog API) is retained purely to populate the
 * `before` field and to detect SKUs that don't exist in the catalog; the actual
 * write goes through the adjustments endpoint keyed by SKU. Defaults to a dry
 * run (no writes). Rate limits are respected by the underlying bc client.
 *
 * NOTE: the absolute adjustments endpoint is asynchronous — BC returns a
 * transaction_id and applies the change shortly after. We trust the success
 * response and report status "updated"; the settled level should be verified
 * out of band via get_inventory_levels.
 */

import {
  fetchProductsBySkus,
  indexVariantsBySku,
  resolveInventoryLocationId,
} from "./catalog-helpers.js";

// Static reason string for consistent BC audit logs.
const ADJUSTMENT_REASON = "MCP absolute inventory update";

const executeFunction = async (
  { updates, dry_run = true, store_Hash } = {},
  { bc }
) => {
  try {
    if (!Array.isArray(updates) || updates.length === 0) {
      return {
        error:
          "`updates` must be a non-empty array of { sku, new_inventory_level } objects.",
      };
    }

    // Validate shape up front.
    for (const u of updates) {
      if (!u || typeof u.sku !== "string" || u.sku.trim() === "") {
        return { error: "Each update requires a non-empty string `sku`." };
      }
      if (!Number.isFinite(Number(u.new_inventory_level))) {
        return {
          error: `Update for sku "${u.sku}" is missing a numeric new_inventory_level.`,
        };
      }
    }

    // Resolve all SKUs to variants in one batched catalog lookup so we can
    // populate `before` and detect SKUs missing from the catalog.
    const skus = updates.map((u) => String(u.sku));
    const products = await fetchProductsBySkus(bc, skus, store_Hash);
    const bySku = indexVariantsBySku(products);

    // Classify every update in input order. Missing SKUs are excluded from the
    // adjustments call and reported as individual errors (one bad SKU must not
    // fail the whole batch).
    const entries = updates.map(({ sku, new_inventory_level }) => {
      const target = bySku.get(String(sku));
      const after = Number(new_inventory_level);
      return target
        ? { sku, after, before: target.inventory_level, resolved: true }
        : { sku, after, before: null, resolved: false };
    });

    // Dry run: no writes; report before/after for resolved SKUs.
    if (dry_run) {
      return entries.map((e) =>
        e.resolved
          ? { sku: e.sku, before: e.before, after: e.after, status: "skipped_dry_run" }
          : notFoundResult(e)
      );
    }

    const resolved = entries.filter((e) => e.resolved);

    // Determine the outcome that applies to every resolved SKU. BC's adjustment
    // errors are batch-level, so success/failure is shared across the batch.
    let batchStatus = "updated";
    let batchError;

    if (resolved.length > 0) {
      try {
        const locationId = await resolveInventoryLocationId(bc, store_Hash);
        const items = resolved.map((e) => ({
          location_id: locationId,
          sku: e.sku,
          quantity: e.after,
        }));
        await bc.put(
          "/v3/inventory/adjustments/absolute",
          { reason: ADJUSTMENT_REASON, items },
          { storeHash: store_Hash }
        );
      } catch (err) {
        batchStatus = "error";
        batchError = err.message;
      }
    }

    return entries.map((e) => {
      if (!e.resolved) return notFoundResult(e);
      if (batchStatus === "updated") {
        return { sku: e.sku, before: e.before, after: e.after, status: "updated" };
      }
      return {
        sku: e.sku,
        before: e.before,
        after: e.after,
        status: "error",
        error_message: batchError,
      };
    });
  } catch (error) {
    return {
      error: `An error occurred while updating inventory: ${error.message}`,
    };
  }
};

function notFoundResult(entry) {
  return {
    sku: entry.sku,
    before: null,
    after: entry.after,
    status: "error",
    error_message: "SKU not found in catalog.",
  };
}

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "update_inventory",
      description:
        "Set the absolute inventory level for a batch of BigCommerce SKUs via the Inventory Adjustments API (PUT /v3/inventory/adjustments/absolute). Resolves each SKU to its variant to report the current level and to flag unknown SKUs, then writes the whole batch in one call. Immune to the Catalog variant PUT's 'Sku is not unique' 409s. Defaults to dry_run=true (reports what would change without writing). The adjustments endpoint is asynchronous — a 'updated' status means BC accepted the change; verify the settled level out of band with get_inventory_levels. Returns one result per SKU with before/after levels and a status of 'updated', 'skipped_dry_run', or 'error'.",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            description:
              "Array of inventory updates to apply. Required, non-empty.",
            items: {
              type: "object",
              properties: {
                sku: {
                  type: "string",
                  description: "The SKU whose inventory to set.",
                },
                new_inventory_level: {
                  type: "integer",
                  description:
                    "The new absolute inventory level to set for this SKU (not a delta).",
                },
              },
              required: ["sku", "new_inventory_level"],
            },
          },
          dry_run: {
            type: "boolean",
            description:
              "When true (default), report what would change without calling the write API.",
          },
          store_Hash: {
            type: "string",
            description:
              "Optional store hash. If not provided, uses the BC_STORE_HASH secret.",
          },
        },
        required: ["updates"],
      },
    },
  },
};

export { apiTool };
