/**
 * get_inventory_levels — look up inventory for a set of SKUs (or a product_id)
 * via the BigCommerce Catalog Products API v3, including variants.
 */

import { fetchProductsBySkus, fetchProductsById } from "./catalog-helpers.js";

const executeFunction = async ({ skus, product_id, store_Hash } = {}, { bc }) => {
  try {
    const hasSkus = Array.isArray(skus) && skus.length > 0;
    if (!hasSkus && product_id === undefined) {
      return {
        error:
          "Provide either a non-empty `skus` array or a `product_id`.",
      };
    }

    let products;
    if (hasSkus) {
      products = await fetchProductsBySkus(bc, skus, store_Hash);
    } else {
      products = await fetchProductsById(bc, product_id, store_Hash);
    }

    const rows = flattenRows(products);

    // When filtering by SKU, only return the requested SKUs (a product may
    // carry sibling variants we didn't ask about).
    if (hasSkus) {
      const wanted = new Set(skus.map(String));
      return rows.filter((r) => wanted.has(String(r.sku)));
    }
    return rows;
  } catch (error) {
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
        "Get inventory levels for BigCommerce products/variants. Provide an array of SKUs, or alternatively a single product_id. Returns one row per matching variant with sku, product_id, variant_id, inventory_level, inventory_warning_level, product_name, and is_visible.",
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
