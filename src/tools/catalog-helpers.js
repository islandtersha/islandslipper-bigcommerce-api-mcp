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

  for (const group of chunk(skus.map(String), SKU_CHUNK_SIZE)) {
    const csv = group.join(",");

    // Variant SKUs -> product IDs via the variants endpoint.
    const variantData = await bc.get(
      `/v3/catalog/variants?${new URLSearchParams({ "sku:in": csv, limit: "250" })}`,
      { storeHash }
    );
    for (const v of variantData.data || []) {
      if (v.product_id != null) productIds.add(v.product_id);
    }

    // Base SKUs of simple products (no variant options) don't appear in the
    // variants endpoint, so also resolve via the products endpoint.
    const productData = await bc.get(
      `/v3/catalog/products?${new URLSearchParams({ "sku:in": csv, limit: "250" })}`,
      { storeHash }
    );
    for (const p of productData.data || []) {
      if (p.id != null) productIds.add(p.id);
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
 * Build a Map of sku -> { product_id, variant_id, inventory_level, ... } from
 * a list of product objects, indexing every variant SKU and every product's
 * base SKU (falling back to the product's first variant).
 */
export function indexVariantsBySku(products) {
  const map = new Map();
  for (const p of products) {
    const variants = p.variants || [];
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
 */
export async function resolveInventoryLocationId(bc, storeHash) {
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
  return locations[0].id;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
