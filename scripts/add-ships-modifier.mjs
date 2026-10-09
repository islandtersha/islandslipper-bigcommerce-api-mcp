#!/usr/bin/env node
/**
 * One-off: add a hidden, optional "Ships" text modifier to every footwear
 * product, so the theme (v0.14.0+) can stamp the delivery promise the shopper
 * saw onto the line item.
 *
 * Why a script: the API can't assign a SHARED modifier to products, and admin
 * does it one product at a time. The theme finds the field by its display name,
 * so a product-level text modifier named "Ships" behaves the same.
 *
 * Scope (resolved from the live category list on every run):
 *   - products in the Men tree (top-level category /men) or the Women tree
 *     (top-level /women), including every subcategory, plus
 *   - Last Call category 113 (and any subcategory under it).
 * Everything else (accessories, ornaments, towels, gift bundles, ...) gets
 * nothing, so their category cards keep "Add to Cart".
 *
 * Usage (Node 18+, from the repo root; credentials come from .dev.vars):
 *   node scripts/add-ships-modifier.mjs                 # dry run (default)
 *   node scripts/add-ships-modifier.mjs --ids 497,107   # dry run, these only
 *   node scripts/add-ships-modifier.mjs --apply --ids 497,107
 *   node scripts/add-ships-modifier.mjs --apply
 *   node scripts/add-ships-modifier.mjs --exclude-ids 212,446,234,236,237,326,419,999
 *   node scripts/add-ships-modifier.mjs --check-scope   # API-scope probe, see below
 *
 * Writes a CSV report to reports/YYYYMMDD-N_ships-modifier-{dryrun|apply}.csv.
 * Ships gets a sort_order after every variant option and other modifier, so it
 * comes last in the PDP form.
 * Re-runnable: a product whose Ships already sorts last is skipped. A
 * product-level Ships that sorts before an option gets its sort_order fixed;
 * a shared Ships (product 492) is never touched.
 * Writes: POST /v3/catalog/products/{id}/modifiers (create) and
 * PUT /v3/catalog/products/{id}/modifiers/{modifier_id} with only sort_order.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = join(REPO_ROOT, "reports");

const SHIPS_NAME = "Ships";
const LAST_CALL_CATEGORY_ID = 113;
const TREE_ROOT_URLS = ["/men/", "/women/"];
// Gift Card product, TEST, Men's Crew shirts, Face Shield, Fukubukro (non-footwear
// sitting in the Men tree).
const DEFAULT_EXCLUDE_IDS = "212,446,234,236,237,326,419";
const ID_CHUNK = 50;
// Pause when this few requests remain in the current rate-limit window.
const RATE_LIMIT_FLOOR = 5;
const MAX_RETRIES = 5;

// Product-level twin of product 492's shared "Ships" modifier: optional text,
// empty default, no length limit, no price/weight adjusters.
const MODIFIER_PAYLOAD = {
  type: "text",
  display_name: SHIPS_NAME,
  required: false,
  config: { default_value: "", text_characters_limited: false },
};

// ---------------------------------------------------------------- args / env

function parseArgs(argv) {
  const args = { apply: false, ids: null, excludeIds: DEFAULT_EXCLUDE_IDS, checkScope: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a === "--check-scope") args.checkScope = true;
    else if (a === "--ids") args.ids = argv[++i];
    else if (a === "--exclude-ids") args.excludeIds = argv[++i] ?? "";
    else throw new Error(`Unknown argument: ${a}`);
  }
  return {
    ...args,
    ids: args.ids == null ? null : parseIdList(args.ids, "--ids"),
    excludeIds: new Set(parseIdList(args.excludeIds, "--exclude-ids")),
  };
}

function parseIdList(text, flag) {
  if (text == null) throw new Error(`${flag} needs a comma-separated list of product IDs`);
  const ids = String(text)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`${flag}: "${id}" is not a product ID`);
  }
  return ids.map(Number);
}

/** Read KEY=value / KEY="value" lines from .dev.vars. Never logged. */
function loadDevVars() {
  const path = join(REPO_ROOT, ".dev.vars");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Can't read ${path}. Copy .dev.vars.example and fill in BC_STORE_HASH / BC_ACCESS_TOKEN.`);
  }
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    vars[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!vars.BC_STORE_HASH || !vars.BC_ACCESS_TOKEN) {
    throw new Error(".dev.vars must set BC_STORE_HASH and BC_ACCESS_TOKEN");
  }
  return vars;
}

// ---------------------------------------------------------------- HTTP

function createClient(storeHash, token) {
  const base = `https://api.bigcommerce.com/stores/${storeHash}`;
  const headers = {
    "X-Auth-Token": token,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(res));
        continue;
      }

      // Stay under the window instead of waiting for a 429.
      const left = Number(res.headers.get("X-Rate-Limit-Requests-Left"));
      if (Number.isFinite(left) && left <= RATE_LIMIT_FLOOR) {
        await sleep(Number(res.headers.get("X-Rate-Limit-Time-Reset-Ms")) || 1000);
      }

      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : {};
    }
  }

  /** GET every page of a v3 list endpoint. */
  async function getAll(path, params) {
    const out = [];
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({ ...params, limit: "250", page: String(page) });
      const json = await request("GET", `${path}?${q}`);
      out.push(...(json.data || []));
      const totalPages = json.meta?.pagination?.total_pages ?? 1;
      if (page >= totalPages) return out;
    }
  }

  return { request, getAll };
}

function retryDelayMs(res) {
  const retryAfter = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const resetMs = Number(res.headers.get("X-Rate-Limit-Time-Reset-Ms"));
  if (Number.isFinite(resetMs) && resetMs > 0) return resetMs;
  return 1000;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- scope

/**
 * Map category id -> label of the scope root it falls under ("Men", "Women",
 * "Last Call 113"), for every category in the three trees.
 */
function resolveScopeCategories(categories) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const children = new Map();
  for (const c of categories) {
    if (!children.has(c.parent_id)) children.set(c.parent_id, []);
    children.get(c.parent_id).push(c);
  }

  const roots = [];
  for (const url of TREE_ROOT_URLS) {
    const matches = categories.filter(
      (c) => c.parent_id === 0 && normalizeUrl(c.custom_url?.url) === url
    );
    if (matches.length !== 1) {
      throw new Error(`Expected one top-level category at ${url}, found ${matches.length}`);
    }
    roots.push({ id: matches[0].id, label: matches[0].name });
  }
  const lastCall = byId.get(LAST_CALL_CATEGORY_ID);
  if (!lastCall) throw new Error(`Last Call category ${LAST_CALL_CATEGORY_ID} not found`);
  roots.push({ id: lastCall.id, label: `Last Call ${lastCall.id}` });

  const scope = new Map();
  for (const root of roots) {
    const stack = [root.id];
    while (stack.length) {
      const id = stack.pop();
      if (!scope.has(id)) scope.set(id, root.label);
      for (const child of children.get(id) || []) stack.push(child.id);
    }
  }
  return { scope, roots };
}

function normalizeUrl(url) {
  if (!url) return "";
  let u = url.trim().toLowerCase();
  if (!u.startsWith("/")) u = `/${u}`;
  if (!u.endsWith("/")) u = `${u}/`;
  return u;
}

/** Which scope roots a product's categories fall under, e.g. "Men; Last Call 113". */
function scopeMatch(product, scope) {
  const labels = new Set();
  for (const id of product.categories || []) {
    if (scope.has(id)) labels.add(scope.get(id));
  }
  return [...labels].sort().join("; ");
}

// ---------------------------------------------------------------- data

async function fetchProducts(bc, ids) {
  const fields = { include_fields: "id,name,sku,is_visible,categories" };
  if (!ids) return bc.getAll("/v3/catalog/products", fields);
  const out = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    out.push(...(await bc.getAll("/v3/catalog/products", { ...fields, "id:in": ids.slice(i, i + ID_CHUNK).join(",") })));
  }
  return out;
}

/** Set of product IDs that have at least one variant with option values. */
async function fetchProductsWithVariantOptions(bc, ids) {
  const fields = { include_fields: "product_id,option_values" };
  const variants = [];
  if (!ids) {
    variants.push(...(await bc.getAll("/v3/catalog/variants", fields)));
  } else {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      variants.push(
        ...(await bc.getAll("/v3/catalog/variants", { ...fields, "product_id:in": ids.slice(i, i + ID_CHUNK).join(",") }))
      );
    }
  }
  const withOptions = new Set();
  for (const v of variants) {
    if ((v.option_values || []).length > 0) withOptions.add(v.product_id);
  }
  return withOptions;
}

function isShips(modifier) {
  const name = String(modifier.display_name ?? modifier.name ?? "").trim().toLowerCase();
  return name === SHIPS_NAME.toLowerCase();
}

/**
 * The sort_order that puts Ships after every variant option and every other
 * modifier on the PDP (options and modifiers share one ordering).
 */
function shipsSortOrder(options, modifiers) {
  const others = [...options, ...modifiers.filter((m) => !isShips(m))];
  return Math.max(-1, ...others.map((o) => Number(o.sort_order) || 0)) + 1;
}

function describeModifiers(modifiers) {
  return modifiers
    .map((m) => `${m.display_name} (${m.type}${m.shared_option_id ? `, shared ${m.shared_option_id}` : ""})`)
    .join("; ");
}

// ---------------------------------------------------------------- report

const CSV_COLUMNS = [
  "product_id",
  "name",
  "sku",
  "is_visible",
  "has_variant_options",
  "in_scope",
  "existing_modifiers",
  "action",
  "modifier_id",
  "sort_order",
  "error",
];

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeReport(rows, apply) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const kind = apply ? "apply" : "dryrun";
  const taken = new Set(readdirSync(REPORTS_DIR));
  let n = 1;
  while ([...taken].some((f) => f.startsWith(`${date}-${n}_`))) n++;
  const file = join(REPORTS_DIR, `${date}-${n}_ships-modifier-${kind}.csv`);
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  writeFileSync(file, `${lines.join("\r\n")}\r\n`, "utf8");
  return file;
}

// ---------------------------------------------------------------- main

/**
 * Prove the token can write modifiers without creating one: POST an empty body
 * to the first in-scope product's modifiers. 422 (validation) means the scope
 * is there; 403 means Products: Modify is missing. An empty body can't create
 * anything (type / display_name / required are all required).
 */
async function checkWriteScope(bc, productId) {
  try {
    await bc.request("POST", `/v3/catalog/products/${productId}/modifiers`, {});
    return "UNEXPECTED: empty POST succeeded — check the product's modifiers";
  } catch (err) {
    if (err.status === 422) return "OK (HTTP 422 on an empty body: token can write modifiers)";
    if (err.status === 403) return "MISSING (HTTP 403: token lacks Products: Modify)";
    return `UNKNOWN (${err.message})`;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadDevVars();
  const bc = createClient(env.BC_STORE_HASH, env.BC_ACCESS_TOKEN);

  console.log(`Mode: ${args.apply ? "APPLY" : "dry run"}${args.ids ? ` (ids ${args.ids.join(",")})` : " (all products)"}`);
  console.log(`Excluded ids: ${[...args.excludeIds].join(",") || "(none)"}`);

  const categories = await bc.getAll("/v3/catalog/categories", {
    include_fields: "id,parent_id,name,custom_url",
  });
  const { scope, roots } = resolveScopeCategories(categories);
  console.log(`Scope roots: ${roots.map((r) => `${r.label} (${r.id})`).join(", ")}; ${scope.size} categories in scope`);

  const products = (await fetchProducts(bc, args.ids)).sort((a, b) => a.id - b.id);
  if (args.ids) {
    const found = new Set(products.map((p) => p.id));
    const missing = args.ids.filter((id) => !found.has(id));
    if (missing.length) console.warn(`Not found: ${missing.join(",")}`);
  }
  const withOptions = await fetchProductsWithVariantOptions(bc, args.ids);

  const rows = [];
  for (const [i, p] of products.entries()) {
    const match = scopeMatch(p, scope);
    const row = {
      product_id: p.id,
      name: p.name,
      sku: p.sku,
      is_visible: p.is_visible ? "Y" : "N",
      has_variant_options: withOptions.has(p.id) ? "Y" : "N",
      in_scope: match ? `Y (${match})` : "N",
      existing_modifiers: "",
      action: "",
      modifier_id: "",
      sort_order: "",
      error: "",
    };
    rows.push(row);

    try {
      const modifiers = await bc.getAll(`/v3/catalog/products/${p.id}/modifiers`, {});
      row.existing_modifiers = describeModifiers(modifiers);
      const ships = modifiers.find(isShips);

      if (args.excludeIds.has(p.id)) row.action = "skip_excluded";
      else if (!match) row.action = "skip_out_of_scope";
      else if (ships?.shared_option_id) {
        // Shared modifier (492): managed in admin, never touched here.
        row.action = "skip_has_ships";
        row.modifier_id = ships.id;
        row.sort_order = ships.sort_order;
      } else {
        const options = await bc.getAll(`/v3/catalog/products/${p.id}/options`, {});
        const target = shipsSortOrder(options, modifiers);
        if (!ships) {
          row.action = "create";
          row.sort_order = target;
          if (args.apply) {
            const created = await bc.request("POST", `/v3/catalog/products/${p.id}/modifiers`, {
              ...MODIFIER_PAYLOAD,
              sort_order: target,
            });
            row.modifier_id = created.data?.id ?? "";
          }
        } else if ((Number(ships.sort_order) || 0) < target) {
          // Already has Ships, but it sorts before a variant option.
          row.action = "fix_sort_order";
          row.modifier_id = ships.id;
          row.sort_order = `${ships.sort_order} -> ${target}`;
          if (args.apply) {
            await bc.request("PUT", `/v3/catalog/products/${p.id}/modifiers/${ships.id}`, { sort_order: target });
          }
        } else {
          row.action = "skip_has_ships";
          row.modifier_id = ships.id;
          row.sort_order = ships.sort_order;
        }
      }
    } catch (err) {
      row.action = "error";
      row.error = err.message;
    }

    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${products.length}`);
  }

  const file = writeReport(rows, args.apply);

  const count = (fn) => rows.filter(fn).length;
  const inScope = rows.filter((r) => r.in_scope !== "N");
  const inScopeNoOptions = inScope.filter((r) => r.has_variant_options === "N");
  console.log("");
  console.log(`Products:              ${rows.length}`);
  console.log(`In scope:              ${inScope.length}`);
  console.log(`Out of scope:          ${rows.length - inScope.length}`);
  console.log(`${(args.apply ? "Created:" : "Would create:").padEnd(23)}${count((r) => r.action === "create")}`);
  console.log(`${(args.apply ? "Fixed sort_order:" : "Would fix sort_order:").padEnd(23)}${count((r) => r.action === "fix_sort_order")}`);
  console.log(`skip_has_ships:        ${count((r) => r.action === "skip_has_ships")}`);
  console.log(`skip_out_of_scope:     ${count((r) => r.action === "skip_out_of_scope")}`);
  console.log(`skip_excluded:         ${count((r) => r.action === "skip_excluded")}`);
  console.log(`error:                 ${count((r) => r.action === "error")}`);
  console.log(`In scope, no variant options: ${inScopeNoOptions.length}`);
  for (const r of inScopeNoOptions) {
    console.log(`  ${r.product_id} ${r.is_visible === "Y" ? "visible" : "hidden "} ${r.sku || "-"} | ${r.name} | ${r.in_scope} | ${r.action}`);
  }

  if (args.checkScope) {
    const probe = inScope.find((r) => r.action !== "error") ?? rows[0];
    if (probe) console.log(`Write scope (probe on ${probe.product_id}): ${await checkWriteScope(bc, probe.product_id)}`);
  }

  console.log(`Report: ${file}`);
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
