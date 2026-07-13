/**
 * get_daily_sales — daily sales summary for a single HST (Pacific/Honolulu)
 * calendar day.
 *
 * Honolulu observes no daylight saving time, so HST is a fixed UTC-10 offset.
 * We bound the day using that offset and query the BigCommerce Orders API v2,
 * then exclude non-revenue statuses and aggregate.
 */

// Order statuses that should NOT count toward sales.
//   0 = Incomplete, 5 = Cancelled, 6 = Declined, 14 = Refunded
const EXCLUDED_STATUS_IDS = new Set([0, 5, 6, 14]);

const HST_OFFSET = "-10:00";

const executeFunction = async ({ date } = {}, { bc }) => {
  try {
    const targetDate = date || hstYesterday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return { error: `Invalid date "${targetDate}"; expected YYYY-MM-DD.` };
    }

    const { min, max } = hstDayBoundsUtc(targetDate);

    // 1. Pull every order created within the HST day (paginated).
    const orders = await fetchOrdersInRange(bc, min, max);

    // 2. Drop non-revenue statuses.
    const valid = orders.filter((o) => !EXCLUDED_STATUS_IDS.has(Number(o.status_id)));

    // 3. P&L aggregates — all summed from fields BigCommerce already returns on
    //    each order, so no extra API calls are needed here.
    let subtotalExTax = 0; // sum of subtotal_ex_tax
    let shippingTotal = 0; // sum of shipping_cost_ex_tax
    let taxTotal = 0; // sum of total_tax
    let discountTotal = 0; // sum of discount_amount + coupon_discount
    let gross = 0; // sum of total_inc_tax
    let refundTotal = 0; // sum of refunded_amount
    for (const o of valid) {
      subtotalExTax += num(o.subtotal_ex_tax);
      shippingTotal += num(o.shipping_cost_ex_tax);
      taxTotal += num(o.total_tax);
      discountTotal += num(o.discount_amount) + num(o.coupon_discount);
      gross += num(o.total_inc_tax);
      refundTotal += num(o.refunded_amount);
    }
    const orderCount = valid.length;
    const net = gross - refundTotal;
    const aov = orderCount > 0 ? gross / orderCount : 0;

    // 4. SKU-level aggregates require each order's line items.
    const { unitsBySku, revenueBySku } = await aggregateSkus(bc, valid);

    return {
      date: targetDate,
      timezone: "Pacific/Honolulu",
      order_count: orderCount,
      subtotal_ex_tax: round2(subtotalExTax),
      shipping_total: round2(shippingTotal),
      tax_total: round2(taxTotal),
      discount_total: round2(discountTotal),
      gross_revenue: round2(gross),
      refund_total: round2(refundTotal),
      net_revenue: round2(net),
      average_order_value: round2(aov),
      top_5_skus_by_units: topN(unitsBySku, 5, "units"),
      top_5_skus_by_revenue: topN(revenueBySku, 5, "revenue"),
    };
  } catch (error) {
    return {
      error: `An error occurred while computing daily sales: ${error.message}`,
    };
  }
};

/** Yesterday's date (YYYY-MM-DD) in the HST calendar. */
function hstYesterday() {
  const now = new Date();
  const hstNow = new Date(now.getTime() - 10 * 60 * 60 * 1000);
  hstNow.setUTCDate(hstNow.getUTCDate() - 1);
  return hstNow.toISOString().slice(0, 10);
}

/** Convert an HST calendar day into inclusive UTC ISO bounds for the BC filter. */
function hstDayBoundsUtc(dateStr) {
  const start = new Date(`${dateStr}T00:00:00${HST_OFFSET}`);
  // Inclusive max: last instant before the next HST midnight.
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1000);
  return { min: start.toISOString(), max: end.toISOString() };
}

async function fetchOrdersInRange(bc, min, max) {
  const orders = [];
  const limit = 250;
  let page = 1;
  for (;;) {
    const q = new URLSearchParams({
      min_date_created: min,
      max_date_created: max,
      limit: String(limit),
      page: String(page),
    });
    const data = await bc.get(`/v2/orders?${q}`);
    const batch = Array.isArray(data) ? data : data.data || [];
    if (batch.length === 0) break;
    orders.push(...batch);
    if (batch.length < limit) break;
    page++;
  }
  return orders;
}

async function aggregateSkus(bc, orders) {
  const unitsBySku = new Map();
  const revenueBySku = new Map();

  // Fetch order line items with limited concurrency to avoid hammering the API.
  const lineItemLists = await mapWithConcurrency(orders, 4, (order) =>
    bc.get(`/v2/orders/${order.id}/products?limit=250`).then((data) =>
      Array.isArray(data) ? data : data.data || []
    )
  );

  for (const lines of lineItemLists) {
    for (const line of lines) {
      const sku = line.sku || `(no-sku:product_${line.product_id})`;
      const qty = num(line.quantity);
      const revenue = num(line.total_inc_tax);
      unitsBySku.set(sku, (unitsBySku.get(sku) || 0) + qty);
      revenueBySku.set(sku, (revenueBySku.get(sku) || 0) + revenue);
    }
  }

  return { unitsBySku, revenueBySku };
}

function topN(map, n, valueKey) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([sku, value]) => ({
      sku,
      [valueKey]: valueKey === "revenue" ? round2(value) : value,
    }));
}

/** Run `fn` over items with at most `concurrency` in flight; preserves order. */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "get_daily_sales",
      description:
        "Daily P&L summary of BigCommerce sales for the given HST (Pacific/Honolulu) calendar date (defaults to yesterday in HST). Excludes Incomplete, Cancelled, Declined, and Refunded orders. Returns order count; subtotal_ex_tax, shipping_total, tax_total, discount_total, gross_revenue, refund_total, net_revenue, and average_order_value; plus the top 5 SKUs by units and by revenue.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description:
              "Target day as an ISO date (YYYY-MM-DD), interpreted in the HST/Pacific/Honolulu timezone. Optional; defaults to yesterday in HST.",
          },
        },
        required: [],
      },
    },
  },
};

export { apiTool };
