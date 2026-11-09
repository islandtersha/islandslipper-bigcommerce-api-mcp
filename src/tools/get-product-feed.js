/**
 * get_product_feed — one compact row per product for a Pinterest (or other)
 * product feed and catalog checks. Read-only.
 *
 * Subrequests: every product page (limit 250, with variants + images), every
 * category page, and one brands page — about 4 for the current ~400-product
 * catalog, well inside the shared budget.
 *
 * Stock rules, by the product's inventory_tracking:
 *   "variant"  inventory_level = sum of variant levels; a variant is in stock
 *              when its level > 0 and purchasing isn't disabled
 *   "product"  inventory_level = the product's level; in stock when > 0
 *   "none"     untracked: inventory_level null, always in stock
 * A product whose availability is "disabled" (not purchasable) is never in
 * stock.
 */

import { fetchAllPages, computeEffectiveVisibility } from "./catalog-helpers.js";

export const STORE_URL = "https://shop.islandslipper.com";
const MAX_ADDITIONAL_IMAGES = 4;
const MAX_DESCRIPTION_CHARS = 500;

const PRODUCT_FIELDS = [
  "id",
  "sku",
  "name",
  "custom_url",
  "price",
  "sale_price",
  "inventory_level",
  "inventory_tracking",
  "availability",
  "categories",
  "brand_id",
  "description",
  "date_modified",
  "is_visible",
];

export const PINTEREST_COLUMNS = [
  "id",
  "title",
  "description",
  "link",
  "image_link",
  "additional_image_link",
  "price",
  "sale_price",
  "availability",
  "condition",
  "brand",
  "item_group_id",
  "google_product_category",
  "product_type",
];
const PINTEREST_BRAND = "Island Slipper";
const PINTEREST_GOOGLE_CATEGORY = "Apparel & Accessories > Shoes";

const executeFunction = async (
  { include_hidden = false, include_out_of_stock = true, format = "json", store_Hash } = {},
  { bc }
) => {
  try {
    if (format !== "json" && format !== "csv") {
      return { error: "`format` must be \"json\" or \"csv\"." };
    }

    const q = new URLSearchParams({
      include: "variants,images",
      include_fields: PRODUCT_FIELDS.join(","),
    });
    if (!include_hidden) q.set("is_visible", "true");

    const products = await fetchAllPages(bc, `/v3/catalog/products?${q}`, store_Hash);
    const categories = await fetchAllPages(bc, "/v3/catalog/categories", store_Hash);
    const brands = await fetchAllPages(bc, "/v3/catalog/brands?include_fields=name", store_Hash);

    const categoryInfo = buildCategoryInfo(categories);
    const brandNames = new Map(brands.map((b) => [b.id, b.name]));

    let rows = products.map((p) => feedRow(p, categoryInfo, brandNames));
    if (!include_out_of_stock) rows = rows.filter((r) => r.in_stock);

    if (format === "csv") return toPinterestCsv(rows);

    // Compact JSON (no pretty-printing) keeps a ~400-row feed small.
    return JSON.stringify({ meta: { total: rows.length }, data: rows.map(stripInternal) });
  } catch (error) {
    if (error && error.code) throw error; // marked errors (e.g. budget) propagate
    return {
      error: `An error occurred while building the product feed: ${error.message}`,
    };
  }
};

/**
 * Map category id -> { name, path, depth, visible } from the FULL category
 * list. `visible` is effective visibility (the node and every ancestor).
 */
export function buildCategoryInfo(categories) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const effective = computeEffectiveVisibility(byId);
  const info = new Map();
  for (const c of categories) {
    const names = [];
    const seen = new Set(); // cycle guard
    let cur = c;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
    info.set(c.id, {
      name: c.name,
      path: names.join(" > "),
      depth: names.length,
      visible: Boolean(effective.get(c.id)),
    });
  }
  return info;
}

// Depth ties: shopping-tree roots beat merchandising roots; other roots sit
// between the two.
const PREFERRED_ROOTS = new Set(["Men", "Women", "Accessories", "Clothing"]);
const MERCHANDISING_ROOTS = new Set(["Featured", "Sale", "Vault", "Shop By Outsole"]);

function rootRank(path) {
  const root = path.split(" > ")[0];
  if (PREFERRED_ROOTS.has(root)) return 0;
  if (MERCHANDISING_ROOTS.has(root)) return 2;
  return 1;
}

/**
 * The product_type path: the deepest of the product's categories, preferring
 * ones a shopper can reach (effectively visible). Depth ties go to
 * Men/Women/Accessories/Clothing paths over Featured/Sale/Vault/Shop By
 * Outsole, then to the alphabetically first path so the result is stable.
 * "" when uncategorized.
 */
export function deepestCategoryPath(categoryIds, categoryInfo) {
  const known = (categoryIds || []).map((id) => categoryInfo.get(id)).filter(Boolean);
  const pool = known.some((c) => c.visible) ? known.filter((c) => c.visible) : known;
  const better = (a, b) =>
    a.depth !== b.depth
      ? a.depth > b.depth
      : rootRank(a.path) !== rootRank(b.path)
        ? rootRank(a.path) < rootRank(b.path)
        : a.path < b.path;
  let best = null;
  for (const c of pool) {
    if (!best || better(c, best)) best = c;
  }
  return best ? best.path : "";
}

export function feedRow(p, categoryInfo, brandNames) {
  const images = [...(p.images || [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id
  );
  const primary = images.find((i) => i.is_thumbnail) || images[0] || null;
  const imageUrl = (i) => i.url_zoom || i.url_standard || null;

  const variants = p.variants || [];
  const purchasable = p.availability !== "disabled";
  let inventoryLevel;
  let variantsInStock;
  let inStock;
  if (p.inventory_tracking === "variant") {
    inventoryLevel = variants.reduce((sum, v) => sum + (v.inventory_level || 0), 0);
    variantsInStock = variants.filter((v) => v.inventory_level > 0 && !v.purchasing_disabled).length;
    inStock = purchasable && variantsInStock > 0;
  } else if (p.inventory_tracking === "product") {
    inventoryLevel = p.inventory_level ?? 0;
    inStock = purchasable && inventoryLevel > 0;
    variantsInStock = inStock ? variants.filter((v) => !v.purchasing_disabled).length : 0;
  } else {
    inventoryLevel = null;
    inStock = purchasable;
    variantsInStock = inStock ? variants.filter((v) => !v.purchasing_disabled).length : 0;
  }

  const path = p.custom_url && p.custom_url.url;
  return {
    product_id: p.id,
    sku: p.sku || null,
    name: p.name,
    url: path ? `${STORE_URL}${path}` : null,
    image_url: primary ? imageUrl(primary) : null,
    additional_image_urls: images
      .filter((i) => i !== primary)
      .map(imageUrl)
      .filter(Boolean)
      .slice(0, MAX_ADDITIONAL_IMAGES),
    price: p.price,
    sale_price: p.sale_price ? p.sale_price : null,
    inventory_level: inventoryLevel,
    in_stock: inStock,
    variant_count: variants.length,
    variants_in_stock: variantsInStock,
    // Unique names: different branches reuse names (e.g. two "Classic").
    categories: [
      ...new Set(
        (p.categories || [])
          .map((id) => categoryInfo.get(id))
          .filter(Boolean)
          .map((c) => c.name)
      ),
    ],
    brand_name: brandNames.get(p.brand_id) || null,
    description_text: htmlToText(p.description, MAX_DESCRIPTION_CHARS),
    date_modified: p.date_modified,
    // Internal: used for the CSV product_type column, not returned in JSON.
    _product_type: deepestCategoryPath(p.categories, categoryInfo),
  };
}

function stripInternal(row) {
  const { _product_type, ...rest } = row;
  return rest;
}

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  deg: "°",
  reg: "®",
  trade: "™",
  copy: "©",
  frac12: "½",
  eacute: "é",
};

/**
 * Strip HTML to plain text: drop script/style/comments, turn tags into spaces,
 * decode entities, collapse whitespace, and cut to `max` chars on a word
 * boundary (ending in "…" when cut).
 */
export function htmlToText(html, max = MAX_DESCRIPTION_CHARS) {
  if (!html) return "";
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => codePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => codePoint(parseInt(dec, 10), m))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  s = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, "");
  return `${s}…`;
}

function codePoint(n, fallback) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

const money = (n) => `${Number(n).toFixed(2)} USD`;

/**
 * Pinterest requires link and image_link, so rows missing either are left out
 * of the CSV (the JSON format still returns them, for catalog checks).
 */
export function toPinterestCsv(rows) {
  const lines = [PINTEREST_COLUMNS.join(",")];
  for (const r of rows) {
    if (!r.url || !r.image_url) continue;
    const record = {
      id: r.sku || String(r.product_id),
      title: r.name,
      description: r.description_text,
      link: r.url,
      image_link: r.image_url,
      additional_image_link: r.additional_image_urls.join(","),
      price: money(r.price),
      sale_price: r.sale_price ? money(r.sale_price) : "",
      availability: r.in_stock ? "in stock" : "out of stock",
      condition: "new",
      brand: PINTEREST_BRAND,
      item_group_id: String(r.product_id),
      google_product_category: PINTEREST_GOOGLE_CATEGORY,
      product_type: r._product_type,
    };
    lines.push(PINTEREST_COLUMNS.map((c) => csvField(record[c])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "get_product_feed",
      description:
        "Read-only. Compact catalog feed: one row per product, all pages fetched internally (no pagination needed). By default only storefront-visible products. JSON rows (default) have product_id, sku, name, url (full https://shop.islandslipper.com URL), image_url (primary image, zoom size), additional_image_urls (up to 4), price, sale_price (null when no sale), inventory_level (product total; summed over variants for variant-tracked products; null when inventory isn't tracked), in_stock, variant_count, variants_in_stock, categories (names), brand_name, description_text (plain text, max 500 chars) and date_modified, returned as { meta: { total }, data: [...] }. format=\"csv\" returns a Pinterest catalog feed with columns id,title,description,link,image_link,additional_image_link,price,sale_price,availability,condition,brand,item_group_id,google_product_category,product_type (id = SKU, item_group_id = product id, price like \"144.95 USD\", product_type = the deepest category path; rows with no URL or image are left out because Pinterest rejects them). Use this instead of get_all_products when you need URLs, images, stock or category names for the whole catalog.",
      parameters: {
        type: "object",
        properties: {
          include_hidden: {
            type: "boolean",
            description: "Default false. When true, hidden (not storefront-visible) products are included too.",
          },
          include_out_of_stock: {
            type: "boolean",
            description: "Default true. When false, only in-stock products are returned.",
          },
          format: {
            type: "string",
            enum: ["json", "csv"],
            description: "\"json\" (default) for compact rows, or \"csv\" for a Pinterest product feed.",
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
