/**
 * Shared BigCommerce Catalog v3 helpers used by the inventory tools.
 */

/** BigCommerce caps `sku:in` URLs; chunk large SKU lists to stay safe. */
const SKU_CHUNK_SIZE = 50;

/**
 * Fetch products (with variants) for a set of SKUs, transparently chunking the
 * `sku:in` filter. Returns the flat list of product objects.
 */
export async function fetchProductsBySkus(bc, skus, storeHash) {
  const products = [];
  for (const group of chunk(skus.map(String), SKU_CHUNK_SIZE)) {
    const q = new URLSearchParams({
      "sku:in": group.join(","),
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
  const q = new URLSearchParams({
    "id:in": String(productId),
    include: "variants",
    limit: "250",
  });
  const data = await bc.get(`/v3/catalog/products?${q}`, { storeHash });
  return data.data || [];
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

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
