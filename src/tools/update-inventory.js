/**
 * update_inventory — set inventory_level on BigCommerce variants for a batch
 * of SKUs.
 *
 * Resolves each SKU to its product/variant via the Catalog API, then issues
 * PUT /catalog/products/{product_id}/variants/{variant_id}. Defaults to a
 * dry run (no writes). Rate limits are respected by the underlying bc client
 * (Retry-After / 429 backoff); writes are issued sequentially to avoid
 * hammering the API.
 */

import { fetchProductsBySkus, indexVariantsBySku } from "./catalog-helpers.js";

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

    // Resolve all SKUs to variants in one batched catalog lookup.
    const skus = updates.map((u) => String(u.sku));
    const products = await fetchProductsBySkus(bc, skus, store_Hash);
    const bySku = indexVariantsBySku(products);

    const results = [];
    // Sequential writes = gentlest on the API; the bc client handles 429s.
    for (const { sku, new_inventory_level } of updates) {
      const target = bySku.get(String(sku));
      const after = Number(new_inventory_level);

      if (!target) {
        results.push({
          sku,
          before: null,
          after,
          status: "error",
          error_message: "SKU not found in catalog.",
        });
        continue;
      }

      const before = target.inventory_level;

      if (dry_run) {
        results.push({ sku, before, after, status: "skipped_dry_run" });
        continue;
      }

      try {
        await bc.put(
          `/v3/catalog/products/${target.product_id}/variants/${target.variant_id}`,
          { inventory_level: after },
          { storeHash: store_Hash }
        );
        results.push({ sku, before, after, status: "updated" });
      } catch (err) {
        results.push({
          sku,
          before,
          after,
          status: "error",
          error_message: err.message,
        });
      }
    }

    return results;
  } catch (error) {
    return {
      error: `An error occurred while updating inventory: ${error.message}`,
    };
  }
};

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "update_inventory",
      description:
        "Update inventory_level for a batch of BigCommerce SKUs. Resolves each SKU to its variant and issues a PUT to the Catalog API. Defaults to dry_run=true (reports what would change without writing). Respects BigCommerce rate limits and batches writes sequentially. Returns one result per SKU with before/after levels and a status of 'updated', 'skipped_dry_run', or 'error'.",
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
                  description: "The SKU whose variant inventory to update.",
                },
                new_inventory_level: {
                  type: "integer",
                  description: "The new inventory level to set for this SKU.",
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
