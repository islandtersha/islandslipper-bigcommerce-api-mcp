/**
 * get_categories — read the full BigCommerce category tree with computed
 * breadcrumb paths and per-category product counts.
 *
 * Intended for generating a category reference file, so it paginates the
 * categories endpoint FULLY (never stops at page 1) and returns a flat array
 * sorted by breadcrumb path so the output reads top-down like a tree.
 *
 * Read-only: no dry_run, no writes.
 *
 * product_count note: the BigCommerce categories endpoint does not return a
 * product count, so we derive it by paginating the products list once
 * (include_fields=categories) and tallying direct category assignments. This
 * is the count of products DIRECTLY assigned to a category — products assigned
 * only to a subcategory are not rolled up into the parent, matching how
 * BigCommerce stores product↔category membership.
 */

import { fetchAllPages } from "./catalog-helpers.js";

const executeFunction = async (
  {
    parent_id,
    include_hidden = true,
    include_product_counts = false,
    store_Hash,
  } = {},
  { bc }
) => {
  try {
    // 1. Pull every category page.
    const categories = await fetchAllPages(
      bc,
      "/v3/catalog/categories",
      store_Hash
    );

    // 2. Tally product counts per category from a single full product sweep —
    //    only when requested, since it can be an extra multi-page fetch.
    let countById = null;
    if (include_product_counts) {
      const products = await fetchAllPages(
        bc,
        "/v3/catalog/products?include_fields=categories",
        store_Hash
      );
      countById = new Map();
      for (const p of products) {
        for (const cid of p.categories || []) {
          countById.set(cid, (countById.get(cid) || 0) + 1);
        }
      }
    }

    // 3. Index by id and compute full breadcrumb paths from the root.
    const byId = new Map(categories.map((c) => [c.id, c]));
    const pathCache = new Map();
    const pathFor = (id) => {
      if (pathCache.has(id)) return pathCache.get(id);
      const names = [];
      const seen = new Set(); // cycle guard
      let cur = byId.get(id);
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        names.unshift(cur.name);
        cur = cur.parent_id ? byId.get(cur.parent_id) : null;
      }
      const path = names.join(" > ");
      pathCache.set(id, path);
      return path;
    };

    // 4. Optional subtree filter: keep parent_id and all of its descendants.
    let visible = categories;
    if (parent_id !== undefined && parent_id !== null) {
      if (!byId.has(parent_id)) {
        return {
          error: `parent_id ${parent_id} not found among ${categories.length} categories.`,
        };
      }
      const inSubtree = (id) => {
        const seen = new Set();
        let cur = byId.get(id);
        while (cur && !seen.has(cur.id)) {
          if (cur.id === parent_id) return true;
          seen.add(cur.id);
          cur = cur.parent_id ? byId.get(cur.parent_id) : null;
        }
        return false;
      };
      visible = categories.filter((c) => inSubtree(c.id));
    }

    // 5. Optionally drop hidden categories from the output.
    if (!include_hidden) {
      visible = visible.filter((c) => c.is_visible);
    }

    // 6. Shape and sort by path so the array reads as a tree. product_count is
    //    only present when the sweep ran; otherwise it is omitted entirely.
    const rows = visible.map((c) => {
      const row = {
        id: c.id,
        name: c.name,
        parent_id: c.parent_id,
        path: pathFor(c.id),
        is_visible: c.is_visible,
      };
      if (countById) row.product_count = countById.get(c.id) || 0;
      return row;
    });
    rows.sort((a, b) => a.path.localeCompare(b.path));
    return rows;
  } catch (error) {
    return {
      error: `An error occurred while getting categories: ${error.message}`,
    };
  }
};

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "get_categories",
      description:
        "Read the full BigCommerce category tree (Catalog Categories API v3), paginated fully. Returns a flat array of { id, name, parent_id, path, is_visible } sorted by breadcrumb path so it reads top-down as a tree; `path` is the full breadcrumb like 'Women > Wedges'. Read-only — no writes. Optional parent_id returns only that subtree (the node and its descendants); include_hidden (default true) keeps categories with is_visible=false. Set include_product_counts=true (default false) to also include product_count on each row — the number of products directly assigned to the category (subcategory-only products are not rolled up); this runs an extra full product-list sweep, so it is opt-in. When false, product_count is omitted from the rows entirely.",
      parameters: {
        type: "object",
        properties: {
          parent_id: {
            type: "integer",
            description:
              "Optional. If provided, return only the subtree rooted at this category id (the node itself plus all descendants).",
          },
          include_hidden: {
            type: "boolean",
            description:
              "When true (default), include categories with is_visible=false. Set false to return only visible categories.",
          },
          include_product_counts: {
            type: "boolean",
            description:
              "When true, run an extra full product-list sweep and add product_count (direct assignments) to each row. Defaults to false, in which case product_count is omitted from the output entirely (not returned as 0).",
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
