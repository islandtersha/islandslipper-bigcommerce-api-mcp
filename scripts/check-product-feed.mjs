#!/usr/bin/env node
/**
 * Read-only live check of get_all_products pagination, get_product_feed and
 * get_inventory_levels with a large SKU list. Calls the tools through the real
 * MCP dispatcher (src/mcp.js), so each tool gets its own subrequest budget just
 * as it does in the Worker. Only read tools are called; nothing is written to
 * BigCommerce.
 *
 * Usage (Node 18+, from the repo root; credentials come from .dev.vars):
 *   node scripts/check-product-feed.mjs
 *
 * Prints the counts, 3 sample feed rows, the CSV header, a CSV validity check
 * and every product with no image or URL. Writes the CSV feed to
 * reports/YYYYMMDD-N_pinterest-feed.csv.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { handleMcpMessage } from "../src/mcp.js";
import { PINTEREST_COLUMNS } from "../src/tools/get-product-feed.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const INVENTORY_SKU_COUNT = 400;

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(REPO_ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.BC_STORE_HASH || !env.BC_ACCESS_TOKEN) {
    throw new Error("Set BC_STORE_HASH and BC_ACCESS_TOKEN in .dev.vars.");
  }
  return env;
}

let rpcId = 0;
/** Call a tool; returns { text, json } where json is the parsed payload. */
async function callTool(env, name, args) {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } },
    env
  );
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  const text = res.result.content[0].text;
  if (res.result.isError) throw new Error(`${name}: ${text}`);
  // formatResult prefixes "Found N items:\n" before pretty JSON.
  const body = text.replace(/^Found \d+ items:\n/, "");
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // csv / plain text
  }
  return { text, json };
}

/** Minimal RFC 4180 parser: returns an array of records (arrays of fields). */
function parseCsv(text) {
  const records = [];
  let field = "";
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function reportPath(suffix) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const used = readdirSync(REPORTS_DIR)
    .map((f) => f.match(new RegExp(`^${day}-(\\d+)_`)))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const n = used.length ? Math.max(...used) + 1 : 1;
  return join(REPORTS_DIR, `${day}-${n}_${suffix}`);
}

const kb = (s) => `${(s.length / 1024).toFixed(0)} KB`;

async function main() {
  const env = loadEnv();

  console.log("== get_all_products");
  const first = await callTool(env, "get_all_products", {});
  const pagination = first.json.meta.pagination;
  console.log(
    `default (no args): ${first.json.data.length} rows, meta.pagination.total=${pagination.total}, ` +
      `total_pages=${pagination.total_pages}, response ${kb(first.text)}`
  );
  const all = await callTool(env, "get_all_products", {
    fetch_all: true,
    include_fields: ["id", "sku", "name"],
  });
  const ok = all.json.data.length === pagination.total;
  console.log(
    `fetch_all + include_fields [id,sku,name]: ${all.json.data.length} rows, meta.total=${all.json.meta.total} ` +
      `vs meta.pagination.total=${pagination.total} -> ${ok ? "MATCH" : "MISMATCH"}, response ${kb(all.text)}`
  );
  const page2 = await callTool(env, "get_all_products", { page: 2, limit: 100, include_fields: ["id"], is_visible: true });
  console.log(
    `page 2, limit 100, visible only: ${page2.json.data.length} rows (meta.pagination.total=${page2.json.meta.pagination.total})`
  );

  console.log("\n== get_product_feed (json)");
  const feed = await callTool(env, "get_product_feed", {});
  const rows = feed.json.data;
  console.log(`rows: ${rows.length} (visible products ${page2.json.meta.pagination.total}), response ${kb(feed.text)}`);
  console.log(`in stock: ${rows.filter((r) => r.in_stock).length}, out of stock: ${rows.filter((r) => !r.in_stock).length}`);
  console.log("3 sample rows:");
  for (const r of rows.slice(0, 3)) console.log(JSON.stringify(r, null, 2));

  const missing = rows.filter((r) => !r.image_url || !r.url);
  console.log(`\nproducts with a missing image or URL: ${missing.length}`);
  for (const r of missing) {
    const what = [!r.image_url && "image", !r.url && "url"].filter(Boolean).join("+");
    console.log(`  #${r.product_id} ${r.sku || "(no sku)"} ${r.name} -> missing ${what}`);
  }

  console.log("\n== get_product_feed (csv)");
  const csv = (await callTool(env, "get_product_feed", { format: "csv" })).text;
  const records = parseCsv(csv);
  const header = records[0];
  console.log(`header: ${header.join(",")}`);
  const headerOk = header.join(",") === PINTEREST_COLUMNS.join(",");
  const badWidth = records.slice(1).filter((r) => r.length !== header.length);
  const ids = records.slice(1).map((r) => r[0]);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  const col = (name) => header.indexOf(name);
  const badPrice = records.slice(1).filter((r) => !/^\d+\.\d{2} USD$/.test(r[col("price")]));
  console.log(
    `data rows: ${records.length - 1}, header ${headerOk ? "OK" : "WRONG"}, rows with wrong column count: ${badWidth.length}, ` +
      `duplicate ids: ${dupIds.length ? dupIds.join(" ") : 0}, bad price format: ${badPrice.length}, size ${kb(csv)}`
  );
  const out = reportPath("pinterest-feed.csv");
  writeFileSync(out, csv);
  console.log(`CSV written to ${out}`);

  console.log("\n== get_inventory_levels (large SKU list)");
  const withVariants = await callTool(env, "get_all_products", {
    fetch_all: true,
    include: ["variants"],
    include_fields: ["sku"],
  });
  const allSkus = [];
  for (const p of withVariants.json.data) {
    for (const v of p.variants || []) if (v.sku) allSkus.push(v.sku);
  }
  const skus = [...new Set(allSkus)].slice(0, INVENTORY_SKU_COUNT);
  const started = Date.now();
  const inv = await callTool(env, "get_inventory_levels", { skus });
  console.log(
    `${skus.length} SKUs in one call: ${inv.json.rows.length} rows, ${inv.json.missing_skus.length} missing_skus, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  if (inv.json.missing_skus.length) console.log(`  missing: ${JSON.stringify(inv.json.missing_skus.slice(0, 10))}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
