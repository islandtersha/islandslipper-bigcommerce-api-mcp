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

      // Every base + variant SKU across the RESOLVED products (uppercased). A
      // requested SKU present here resolved to a product; absent, it did not.
      // This distinguishes a SKU that resolved but produced no inventory row
      // (e.g. a base SKU whose product exposes only variant-level rows) from one
      // that isn't in the catalog at all — the same outward "missing" but
      // different meanings mid-migration.
      const resolvedSkus = new Set();
      for (const p of products) {
        if (p.sku) resolvedSkus.add(String(p.sku).toUpperCase());
        for (const v of p.variants || []) {
          if (v.sku) resolvedSkus.add(String(v.sku).toUpperCase());
        }
      }

      // Requested SKUs that produced no row, each tagged with WHY. Original
      // casing, de-duplicated in first-seen order.
      const present = new Set(matched.map((r) => String(r.sku).toUpperCase()));
      const missing_skus = [];
      const seen = new Set();
      for (const s of skus) {
        const key = String(s).toUpperCase();
        if (present.has(key) || seen.has(key)) continue;
        seen.add(key);
        missing_skus.push({
          sku: s,
          reason: resolvedSkus.has(key) ? "no_inventory_row" : "not_in_catalog",
        });
      }

      // Unconditional shape: always { rows, missing_skus } so a chained caller
      // never has to branch on Array.isArray(result). missing_skus is [] when
      // everything matched.
      return { rows: matched, missing_skus };
    }
    // product_id lookup: no requested SKUs, so nothing can be "missing".
    return { rows, missing_skus: [] };
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
        "Get inventory levels for BigCommerce products/variants. Provide an array of SKUs, or alternatively a single product_id. SKU matching is case-insensitive; returned rows keep BigCommerce's stored casing. ALWAYS returns { rows: [...], missing_skus: [...] } (one consistent shape — no bare-array case). Each row has sku, product_id, variant_id, inventory_level, inventory_warning_level, product_name, and is_visible. missing_skus lists every requested SKU that produced no row, each as { sku, reason } where reason is 'not_in_catalog' (the SKU resolved to no product) or 'no_inventory_row' (it resolved to a product but yielded no matching inventory row, e.g. a base SKU whose product exposes only variant-level rows); missing_skus is [] when everything matched and always [] for a product_id lookup.",
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
