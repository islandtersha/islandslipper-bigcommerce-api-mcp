/**
 * get_inventory_levels — look up inventory for a set of SKUs (or a product_id)
 * via the BigCommerce Catalog Products API v3, including variants.
 */

import {
  fetchProductsBySkus,
  fetchProductsWithVariantsById,
} from "./catalog-helpers.js";

const executeFunction = async ({ skus, product_id, store_Hash } = {}, { bc }) => {
  try {
    const hasSkus = Array.isArray(skus) && skus.length > 0;
    // Treat product_id: null the same as undefined — otherwise null slips past
    // the guard and builds an `id:in=null` query that silently returns nothing.
    const hasProductId = product_id !== undefined && product_id !== null;
    if (!hasSkus && !hasProductId) {
      return {
        error:
          "Provide either a non-empty `skus` array or a `product_id`.",
      };
    }

    let products;
    if (hasSkus) {
      products = await fetchProductsBySkus(bc, skus, store_Hash);
    } else {
      products = await fetchProductsWithVariantsById(bc, product_id, store_Hash);
    }

    const rows = flattenRows(products);

    // When filtering by SKU, only return the requested SKUs (a product may
    // carry sibling variants we didn't ask about). Compare case-INSENSITIVELY
    // to match fetchProductsBySkus / findProductIdsBySku — BigCommerce's sku:in
    // is case-insensitive, so a lowercase query resolves an uppercase-stored
    // SKU, and a byte-exact filter here would drop every resolved row and
    // falsely report the SKU as missing. Returned rows keep their stored casing.
    if (hasSkus) {
      const wanted = new Set(skus.map((s) => String(s).toUpperCase()));
      const matched = rows.filter((r) =>
        wanted.has(String(r.sku).toUpperCase())
      );

      // Surface requested SKUs that matched nothing so four rows for six
      // requests can't be misread as "all six came back". Original casing,
      // de-duplicated in first-seen order.
      const present = new Set(matched.map((r) => String(r.sku).toUpperCase()));
      const missing_skus = [];
      const seen = new Set();
      for (const s of skus) {
        const key = String(s).toUpperCase();
        if (!present.has(key) && !seen.has(key)) {
          seen.add(key);
          missing_skus.push(s);
        }
      }

      // Keep the bare-array return when everything matched (clients/format
      // depend on it); switch to a shape only when there is something to report.
      if (missing_skus.length > 0) {
        return { rows: matched, missing_skus };
      }
      return matched;
    }
    return rows;
  } catch (error) {
    if (error && error.code) throw error; // marked errors (e.g. budget) propagate
    return {
      error: `An error occurred while getting inventory levels: ${error.message}`,
    };
  }
};

function flattenRows(products) {
  const rows = [];
  for (const p of products) {
    const variants = p.variants || [];
    if (variants.length > 0) {
      for (const v of variants) {
        rows.push({
          sku: v.sku || p.sku,
          product_id: p.id,
          variant_id: v.id,
          inventory_level: v.inventory_level,
          inventory_warning_level: v.inventory_warning_level,
          product_name: p.name,
          is_visible: p.is_visible,
        });
      }
    } else {
      rows.push({
        sku: p.sku,
        product_id: p.id,
        variant_id: null,
        inventory_level: p.inventory_level,
        inventory_warning_level: p.inventory_warning_level,
        product_name: p.name,
        is_visible: p.is_visible,
      });
    }
  }
  return rows;
}

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "get_inventory_levels",
      description:
        "Get inventory levels for BigCommerce products/variants. Provide an array of SKUs, or alternatively a single product_id. SKU matching is case-insensitive; returned rows keep BigCommerce's stored casing. Returns one row per matching variant with sku, product_id, variant_id, inventory_level, inventory_warning_level, product_name, and is_visible. When every requested SKU matched, returns a bare array of rows; when one or more requested SKUs matched nothing, returns { rows: [...], missing_skus: [...] } instead so unmatched SKUs are explicit rather than silently absent.",
      parameters: {
        type: "object",
        properties: {
          skus: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of SKUs to look up. Required unless product_id is provided.",
          },
          product_id: {
            type: "integer",
            description:
              "Optional alternative to skus: look up all variants of this product_id.",
          },
          store_Hash: {
            type: "string",
            description:
              "Optional store hash. If not provided, uses the BC_STORE_HASH secret.",
          },
        },
        required: [],
      },
    },
  },
};

export { apiTool };
