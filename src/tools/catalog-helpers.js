/**
 * Shared BigCommerce Catalog v3 helpers used by the inventory tools.
 */

/** BigCommerce caps `sku:in` URLs; chunk large SKU lists to stay safe. */
const SKU_CHUNK_SIZE = 50;

/**
 * Fetch products (with variants) for a set of SKUs. Returns the flat list of
 * product objects.
 *
 * IMPORTANT: `sku:in` on `GET /v3/catalog/products` matches only the
 * product-level (base) SKU — it never matches variant SKUs (e.g.
 * "PT202-NAVY-8"). Variant SKUs must be resolved via the dedicated
 * `GET /v3/catalog/variants` endpoint. We therefore resolve the requested
 * SKUs to product IDs from BOTH endpoints (variants for variant SKUs, products
 * for base/simple-product SKUs), then fetch the full products by ID so callers
 * still get product-level fields (name, is_visible) and complete variant data.
 */
export async function fetchProductsBySkus(bc, skus, storeHash) {
  const productIds = new Set();
  // Match the exact-equality behaviour of findProductIdsBySku: BigCommerce may
  // return extra rows from `sku:in` (e.g. substring-ish matches), so only keep
  // rows whose SKU EXACTLY equals one of the requested SKUs. Without this the
  // two resolution paths could over-fetch and diverge.
  const requested = new Set(skus.map(String));

  for (const group of chunk(skus.map(String), SKU_CHUNK_SIZE)) {
    const csv = group.join(",");

    // Variant SKUs -> product IDs via the variants endpoint.
    const variantData = await bc.get(
      `/v3/catalog/variants?${new URLSearchParams({ "sku:in": csv, limit: "250" })}`,
      { storeHash }
    );
    for (const v of variantData.data || []) {
      if (requested.has(String(v.sku)) && v.product_id != null) {
        productIds.add(v.product_id);
      }
    }

    // Base SKUs of simple products (no variant options) don't appear in the
    // variants endpoint, so also resolve via the products endpoint.
    const productData = await bc.get(
      `/v3/catalog/products?${new URLSearchParams({ "sku:in": csv, limit: "250" })}`,
      { storeHash }
    );
    for (const p of productData.data || []) {
      if (requested.has(String(p.sku)) && p.id != null) {
        productIds.add(p.id);
      }
    }
  }

  if (productIds.size === 0) return [];

  return fetchProductsByIds(bc, [...productIds], storeHash);
}

/**
 * Fetch full products (with variants) for a list of product IDs, chunking the
 * `id:in` filter. Returns the flat list of product objects.
 */
async function fetchProductsByIds(bc, ids, storeHash) {
  const products = [];
  for (const group of chunk(ids.map(String), SKU_CHUNK_SIZE)) {
    const q = new URLSearchParams({
      "id:in": group.join(","),
      include: "variants",
      limit: "250",
    });
    const data = await bc.get(`/v3/catalog/products?${q}`, { storeHash });
    products.push(...(data.data || []));
  }
  return products;
}

/** Fetch products (with variants) by product_id. Returns product objects. */
export async function fetchProductsById(bc, productId, storeHash) {
  return fetchProductsByIds(bc, [productId], storeHash);
}

/**
 * Fetch FULL product records — variants AND custom_fields — for a list of
 * product IDs. The catalog write/category tools need custom_fields (e.g. the
 * `~origin_categories` provenance field) and `categories`, which the leaner
 * fetchProductsByIds (variants only) omits.
 *
 * Exported for genuine multi-id callers — update_product's read-back
 * verification and the upcoming assign_categories / set_visibility tools — plus
 * the duplicate-SKU error path below, which is legitimately multi-id.
 */
export async function fetchFullProductsByIds(bc, ids, storeHash) {
  const products = [];
  for (const group of chunk(ids.map(String), SKU_CHUNK_SIZE)) {
    const q = new URLSearchParams({
      "id:in": group.join(","),
      include: "variants,custom_fields",
      limit: "250",
    });
    const data = await bc.get(`/v3/catalog/products?${q}`, { storeHash });
    products.push(...(data.data || []));
  }
  return products;
}

/**
 * Find every product id whose base SKU OR one of its variant SKUs EXACTLY
 * equals `sku`. Uses exact equality (not the substring behaviour of some BC
 * endpoints) so resolution never grabs the wrong product. Returns an array of
 * distinct product ids (usually 0 or 1; more than 1 signals a duplicate SKU).
 */
async function findProductIdsBySku(bc, sku, storeHash) {
  const ids = new Set();
  const params = new URLSearchParams({ "sku:in": sku, limit: "250" });

  const variantData = await bc.get(`/v3/catalog/variants?${params}`, {
    storeHash,
  });
  for (const v of variantData.data || []) {
    if (String(v.sku) === sku && v.product_id != null) ids.add(v.product_id);
  }

  const productData = await bc.get(`/v3/catalog/products?${params}`, {
    storeHash,
  });
  for (const p of productData.data || []) {
    if (String(p.sku) === sku && p.id != null) ids.add(p.id);
  }
  return [...ids];
}

/**
 * resolveProduct — shared entry point for the catalog write tools.
 *
 * Accepts an identifier of { product_id } OR { sku } and returns the FULL
 * product record (variants, categories, custom_fields). Throws a clear Error
 * when the identifier is malformed, nothing matches, or — for a SKU — MORE
 * THAN ONE product matches: it lists every match rather than guessing which
 * one the caller meant.
 */
export async function resolveProduct(bc, identifier, storeHash) {
  const { product_id, sku } = identifier || {};
  const hasId =
    product_id !== undefined && product_id !== null && String(product_id) !== "";
  const hasSku = sku !== undefined && sku !== null && String(sku).trim() !== "";

  if (!hasId && !hasSku) {
    throw new Error("identifier must include a `product_id` or a `sku`.");
  }

  let ids;
  if (hasId) {
    ids = [product_id];
  } else {
    ids = await findProductIdsBySku(bc, String(sku), storeHash);
    if (ids.length === 0) {
      throw new Error(`No product found with SKU "${sku}".`);
    }
    if (ids.length > 1) {
      const matches = await fetchFullProductsByIds(bc, ids, storeHash);
      const list = matches
        .map((p) => `#${p.id} "${p.name}" (base SKU ${p.sku || "—"})`)
        .join("; ");
      throw new Error(
        `SKU "${sku}" matches more than one product: ${list}. Disambiguate with product_id.`
      );
    }
  }

  // `ids` is now exactly one product id. Fetch it via the single-record
  // endpoint rather than the `id:in=` list query: a style-with-color+size
  // legacy product can carry 80+ variants, and the by-id endpoint returns the
  // full variant set in one predictable subrequest. fetchFullProductsByIds
  // stays for the genuine multi-id callers (e.g. the duplicate-SKU path above).
  const data = await bc.get(
    `/v3/catalog/products/${ids[0]}?include=variants,custom_fields`,
    { storeHash }
  );
  const product = data.data;
  if (!product) {
    throw new Error(
      hasId
        ? `No product found with product_id ${product_id}.`
        : `No product found with SKU "${sku}".`
    );
  }
  return product;
}

/**
 * Build a Map of sku -> { product_id, variant_id, inventory_level, ... } from
 * a list of product objects, indexing every variant SKU and every product's
 * base SKU (falling back to the product's first variant).
 */
export function indexVariantsBySku(products) {
  const map = new Map();
  for (const p of products) {
    // A missing `variants` array means the caller fetched without
    // include=variants; silently mapping nothing would hand the caller an empty
    // result that looks like "SKU not found". Fail loudly instead.
    if (!Array.isArray(p.variants)) {
      throw new Error(
        `Product #${p.id} was passed to indexVariantsBySku without a \`variants\` array; ` +
          `fetch it with include=variants before indexing.`
      );
    }
    const variants = p.variants;
    for (const v of variants) {
      if (v.sku) {
        map.set(String(v.sku), variantRow(p, v));
      }
    }
    // Map the product's base SKU to its default variant if not already mapped.
    if (p.sku && !map.has(String(p.sku)) && variants.length > 0) {
      map.set(String(p.sku), variantRow(p, variants[0]));
    }
  }
  return map;
}

function variantRow(product, variant) {
  return {
    sku: variant.sku || product.sku,
    product_id: product.id,
    variant_id: variant.id,
    inventory_level: variant.inventory_level,
    inventory_warning_level: variant.inventory_warning_level,
    product_name: product.name,
    is_visible: product.is_visible,
  };
}

/**
 * Resolve the store's single inventory location id, required by the absolute
 * inventory adjustments API (PUT /v3/inventory/adjustments/absolute).
 *
 * Island Slipper is a single-location store (Pearl City factory + web
 * fulfillment), so this fetches GET /v3/inventory/locations and returns that
 * one location's id. It deliberately does NOT hardcode `location_id: 1`:
 * instead it verifies on every call and throws if the store has zero or more
 * than one location, so a misconfigured / multi-location store surfaces loudly
 * rather than silently writing inventory to the wrong warehouse.
 *
 * Memoized per Worker invocation: the result is cached on the request-scoped
 * `bc` client (keyed by storeHash, since bc.get accepts a storeHash override),
 * so repeated adjustments in one update_inventory call cost a single
 * `GET /v3/inventory/locations` subrequest instead of one per SKU. A fresh bc
 * is built per tool call (see mcp.js), so the cache never outlives the request
 * — preferred over a module-level (per-isolate) cache, which would persist
 * across unrelated requests and could serve a stale single-location id after a
 * store added a second location, silently bypassing the multi-location throw.
 */
export async function resolveInventoryLocationId(bc, storeHash) {
  const cache = (bc._inventoryLocationIdCache ||= new Map());
  if (cache.has(storeHash)) return cache.get(storeHash);

  const data = await bc.get("/v3/inventory/locations", { storeHash });
  const locations = data.data || [];
  if (locations.length === 0) {
    throw new Error(
      "No BigCommerce inventory locations found; cannot apply inventory adjustments."
    );
  }
  if (locations.length > 1) {
    const list = locations
      .map((l) => `${l.id} (${l.label || l.code || "unnamed"})`)
      .join(", ");
    throw new Error(
      `Multiple inventory locations found (${list}); update_inventory needs a single target location — pick one before writing.`
    );
  }
  const id = locations[0].id;
  cache.set(storeHash, id);
  return id;
}

/**
 * Compute EFFECTIVE visibility for every category in a tree.
 *
 * A category is effectively visible only if it AND every ancestor up to a root
 * (parent_id 0) has is_visible truthy — i.e. a shopper can actually reach it.
 * A node under a hidden ancestor is NOT effectively visible even if its own
 * is_visible flag is true. Returns a Map of category id -> boolean.
 *
 * `byId` must be a Map of id -> category record for the FULL tree, so ancestor
 * walks reach the true root regardless of any subtree filtering the caller
 * applies afterwards. Results are memoized, so total work is linear in the
 * number of categories rather than quadratic.
 *
 * Cycle / malformed-tree guard: each ancestor walk is capped at the category
 * count. If a chain exceeds the cap (only possible with a cycle or a broken
 * parent pointer), the node is treated as NOT visible and its id is logged,
 * so a bad BC tree fails safe instead of hanging the Worker.
 */
export function computeEffectiveVisibility(byId) {
  const effective = new Map();
  const cap = byId.size + 1;

  const resolve = (id) => {
    if (effective.has(id)) return effective.get(id);

    // Walk up the ancestor chain, collecting unresolved nodes until we hit a
    // root, a missing parent, an already-resolved node, or the cycle cap.
    const chain = [];
    let cur = byId.get(id);
    let steps = 0;
    let base; // visibility to fold the collected chain onto

    for (;;) {
      if (!cur) {
        base = true; // missing parent → treat the chain top as a root
        break;
      }
      if (effective.has(cur.id)) {
        base = effective.get(cur.id);
        break;
      }
      if (steps++ > cap) {
        console.log(
          `computeEffectiveVisibility: parent chain cap (${cap}) exceeded at category ${cur.id}; treating as not visible (possible cycle).`
        );
        base = false;
        break;
      }
      chain.push(cur);
      if (!cur.parent_id) {
        base = true; // reached a root (parent_id 0)
        break;
      }
      cur = byId.get(cur.parent_id);
    }

    // Fold from the topmost collected node down: each node is effectively
    // visible iff its own flag is truthy AND everything above it is too.
    let acc = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i];
      acc = acc && Boolean(node.is_visible);
      effective.set(node.id, acc);
    }
    return effective.get(id);
  };

  for (const id of byId.keys()) resolve(id);
  return effective;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Fetch EVERY page of a paginated BigCommerce v3 list endpoint, following
 * `meta.pagination.total_pages`. Never stops at page 1. `path` may already
 * carry a query string (e.g. filters / include_fields); `page` and `limit`
 * are appended per request. Returns the concatenated `data` arrays.
 *
 * The BC client already backs off on 429s, so this loops without extra delay.
 *
 * Subrequest guard: each page is one Cloudflare Workers subrequest, and the
 * Worker aborts opaquely once the platform's per-request subrequest limit is
 * hit (50 on the Free plan, 1000 on paid). To fail loudly and early instead,
 * a single sweep throws a clear error if it would exceed `maxPages` (default
 * 30 — deliberately below the Free-plan ceiling, leaving headroom for the
 * NON-pagination subrequests a single tool call also spends: resolveProduct,
 * the write itself, and read-back verification all share the same 50-subrequest
 * budget, so the cap cannot claim the whole ceiling for pagination). Raise
 * `maxPages` on a paid plan, or narrow the query, if a legitimate sweep needs
 * more pages.
 */
export async function fetchAllPages(
  bc,
  path,
  storeHash,
  { limit = 250, maxPages = 30 } = {}
) {
  const results = [];
  let page = 1;
  let pagesFetched = 0;
  for (;;) {
    if (pagesFetched >= maxPages) {
      throw new Error(
        `fetchAllPages exceeded its ${maxPages}-page subrequest cap while paginating "${path}" ` +
          `(fetched ${pagesFetched} pages, more remain). Each page is a Cloudflare Workers subrequest ` +
          `(limit 50 on Free, 1000 on paid), and the cap stays below that ceiling on purpose to leave ` +
          `room for the non-pagination subrequests in the same request (resolveProduct, the write, and ` +
          `read-back verification); raise maxPages or narrow the query.`
      );
    }

    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}${new URLSearchParams({
      page: String(page),
      limit: String(limit),
    })}`;
    const data = await bc.get(url, { storeHash });
    pagesFetched++;
    const batch = data.data || [];
    results.push(...batch);

    const pagination = data.meta && data.meta.pagination;
    const totalPages = pagination ? pagination.total_pages : 1;
    if (!pagination || page >= totalPages || batch.length === 0) break;
    page++;
  }
  return results;
}
