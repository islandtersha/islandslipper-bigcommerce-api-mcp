/**
 * get_all_products — list products from the BigCommerce Catalog API v3.
 *
 * Credentials come from the Worker `env` (via the injected `bc` client), not
 * process.env. With no arguments the call and its output are unchanged from
 * the upstream fork: one bare GET of page 1 (BigCommerce's default 50 rows),
 * returned as BigCommerce sends it.
 *
 * Optional arguments pass through to GET /v3/catalog/products (page, limit,
 * include_fields, include, is_visible). fetch_all walks every page via
 * fetchAllPages and returns { data, meta: { total } }. 429s are retried by the
 * shared bc client using X-Rate-Limit-Time-Reset-Ms.
 */

import { fetchAllPages } from "./catalog-helpers.js";

export const MAX_LIMIT = 250;

const executeFunction = async (
  { store_Hash, page, limit, fetch_all, include_fields, include, is_visible } = {},
  { bc }
) => {
  try {
    const built = buildProductsQuery({ page, limit, include_fields, include, is_visible, fetch_all });
    if (built.error) return { error: built.error };
    const { query } = built;

    if (fetch_all) {
      const data = await fetchAllPages(
        bc,
        query ? `/v3/catalog/products?${query}` : "/v3/catalog/products",
        store_Hash,
        { limit: limit ?? MAX_LIMIT }
      );
      return { data, meta: { total: data.length } };
    }

    return await bc.get(
      query ? `/v3/catalog/products?${query}` : "/v3/catalog/products",
      { storeHash: store_Hash }
    );
  } catch (error) {
    if (error && error.code) throw error; // marked errors (e.g. budget) propagate
    return {
      error: `An error occurred while getting all products: ${error.message}`,
    };
  }
};

/**
 * Validate the optional inputs and build the query string. Returns
 * { query } ("" when nothing was given, so the default call stays the bare
 * path) or { error }. With fetch_all, page and limit are left to
 * fetchAllPages, which appends its own.
 */
export function buildProductsQuery({ page, limit, include_fields, include, is_visible, fetch_all } = {}) {
  const q = new URLSearchParams();

  if (page !== undefined && page !== null) {
    if (!Number.isInteger(page) || page < 1) return { error: "`page` must be an integer >= 1." };
    if (!fetch_all) q.set("page", String(page));
  }
  if (limit !== undefined && limit !== null) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return { error: `\`limit\` must be an integer from 1 to ${MAX_LIMIT}.` };
    }
    if (!fetch_all) q.set("limit", String(limit));
  }

  for (const [key, value] of [["include_fields", include_fields], ["include", include]]) {
    if (value === undefined || value === null) continue;
    const list = Array.isArray(value) ? value : String(value).split(",");
    const clean = list.map((s) => String(s).trim()).filter(Boolean);
    if (clean.length > 0) q.set(key, clean.join(","));
  }

  if (is_visible !== undefined && is_visible !== null) {
    if (typeof is_visible !== "boolean") return { error: "`is_visible` must be true or false." };
    q.set("is_visible", String(is_visible));
  }

  return { query: q.toString() };
}

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "get_all_products",
      description:
        "List products from the BigCommerce Catalog API v3 (GET /v3/catalog/products). Store hash is taken from the BC_STORE_HASH secret unless overridden. With NO arguments it returns page 1 only (50 products, full records including HTML descriptions — very large) exactly as BigCommerce sends it; check meta.pagination.total_pages for more. To page, pass page and limit (max 250). To get the whole catalog in one call, pass fetch_all=true: every page is fetched internally and the result is { data: [...all products], meta: { total } }. Shrink the output with include_fields (e.g. [\"id\",\"sku\",\"name\"] — leave out description, which is most of the size) and add sub-resources with include (images, variants, custom_fields, primary_image). is_visible filters by storefront visibility. For a compact feed-ready row per product (URL, images, price, stock, category names), use get_product_feed instead.",
      parameters: {
        type: "object",
        properties: {
          page: {
            type: "integer",
            description: "Optional page number (1-based). Ignored when fetch_all is true.",
          },
          limit: {
            type: "integer",
            description: `Optional page size, 1-${MAX_LIMIT} (BigCommerce default 50). With fetch_all, the page size used internally (default ${MAX_LIMIT}).`,
          },
          fetch_all: {
            type: "boolean",
            description:
              "Default false. When true, fetch every page and return { data, meta: { total } }. Combine with include_fields to keep the output small.",
          },
          include_fields: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional product fields to return (BigCommerce include_fields), e.g. [\"id\",\"sku\",\"name\",\"price\"]. Omitting description makes the output far smaller.",
          },
          include: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional sub-resources to embed (BigCommerce include): images, variants, custom_fields, primary_image, and others BigCommerce supports.",
          },
          is_visible: {
            type: "boolean",
            description: "Optional filter: true for storefront-visible products only, false for hidden only.",
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
