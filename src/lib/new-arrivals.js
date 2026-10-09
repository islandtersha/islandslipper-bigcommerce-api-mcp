/**
 * New Arrivals rules — the ONE definition of "new", shared by the audit tool,
 * the sync tool, the daily cron, and (ported later) the storefront badges.
 *
 * Pure functions only: no network, no env, no clock. Callers pass `today` in,
 * so every rule is unit-testable and deterministic.
 *
 * Dates are plain "YYYY-MM-DD" strings (calendar days, no time of day), which
 * compare correctly as strings and avoid Date-object timezone surprises.
 *
 * The date rule:
 *   - Effective launch date = the `~launch_date` custom field if present and
 *     valid; otherwise `date_created` converted to its HST calendar date.
 *   - Valid = surrounding spaces trimmed, then strict YYYY-MM-DD that is a real
 *     calendar date. Anything else is malformed: fall back to date_created and
 *     flag it.
 *   - days = today_HST − effective date. New when 0 <= days < windowDays.
 *     A future date (days < 0) is not new yet.
 *
 * The membership rule:
 *   - Eligible = is_visible true AND in none of the excluded categories.
 *   - Target set = every eligible product inside the window. If fewer than
 *     minCount, top up with the eligible products that have the most recent
 *     effective dates outside the window. Future-dated products never top up.
 *   - Order = effective date newest first; ties broken by product id
 *     descending.
 *
 * The men's / women's subsets (115 / 116):
 *   - Members = the target set's products assigned to the root category
 *     (Men 1 / Women 3) or any of its descendants. Unisex products in both
 *     trees go in both; products in neither stay in 114 only.
 *   - Strict subsets of the target set: no top-up of their own (parent
 *     category pages show child products). They may be empty.
 *   - Order = the target set's order.
 */

export const LAUNCH_DATE_FIELD = "~launch_date";
export const LEGACY_NEW_FIELD = "~new";
export const DEFAULT_WINDOW_DAYS = 60;
export const DEFAULT_MIN_COUNT = 4;
export const DEFAULT_CATEGORY_ID = 114; // Featured > New
export const DEFAULT_MENS_CATEGORY_ID = 115; // Featured > New > New Men's Footwear
export const DEFAULT_WOMENS_CATEGORY_ID = 116; // Featured > New > New Women's Footwear
export const DEFAULT_MENS_ROOT_CATEGORY_ID = 1; // Men
export const DEFAULT_WOMENS_ROOT_CATEGORY_ID = 3; // Women
export const DEFAULT_EXCLUDE_CATEGORY_IDS = [113, 83, 84, 85]; // Last Call + Vault tree

/** Honolulu observes no daylight saving time: HST is a fixed UTC-10. */
const HST_OFFSET_MS = -10 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a `~launch_date` value. Returns
 *   { ok: true, date: "YYYY-MM-DD", trimmed }   — trimmed: spaces were removed
 *   { ok: false, reason }                       — malformed
 */
export function parseLaunchDate(raw) {
  if (raw === undefined || raw === null) return { ok: false, reason: "missing" };
  const str = String(raw);
  const value = str.trim();
  const trimmed = value !== str;
  if (value === "") return { ok: false, reason: "empty" };

  const m = value.match(ISO_DATE);
  if (!m) return { ok: false, reason: "not YYYY-MM-DD" };

  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d
  ) {
    return { ok: false, reason: "not a real calendar date" };
  }
  return { ok: true, date: value, trimmed };
}

/**
 * The HST calendar date ("YYYY-MM-DD") of an instant. Accepts a Date or an ISO
 * timestamp string (BigCommerce's date_created, e.g. "2026-10-07T21:03:11+00:00").
 * Returns null when the input isn't a valid instant.
 */
export function hstDateOf(instant) {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + HST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's HST calendar date. `now` is injectable for tests. */
export function todayHst(now = new Date()) {
  return hstDateOf(now);
}

/** Whole calendar days from `from` to `to` (both "YYYY-MM-DD"). */
export function daysBetween(from, to) {
  return dayNumber(to) - dayNumber(from);
}

function dayNumber(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

/**
 * All custom fields on a product whose name matches `name`, compared trimmed
 * and case-insensitively.
 */
export function findCustomFields(product, name) {
  const want = name.trim().toLowerCase();
  return (product.custom_fields || []).filter(
    (f) => String(f.name || "").trim().toLowerCase() === want
  );
}

/**
 * Resolve a product's effective launch date.
 *
 * Returns { date, source, launch_date_raw, issue, trimmed }:
 *   - date:   "YYYY-MM-DD" or null (no valid launch date AND no valid date_created)
 *   - source: "launch_date" | "date_created" | null
 *   - issue:  null, or { raw, reason } when ~launch_date exists but is unusable
 *             (malformed, or more than one ~launch_date field)
 *   - trimmed: true when a valid ~launch_date needed surrounding spaces removed
 */
export function effectiveLaunchDate(product) {
  const fields = findCustomFields(product, LAUNCH_DATE_FIELD);
  let issue = null;
  let trimmed = false;
  const raw = fields.length ? fields.map((f) => f.value) : null;

  if (fields.length > 1) {
    issue = { raw, reason: `${fields.length} ${LAUNCH_DATE_FIELD} fields` };
  } else if (fields.length === 1) {
    const parsed = parseLaunchDate(fields[0].value);
    if (parsed.ok) {
      return {
        date: parsed.date,
        source: "launch_date",
        launch_date_raw: fields[0].value,
        issue: null,
        trimmed: parsed.trimmed,
      };
    }
    issue = { raw: fields[0].value, reason: parsed.reason };
  }

  const created = product.date_created ? hstDateOf(product.date_created) : null;
  return {
    date: created,
    source: created ? "date_created" : null,
    launch_date_raw: fields.length === 1 ? fields[0].value : raw,
    issue,
    trimmed,
  };
}

/**
 * Where a date sits relative to the window:
 *   "future" (days < 0), "in_window" (0 <= days < windowDays), "outside",
 *   or "no_date" when there is no usable date.
 */
export function windowStatus(date, today, windowDays) {
  if (!date) return "no_date";
  const days = daysBetween(date, today);
  if (days < 0) return "future";
  if (days < windowDays) return "in_window";
  return "outside";
}

/**
 * Why a product isn't eligible, or null when it is. `excludeCategoryIds` is a
 * Set of numbers.
 */
export function ineligibleReason(product, excludeCategoryIds) {
  if (product.is_visible !== true) return "not visible";
  const hit = (product.categories || []).find((c) => excludeCategoryIds.has(Number(c)));
  if (hit !== undefined) return `in excluded category ${hit}`;
  return null;
}

/** Newest effective date first; ties by product id descending. */
export function compareNewestFirst(a, b) {
  if (a.effective.date !== b.effective.date) {
    return a.effective.date < b.effective.date ? 1 : -1;
  }
  return Number(b.id) - Number(a.id);
}

/**
 * Compute the New Arrivals target set.
 *
 * @param products  BigCommerce products with id, is_visible, categories,
 *                  date_created, custom_fields
 * @param options   { today, windowDays, excludeCategoryIds (array or Set), minCount }
 * @returns {{
 *   members: Array<{ id, product, effective, days, membership: "in_window"|"top_up", position }>,
 *   evaluated: Map<id, { product, effective, days, status, ineligible }>,
 *   today, windowDays, minCount, excludeCategoryIds: number[]
 * }}
 */
export function computeNewArrivals(
  products,
  {
    today,
    windowDays = DEFAULT_WINDOW_DAYS,
    excludeCategoryIds = DEFAULT_EXCLUDE_CATEGORY_IDS,
    minCount = DEFAULT_MIN_COUNT,
  } = {}
) {
  if (!today || !parseLaunchDate(today).ok) {
    throw new Error(`computeNewArrivals: \`today\` must be a YYYY-MM-DD date (got ${today}).`);
  }
  const exclude = new Set([...excludeCategoryIds].map(Number));

  const evaluated = new Map();
  for (const product of products) {
    const effective = effectiveLaunchDate(product);
    evaluated.set(product.id, {
      product,
      effective,
      days: effective.date ? daysBetween(effective.date, today) : null,
      status: windowStatus(effective.date, today, windowDays),
      ineligible: ineligibleReason(product, exclude),
    });
  }

  const row = (e, membership) => ({
    id: e.product.id,
    product: e.product,
    effective: e.effective,
    days: e.days,
    membership,
  });

  const eligible = [...evaluated.values()].filter((e) => !e.ineligible);
  const inWindow = eligible
    .filter((e) => e.status === "in_window")
    .map((e) => row(e, "in_window"))
    .sort(compareNewestFirst);

  let topUp = [];
  if (inWindow.length < minCount) {
    topUp = eligible
      .filter((e) => e.status === "outside")
      .map((e) => row(e, "top_up"))
      .sort(compareNewestFirst)
      .slice(0, minCount - inWindow.length);
  }

  const members = [...inWindow, ...topUp].map((m, i) => ({ ...m, position: i + 1 }));
  return {
    members,
    evaluated,
    today,
    windowDays,
    minCount,
    excludeCategoryIds: [...exclude],
  };
}

/**
 * Why an evaluated product (an entry of computeNewArrivals(...).evaluated) is
 * not in the target set, or null when it is a member.
 */
export function exclusionReason(entry, isMember, windowDays) {
  if (isMember) return null;
  if (entry.ineligible) return entry.ineligible;
  if (entry.status === "future") return `future launch date (${entry.effective.date})`;
  if (entry.status === "no_date") return "no usable launch date or date_created";
  return `outside the ${windowDays}-day window (${entry.days} days) and not needed for top-up`;
}

/**
 * Diff the target set against a category's current membership.
 *
 * @param members    computeNewArrivals(...).members (already in display order)
 * @param currentIds ids of products currently assigned to the category
 * @returns {{ add: id[], remove: id[], unchanged: id[], sort_order: Array<{product_id, sort_order}> }}
 *          sort_order covers every target member, 0-based in display order.
 */
export function planCategorySync(members, currentIds) {
  const current = new Set([...currentIds].map(Number));
  const target = members.map((m) => Number(m.id));
  const targetSet = new Set(target);
  return {
    add: target.filter((id) => !current.has(id)),
    remove: [...current].filter((id) => !targetSet.has(id)).sort((a, b) => a - b),
    unchanged: target.filter((id) => current.has(id)),
    sort_order: target.map((id, i) => ({ product_id: id, sort_order: i })),
  };
}

/**
 * Ids of `rootId` and every descendant. `categories` is the FULL category list
 * as category-tree records ({ category_id, parent_id }). Throws when the root
 * isn't in the list, so a renumbered or deleted root fails loudly instead of
 * silently emptying a subset category.
 */
export function subtreeIds(categories, rootId) {
  const children = new Map();
  let found = false;
  for (const c of categories) {
    const id = Number(c.category_id);
    if (id === rootId) found = true;
    const parent = Number(c.parent_id);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(id);
  }
  if (!found) throw new Error(`Category ${rootId} was not found in the category tree.`);
  const ids = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (!ids.has(child)) {
        ids.add(child);
        queue.push(child);
      }
    }
  }
  return ids;
}

/**
 * The target-set members assigned to any category in `treeIds`, keeping the
 * target set's order and renumbering positions from 1.
 */
export function subsetMembers(members, treeIds) {
  return members
    .filter((m) => (m.product.categories || []).some((c) => treeIds.has(Number(c))))
    .map((m, i) => ({ ...m, position: i + 1 }));
}

/**
 * Plan all three managed categories: the New Arrivals target set (114) and
 * its men's / women's subsets (115 / 116).
 *
 * @param products   the product sweep
 * @param categories the FULL category list (category-tree records)
 * @param config     readNewArrivalsConfig(...)
 * @param today      "YYYY-MM-DD"
 * @returns {{ result, targets: Array<{ key, label, categoryId, rootId, members,
 *            currentIds, plan, whyNot(id) }>, outsideTrees: members[] }}
 *          targets in write order: 114, 115, 116. outsideTrees = target-set
 *          members in neither root tree (a warning; membership is unaffected).
 */
export function planNewArrivals(products, categories, config, today) {
  const result = computeNewArrivals(products, {
    today,
    windowDays: config.windowDays,
    excludeCategoryIds: config.excludeCategoryIds,
    minCount: config.minCount,
  });
  const inTarget = new Set(result.members.map((m) => m.id));
  const managed = [config.categoryId, config.mensCategoryId, config.womensCategoryId];

  const subset = (key, label, categoryId, rootId) => {
    const tree = subtreeIds(categories, rootId);
    const inside = managed.filter((id) => tree.has(id));
    if (inside.length) {
      throw new Error(
        `Managed category ${inside.join(",")} sits inside root category ${rootId}'s tree; ` +
          `its own assignments would feed its membership. Move it or change the root.`
      );
    }
    return {
      key,
      label,
      categoryId,
      rootId,
      tree,
      members: subsetMembers(result.members, tree),
      whyNot: (id) =>
        inTarget.has(id)
          ? `not in category ${rootId} or any of its subcategories`
          : exclusionReason(result.evaluated.get(id), false, config.windowDays),
    };
  };

  const targets = [
    {
      key: "new",
      label: "New Arrivals",
      categoryId: config.categoryId,
      rootId: null,
      members: result.members,
      whyNot: (id) => exclusionReason(result.evaluated.get(id), inTarget.has(id), config.windowDays),
    },
    subset("mens", "New Men's Footwear", config.mensCategoryId, config.mensRootId),
    subset("womens", "New Women's Footwear", config.womensCategoryId, config.womensRootId),
  ].map((t) => {
    const currentIds = products
      .filter((p) => (p.categories || []).map(Number).includes(t.categoryId))
      .map((p) => p.id);
    return { ...t, currentIds, plan: planCategorySync(t.members, currentIds) };
  });

  // Warning only: target-set products in neither the Men nor the Women tree.
  // They stay in 114 and are listed so their categories can be fixed in admin.
  const inSubset = new Set(targets.slice(1).flatMap((t) => t.members.map((m) => m.id)));
  const outsideTrees = result.members.filter((m) => !inSubset.has(m.id));

  return { result, targets, outsideTrees };
}

/** Report rows for planNewArrivals(...).outsideTrees. */
export function outsideTreesWarning(outsideTrees, config) {
  return {
    message:
      `In the ${config.categoryId} target set but in neither the Men (${config.mensRootId}) nor the ` +
      `Women (${config.womensRootId}) tree, so in neither ${config.mensCategoryId} nor ` +
      `${config.womensCategoryId}. Warning only: fix their categories in BC admin.`,
    count: outsideTrees.length,
    products: outsideTrees.map((m) => ({
      id: m.id,
      name: m.product.name,
      sku: m.product.sku,
      categories: (m.product.categories || []).map(Number),
    })),
  };
}

/**
 * Resolve config from Worker env plus optional per-call overrides. Throws on
 * an invalid value so a typo in wrangler.toml fails loudly instead of syncing
 * the wrong category.
 */
export function readNewArrivalsConfig(env = {}, { window_days } = {}) {
  const categoryId = parsePositiveInt(
    env.NEW_ARRIVALS_CATEGORY_ID,
    DEFAULT_CATEGORY_ID,
    "NEW_ARRIVALS_CATEGORY_ID"
  );
  const mensCategoryId = parsePositiveInt(
    env.NEW_ARRIVALS_MENS_CATEGORY_ID,
    DEFAULT_MENS_CATEGORY_ID,
    "NEW_ARRIVALS_MENS_CATEGORY_ID"
  );
  const womensCategoryId = parsePositiveInt(
    env.NEW_ARRIVALS_WOMENS_CATEGORY_ID,
    DEFAULT_WOMENS_CATEGORY_ID,
    "NEW_ARRIVALS_WOMENS_CATEGORY_ID"
  );
  const mensRootId = parsePositiveInt(
    env.MENS_ROOT_CATEGORY_ID,
    DEFAULT_MENS_ROOT_CATEGORY_ID,
    "MENS_ROOT_CATEGORY_ID"
  );
  const womensRootId = parsePositiveInt(
    env.WOMENS_ROOT_CATEGORY_ID,
    DEFAULT_WOMENS_ROOT_CATEGORY_ID,
    "WOMENS_ROOT_CATEGORY_ID"
  );
  const windowDays =
    window_days !== undefined && window_days !== null
      ? parsePositiveInt(window_days, null, "window_days")
      : parsePositiveInt(env.NEW_ARRIVALS_WINDOW_DAYS, DEFAULT_WINDOW_DAYS, "NEW_ARRIVALS_WINDOW_DAYS");

  let excludeCategoryIds = DEFAULT_EXCLUDE_CATEGORY_IDS;
  const rawExclude = env.NEW_ARRIVALS_EXCLUDE_CATEGORY_IDS;
  if (rawExclude !== undefined && String(rawExclude).trim() !== "") {
    excludeCategoryIds = String(rawExclude)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parsePositiveInt(s, null, "NEW_ARRIVALS_EXCLUDE_CATEGORY_IDS"));
  }
  const managed = [categoryId, mensCategoryId, womensCategoryId];
  for (const id of managed) {
    if (excludeCategoryIds.includes(id)) {
      throw new Error(`NEW_ARRIVALS_EXCLUDE_CATEGORY_IDS includes managed New Arrivals category ${id}.`);
    }
  }
  const all = [...managed, mensRootId, womensRootId];
  if (new Set(all).size !== all.length) {
    throw new Error(
      `New Arrivals category ids must all differ (category ${categoryId}, men's ${mensCategoryId}, ` +
        `women's ${womensCategoryId}, men's root ${mensRootId}, women's root ${womensRootId}).`
    );
  }
  return {
    categoryId,
    mensCategoryId,
    womensCategoryId,
    mensRootId,
    womensRootId,
    windowDays,
    excludeCategoryIds,
    minCount: DEFAULT_MIN_COUNT,
  };
}

function parsePositiveInt(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (fallback === null) throw new Error(`${label} is required.`);
    return fallback;
  }
  const s = String(value).trim();
  if (!/^\d+$/.test(s) || Number(s) < 1) {
    throw new Error(`${label} must be a positive integer (got "${value}").`);
  }
  return Number(s);
}
