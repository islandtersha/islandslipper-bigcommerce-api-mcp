import { test } from "node:test";
import assert from "node:assert/strict";

import { apiTool as getAllProducts, buildProductsQuery } from "../src/tools/get-all-products.js";
import {
  apiTool as getProductFeed,
  buildCategoryInfo,
  deepestCategoryPath,
  feedRow,
  htmlToText,
  toPinterestCsv,
  PINTEREST_COLUMNS,
} from "../src/tools/get-product-feed.js";

/** Fake bc: records GET paths and answers from a handler. */
function fakeBc(handler) {
  return {
    subrequestCount: 0,
    paths: [],
    async get(path) {
      this.subrequestCount++;
      this.paths.push(path);
      return handler(path);
    },
  };
}

const CATEGORIES = [
  { id: 1, parent_id: 0, name: "Men", is_visible: true },
  { id: 2, parent_id: 1, name: "Classic", is_visible: true },
  { id: 3, parent_id: 0, name: "Featured", is_visible: true },
  { id: 4, parent_id: 3, name: "Classic", is_visible: true },
  { id: 5, parent_id: 0, name: "Hidden", is_visible: false },
  { id: 6, parent_id: 5, name: "Deep", is_visible: true },
  { id: 7, parent_id: 6, name: "Deeper", is_visible: true },
];

function product(overrides = {}) {
  return {
    id: 78,
    sku: "PT202",
    name: "Classic Leather",
    custom_url: { url: "/products/pt202/classic-leather" },
    price: 144.95,
    sale_price: 0,
    inventory_level: 0,
    inventory_tracking: "variant",
    availability: "available",
    categories: [2, 4],
    brand_id: 36,
    description: "<p>Hand made &amp; soft.</p>",
    date_modified: "2026-11-01T00:00:00+00:00",
    is_visible: true,
    variants: [
      { id: 1, inventory_level: 3, purchasing_disabled: false },
      { id: 2, inventory_level: 0, purchasing_disabled: false },
      { id: 3, inventory_level: 5, purchasing_disabled: true },
    ],
    images: [
      { id: 11, is_thumbnail: false, sort_order: 1, url_zoom: "z11", url_standard: "s11" },
      { id: 10, is_thumbnail: true, sort_order: 0, url_zoom: "z10", url_standard: "s10" },
      { id: 12, is_thumbnail: false, sort_order: 2, url_zoom: null, url_standard: "s12" },
    ],
    ...overrides,
  };
}

// --- get_all_products -------------------------------------------------------

test("get_all_products with no args makes the same bare call and returns the raw response", async () => {
  const raw = { data: [{ id: 1 }], meta: { pagination: { total: 403, total_pages: 9 } } };
  const bc = fakeBc(() => raw);
  const result = await getAllProducts.function({}, { bc });
  assert.deepEqual(bc.paths, ["/v3/catalog/products"]);
  assert.equal(result, raw);
});

test("get_all_products passes page, limit, include_fields, include and is_visible through", async () => {
  const bc = fakeBc(() => ({ data: [] }));
  await getAllProducts.function(
    { page: 2, limit: 100, include_fields: ["id", "sku"], include: ["images", "variants"], is_visible: true },
    { bc }
  );
  const q = new URLSearchParams(bc.paths[0].split("?")[1]);
  assert.equal(q.get("page"), "2");
  assert.equal(q.get("limit"), "100");
  assert.equal(q.get("include_fields"), "id,sku");
  assert.equal(q.get("include"), "images,variants");
  assert.equal(q.get("is_visible"), "true");
});

test("get_all_products fetch_all walks every page and returns meta.total", async () => {
  const bc = fakeBc((path) => {
    const q = new URLSearchParams(path.split("?")[1]);
    const page = Number(q.get("page"));
    assert.equal(q.get("limit"), "250");
    assert.equal(q.get("include_fields"), "id,sku,name");
    return {
      data: page === 1 ? Array.from({ length: 250 }, (_, i) => ({ id: i })) : [{ id: 250 }, { id: 251 }],
      meta: { pagination: { total: 252, total_pages: 2 } },
    };
  });
  const result = await getAllProducts.function(
    { fetch_all: true, include_fields: ["id", "sku", "name"], page: 5 },
    { bc }
  );
  assert.equal(bc.paths.length, 2);
  assert.equal(result.data.length, 252);
  assert.deepEqual(result.meta, { total: 252 });
});

test("get_all_products rejects a limit over 250 and a bad page", () => {
  assert.match(buildProductsQuery({ limit: 251 }).error, /limit/);
  assert.match(buildProductsQuery({ page: 0 }).error, /page/);
  assert.match(buildProductsQuery({ is_visible: "yes" }).error, /is_visible/);
  assert.equal(buildProductsQuery({}).query, "");
});

// --- get_product_feed helpers -----------------------------------------------

test("htmlToText strips tags, decodes entities, collapses whitespace and truncates", () => {
  assert.equal(
    htmlToText("<style>p{}</style><p>Hand&nbsp;made &amp; soft</p>\n<ul><li>Hawai&#699;i</li><li>&#x2014;</li></ul>"),
    "Hand made & soft Hawaiʻi —"
  );
  const long = htmlToText(`<p>${"word ".repeat(200)}</p>`, 500);
  assert.ok(long.length <= 500);
  assert.ok(long.endsWith("word…"));
  assert.equal(htmlToText(null), "");
});

test("deepestCategoryPath prefers visible categories, then depth, then shopping roots, then alphabetical", () => {
  const info = buildCategoryInfo([
    ...CATEGORIES,
    { id: 8, parent_id: 0, name: "Accessories", is_visible: true },
    { id: 9, parent_id: 8, name: "Hats", is_visible: true },
    { id: 10, parent_id: 0, name: "Gifts", is_visible: true },
    { id: 11, parent_id: 10, name: "Hats", is_visible: true },
  ]);
  assert.equal(deepestCategoryPath([4, 2], info), "Men > Classic");
  assert.equal(deepestCategoryPath([2, 9], info), "Accessories > Hats");
  // Other roots rank between the two groups.
  assert.equal(deepestCategoryPath([4, 11], info), "Gifts > Hats");
  assert.equal(deepestCategoryPath([11, 9], info), "Accessories > Hats");
  // 7 is deeper but sits under a hidden root, so the visible one wins.
  assert.equal(deepestCategoryPath([2, 7], info), "Men > Classic");
  assert.equal(deepestCategoryPath([7], info), "Hidden > Deep > Deeper");
  assert.equal(deepestCategoryPath([], info), "");
});

test("feedRow builds the compact row (variant tracking)", () => {
  const info = buildCategoryInfo(CATEGORIES);
  const row = feedRow(product(), info, new Map([[36, "Island Slipper"]]));
  assert.equal(row.url, "https://shop.islandslipper.com/products/pt202/classic-leather");
  assert.equal(row.image_url, "z10");
  assert.deepEqual(row.additional_image_urls, ["z11", "s12"]);
  assert.equal(row.sale_price, null);
  assert.equal(row.inventory_level, 8);
  assert.equal(row.variant_count, 3);
  assert.equal(row.variants_in_stock, 1);
  assert.equal(row.in_stock, true);
  assert.deepEqual(row.categories, ["Classic"]);
  assert.equal(row.brand_name, "Island Slipper");
  assert.equal(row.description_text, "Hand made & soft.");
  assert.equal(row._product_type, "Men > Classic");
});

test("feedRow stock rules for product, untracked and disabled products", () => {
  const info = buildCategoryInfo(CATEGORIES);
  const brands = new Map();
  const tracked = feedRow(product({ inventory_tracking: "product", inventory_level: 0 }), info, brands);
  assert.equal(tracked.in_stock, false);
  assert.equal(tracked.inventory_level, 0);
  const untracked = feedRow(product({ inventory_tracking: "none" }), info, brands);
  assert.equal(untracked.in_stock, true);
  assert.equal(untracked.inventory_level, null);
  const disabled = feedRow(product({ availability: "disabled" }), info, brands);
  assert.equal(disabled.in_stock, false);
  const noImages = feedRow(product({ images: [], sale_price: 99.5 }), info, brands);
  assert.equal(noImages.image_url, null);
  assert.deepEqual(noImages.additional_image_urls, []);
  assert.equal(noImages.sale_price, 99.5);
});

test("toPinterestCsv writes the Pinterest columns, quotes fields and skips rows with no image", () => {
  const info = buildCategoryInfo(CATEGORIES);
  const ok = feedRow(product({ name: 'Classic "Leather", Navy', sale_price: 99.5 }), info, new Map());
  const noImage = feedRow(product({ id: 99, sku: "X", images: [] }), info, new Map());
  const lines = toPinterestCsv([ok, noImage]).trimEnd().split("\n");
  assert.equal(lines[0], PINTEREST_COLUMNS.join(","));
  assert.equal(lines.length, 2);
  assert.equal(
    lines[1],
    'PT202,"Classic ""Leather"", Navy",Hand made & soft.,https://shop.islandslipper.com/products/pt202/classic-leather,z10,"z11,s12",144.95 USD,99.50 USD,in stock,new,Island Slipper,78,Apparel & Accessories > Shoes,Men > Classic'
  );
});

test("get_product_feed filters to visible products by default and returns compact JSON", async () => {
  const bc = fakeBc((path) => {
    if (path.startsWith("/v3/catalog/products")) {
      return {
        data: [product(), product({ id: 2, sku: "OUT", variants: [{ id: 9, inventory_level: 0 }] })],
        meta: { pagination: { total_pages: 1 } },
      };
    }
    if (path.startsWith("/v3/catalog/categories")) return { data: CATEGORIES, meta: { pagination: { total_pages: 1 } } };
    return { data: [{ id: 36, name: "Island Slipper" }], meta: { pagination: { total_pages: 1 } } };
  });
  const text = await getProductFeed.function({ include_out_of_stock: false }, { bc });
  assert.equal(new URLSearchParams(bc.paths[0].split("?")[1]).get("is_visible"), "true");
  const out = JSON.parse(text);
  assert.equal(out.meta.total, 1);
  assert.equal(out.data[0].sku, "PT202");
  assert.equal("_product_type" in out.data[0], false);
  assert.match((await getProductFeed.function({ format: "xml" }, { bc })).error, /format/);
});
