#!/usr/bin/env node
/**
 * Read-only audit: find old static lead-time wording ("handmade in 2-3 weeks",
 * "allow 6-8 weeks", ...) that now contradicts the live PDP line
 * "Hand Made to Order — Allow N weeks" (N from the /lead-time Worker).
 *
 * Sources, each run independently (one failing doesn't stop the others):
 *   products  every product, visible and hidden: description,
 *             availability_description, warranty, custom fields
 *   pages     v3 /content/pages (body, meta_description)
 *   blog      v2 /blog/posts (title, summary, body, meta_description)
 *   theme     git grep of the theme repo (working tree, tracked files)
 * pages and blog need the Store Content (read) scope; on 403 that source is
 * reported as skipped and gets no CSV.
 *
 * GET requests only: the client below has no other method. Nothing is written
 * to BigCommerce or the theme repo.
 *
 * Usage (Node 18+, from the repo root; credentials come from .dev.vars):
 *   node scripts/audit-lead-time-wording.mjs
 *   node scripts/audit-lead-time-wording.mjs --only products,theme
 *   node scripts/audit-lead-time-wording.mjs --theme "C:\path\to\islandslipper-bc-theme-1"
 *   node scripts/audit-lead-time-wording.mjs --show-skipped   # list skipped live-code lines
 *
 * Writes reports/YYYYMMDD-N_lead-time-audit-{products,pages,blog,theme}.csv
 * (one N per run). Each row has a flag:
 *   range             a week range ("2-3 weeks", "6 to 8 weeks")
 *   fixed_weeks       a single week count ("3 weeks", "allow 4 weeks")
 *   ships_days_other  "ship(s) in/within N days" that isn't the 3-5 business days promise
 *   ok_in_stock       "ship(s) in 3-5 business days" (matches the PDP; fine)
 *   ok_no_number      made-to-order / lead-time wording with no number
 *   review            anything else the patterns caught
 * brand_spelling is set when the context says "Hawaiian" or "Hawaii"
 * (brand copy uses "Hawai'i").
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const DEFAULT_THEME_DIR = resolve(REPO_ROOT, "..", "islandslipper-bc-theme-1");

const SOURCES = ["products", "pages", "blog", "theme"];
const CONTEXT_CHARS = 50; // each side of the phrase (~100 total)
const RATE_LIMIT_FLOOR = 5;
const MAX_RETRIES = 5;

// Theme files that render the live lead time. Their strings are the current
// wording (or its fallback copy), not old static copy.
const THEME_LIVE_FILES = new Set([
  "assets/js/lib/lead-time.js",
  "assets/js/lib/ships-field.js",
  "assets/js/lib/cart-ship-notice.js",
  "assets/js/lib/fall-sale-cart-offer.js",
  "assets/js/theme/common/product-details-base.js",
  "assets/js/theme/common/product-details.js",
]);
const THEME_LIVE_LANG_KEYS = /"availability_(in_stock|made_to_order|last_call)"\s*:/;

// ---------------------------------------------------------------- matching

const NUM = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const DASH = "(?:-|–|—|to)";

const PATTERNS = [
  { name: "range_weeks", re: `\\b${NUM}\\s*${DASH}\\s*${NUM}(?:\\s+|-)?weeks?\\b` },
  { name: "n_weeks", re: `\\b${NUM}(?:\\s+|-)?weeks?\\b` },
  { name: "made_to_order", re: "\\bmade[- ]to[- ]order\\b" },
  { name: "handmade_in", re: "\\bhand[- ]?made in\\b" },
  {
    name: "ships_in",
    re: `\\bships? (?:in|within)\\b(?:\\s+${NUM}(?:\\s*${DASH}\\s*${NUM})?\\s*(?:business\\s+)?(?:days?|weeks?)\\b)?`,
  },
  { name: "lead_time", re: "\\blead[- ]?times?\\b" },
  { name: "allow_weeks", re: "\\ballow\\b[^.<\\n]{0,40}?\\bweeks?\\b" },
].map((p) => ({ ...p, re: new RegExp(p.re, "gi") }));

const RANGE_RE = new RegExp(`\\b${NUM}\\s*${DASH}\\s*${NUM}(?:\\s+|-)?weeks?\\b`, "i");
const WEEKS_RE = new RegExp(`\\b${NUM}(?:\\s+|-)?weeks?\\b`, "i");
const IN_STOCK_RE = /\bships? (?:in|within) 3\s*(?:-|–|—|to)\s*5 business days\b/i;
const SHIPS_DAYS_RE = new RegExp(`\\bships? (?:in|within)\\s+${NUM}`, "i");
const HAS_NUMBER_RE = new RegExp(`\\b${NUM}\\b`, "i");
// Only spaces/punctuation between two hits: treat them as one phrase.
const JOINABLE_GAP_RE = /^[\s\-–—:;,.()]{0,4}$/;

/** All lead-time phrases in text: [{ start, end, phrase, patterns }]. */
function findPhrases(text) {
  const hits = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      hits.push({ start: m.index, end: m.index + m[0].length, patterns: [name] });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && (h.start <= last.end || JOINABLE_GAP_RE.test(text.slice(last.end, h.start)))) {
      last.end = Math.max(last.end, h.end);
      for (const p of h.patterns) if (!last.patterns.includes(p)) last.patterns.push(p);
    } else {
      merged.push({ ...h, patterns: [...h.patterns] });
    }
  }
  return merged.map((h) => ({ ...h, phrase: text.slice(h.start, h.end) }));
}

function classify(phrase) {
  if (RANGE_RE.test(phrase)) return "range";
  if (WEEKS_RE.test(phrase)) return "fixed_weeks";
  if (IN_STOCK_RE.test(phrase)) return "ok_in_stock";
  if (SHIPS_DAYS_RE.test(phrase)) return "ships_days_other";
  if (!HAS_NUMBER_RE.test(phrase)) return "ok_no_number";
  return "review";
}

function brandSpelling(text) {
  const found = [];
  if (/\bhawaiian\b/i.test(text)) found.push("Hawaiian");
  if (/\bhawaii\b/i.test(text)) found.push("Hawaii");
  return found.join("; ");
}

/** Normalized phrase for counting: "2 to 3 Weeks" and "2–3 weeks" -> "2-3 weeks". */
function normalizePhrase(phrase) {
  return phrase
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(new RegExp(`(${NUM})\\s*(?:-|to)\\s*(${NUM})`, "gi"), "$1-$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Match rows for one block of text, with ~100 chars of context. */
function matchText(text) {
  return findPhrases(text).map((h) => {
    const from = Math.max(0, h.start - CONTEXT_CHARS);
    const to = Math.min(text.length, h.end + CONTEXT_CHARS);
    const context = `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
    return {
      flag: classify(h.phrase),
      pattern: h.patterns.join("+"),
      matched_phrase: h.phrase,
      context,
      brand_spelling: brandSpelling(context),
    };
  });
}

// ---------------------------------------------------------------- HTML -> text

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", okina: "ʻ",
};

function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- args / env

function parseArgs(argv) {
  const args = { only: SOURCES, themeDir: DEFAULT_THEME_DIR, showSkipped: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") {
      args.only = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const s of args.only) {
        if (!SOURCES.includes(s)) throw new Error(`--only: "${s}" is not one of ${SOURCES.join(", ")}`);
      }
    } else if (a === "--theme") args.themeDir = resolve(argv[++i] ?? "");
    else if (a === "--show-skipped") args.showSkipped = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
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

// ---------------------------------------------------------------- HTTP (GET only)

function createClient(storeHash, token) {
  const base = `https://api.bigcommerce.com/stores/${storeHash}`;
  const headers = { "X-Auth-Token": token, Accept: "application/json" };

  async function get(path) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(base + path, { method: "GET", headers });

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
        const err = new Error(`GET ${path.split("?")[0]} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : null;
    }
  }

  /** Every page of a v3 list endpoint. */
  async function getAllV3(path, params) {
    const out = [];
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({ ...params, limit: "250", page: String(page) });
      const json = await get(`${path}?${q}`);
      out.push(...(json?.data || []));
      const totalPages = json?.meta?.pagination?.total_pages ?? 1;
      if (page >= totalPages) return out;
    }
  }

  /** Every page of a v2 list endpoint (204 / short page = done). */
  async function getAllV2(path) {
    const out = [];
    for (let page = 1; ; page++) {
      const json = await get(`${path}?limit=250&page=${page}`);
      const rows = Array.isArray(json) ? json : [];
      out.push(...rows);
      if (rows.length < 250) return out;
    }
  }

  return { getAllV3, getAllV2 };
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

class ScopeError extends Error {}

/** 403 on a Store Content endpoint -> ScopeError (source skipped, not failed). */
async function withContentScope(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 403) {
      throw new ScopeError(`API account lacks the Store Content (read) scope; ${label} skipped.`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- sources

async function auditProducts(client) {
  const products = await client.getAllV3("/v3/catalog/products", {
    include_fields: "id,name,sku,is_visible,description,availability_description,warranty",
    include: "custom_fields",
  });
  const rows = [];
  for (const p of products) {
    const fields = [
      ["description", htmlToText(p.description)],
      ["availability_description", htmlToText(p.availability_description)],
      ["warranty", htmlToText(p.warranty)],
      ...(p.custom_fields || []).map((cf) => [
        `custom_field: ${cf.name}`,
        htmlToText(`${cf.name}: ${cf.value}`),
      ]),
    ];
    for (const [field, text] of fields) {
      for (const m of matchText(text)) {
        rows.push({ product_id: p.id, name: p.name, sku: p.sku, is_visible: p.is_visible, field, ...m });
      }
    }
  }
  return { scanned: `${products.length} products`, rows };
}

async function auditPages(client) {
  const pages = await withContentScope("web pages", () =>
    client.getAllV3("/v3/content/pages", { include: "body" })
  );
  const rows = [];
  for (const pg of pages) {
    for (const field of ["body", "meta_description"]) {
      for (const m of matchText(htmlToText(pg[field]))) {
        rows.push({ page_id: pg.id, name: pg.name, url: pg.url ?? "", is_visible: pg.is_visible, field, ...m });
      }
    }
  }
  return { scanned: `${pages.length} pages`, rows };
}

async function auditBlog(client) {
  const posts = await withContentScope("blog posts", () => client.getAllV2("/v2/blog/posts"));
  const rows = [];
  for (const post of posts) {
    for (const field of ["title", "summary", "body", "meta_description"]) {
      for (const m of matchText(htmlToText(post[field]))) {
        rows.push({
          post_id: post.id, title: post.title, url: post.url ?? "",
          is_published: post.is_published, field, ...m,
        });
      }
    }
  }
  return { scanned: `${posts.length} blog posts`, rows };
}

/** Why a theme hit is skipped, or null to report it. */
function themeSkipReason(file, text) {
  if (file.startsWith("assets/dist/") || file.startsWith("node_modules/")) return "generated";
  if (file.startsWith("assets/js/test-unit/") || file.endsWith(".spec.js")) return "test";
  if (THEME_LIVE_FILES.has(file)) return "live lead-time code";
  if (file === "lang/en.json" && THEME_LIVE_LANG_KEYS.test(text)) return "live availability string";
  return null;
}

function auditTheme(themeDir) {
  // Broad ERE prefilter; findPhrases() decides what actually matches.
  const ere =
    "([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[[:space:]-]*weeks?" +
    "|made[- ]to[- ]order|hand[- ]?made in|ships? (in|within)|lead[- ]?times?|allow";
  const res = spawnSync(
    "git",
    ["-c", "core.quotepath=off", "-C", themeDir, "grep", "-n", "-I", "-i", "-z", "-E", ere],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.error) throw res.error;
  if (res.status === 1) return { scanned: "theme repo", rows: [], skipped: [] };
  if (res.status !== 0) throw new Error(`git grep failed in ${themeDir}: ${res.stderr.trim()}`);

  const rows = [];
  const skipped = [];
  // CRLF files leave a "\r" that "." won't match.
  for (const raw of res.stdout.split(/\r?\n/)) {
    const m = raw.match(/^(.*?)\0(\d+)[\0:](.*)$/);
    if (!m) continue;
    const [, file, line, text] = m;
    const matches = matchText(text.trim());
    if (matches.length === 0) continue;
    const reason = themeSkipReason(file, text);
    for (const hit of matches) {
      const row = { file, line: Number(line), ...hit, text: text.trim().slice(0, 240) };
      delete row.context;
      if (reason) skipped.push({ ...row, reason });
      else rows.push(row);
    }
  }
  return { scanned: "theme repo (tracked files)", rows, skipped };
}

// ---------------------------------------------------------------- reports

const MATCH_COLS = ["field", "pattern", "flag", "matched_phrase", "context", "brand_spelling"];
const COLUMNS = {
  products: ["product_id", "name", "sku", "is_visible", ...MATCH_COLS],
  pages: ["page_id", "name", "url", "is_visible", ...MATCH_COLS],
  blog: ["post_id", "title", "url", "is_published", ...MATCH_COLS],
  theme: ["file", "line", "pattern", "flag", "matched_phrase", "text", "brand_spelling"],
};

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function reportPrefix() {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const taken = readdirSync(REPORTS_DIR);
  let n = 1;
  while (taken.some((f) => f.startsWith(`${date}-${n}_`))) n++;
  return `${date}-${n}`;
}

function writeReport(prefix, source, rows) {
  const file = join(REPORTS_DIR, `${prefix}_lead-time-audit-${source}.csv`);
  const cols = COLUMNS[source];
  const lines = [cols.join(",")];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(","));
  // BOM so Excel reads the dashes as UTF-8.
  writeFileSync(file, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
  return file;
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const needsApi = args.only.some((s) => s !== "theme");
  const client = needsApi
    ? (() => {
        const env = loadDevVars();
        return createClient(env.BC_STORE_HASH, env.BC_ACCESS_TOKEN);
      })()
    : null;

  const runners = {
    products: () => auditProducts(client),
    pages: () => auditPages(client),
    blog: () => auditBlog(client),
    theme: () => auditTheme(args.themeDir),
  };

  const prefix = reportPrefix();
  const results = {};
  for (const source of args.only) {
    process.stdout.write(`\n[${source}] scanning... `);
    try {
      const result = await runners[source]();
      result.file = writeReport(prefix, source, result.rows);
      results[source] = result;
      console.log(`${result.scanned}, ${result.rows.length} matches -> ${result.file}`);
    } catch (err) {
      results[source] = { error: err.message };
      console.log(err instanceof ScopeError ? `SKIPPED: ${err.message}` : `FAILED: ${err.message}`);
    }
  }

  printSummary(results, args.showSkipped);
}

function printSummary(results, showSkipped) {
  const flags = ["range", "fixed_weeks", "ships_days_other", "review", "ok_no_number", "ok_in_stock"];
  console.log("\n== Matches by source and flag ==");
  console.log(["source".padEnd(10), ...flags.map((f) => f.padStart(17)), "total".padStart(7)].join(""));
  for (const [source, r] of Object.entries(results)) {
    if (!r.rows) {
      console.log(`${source.padEnd(10)}${r.error}`);
      continue;
    }
    const counts = flags.map((f) => r.rows.filter((row) => row.flag === f).length);
    console.log([source.padEnd(10), ...counts.map((c) => String(c).padStart(17)), String(r.rows.length).padStart(7)].join(""));
    const brand = r.rows.filter((row) => row.brand_spelling).length;
    if (brand) console.log(`${"".padEnd(10)}brand_spelling (Hawaii/Hawaiian in context): ${brand}`);
  }

  const phrases = new Map();
  for (const [source, r] of Object.entries(results)) {
    for (const row of r.rows || []) {
      const key = `${row.flag}\t${normalizePhrase(row.matched_phrase)}`;
      if (!phrases.has(key)) phrases.set(key, { total: 0, bySource: {} });
      const p = phrases.get(key);
      p.total++;
      p.bySource[source] = (p.bySource[source] || 0) + 1;
    }
  }
  console.log("\n== Distinct phrases (most common first) ==");
  for (const [key, p] of [...phrases].sort((a, b) => b[1].total - a[1].total)) {
    const [flag, phrase] = key.split("\t");
    const where = Object.entries(p.bySource).map(([s, n]) => `${s} ${n}`).join(", ");
    console.log(`${String(p.total).padStart(5)}  ${flag.padEnd(17)} "${phrase}"  (${where})`);
  }

  const skipped = results.theme?.skipped;
  if (skipped?.length) {
    const byReason = {};
    for (const s of skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    console.log(`\n== Theme hits skipped: ${Object.entries(byReason).map(([k, n]) => `${k} ${n}`).join(", ")} ==`);
    if (showSkipped) {
      const seen = new Set();
      for (const s of skipped) {
        if (s.reason === "test" || s.reason === "generated") continue;
        const id = `${s.file}:${s.line}`;
        if (seen.has(id)) continue;
        seen.add(id);
        console.log(`  ${id}  ${s.text.slice(0, 150)}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
