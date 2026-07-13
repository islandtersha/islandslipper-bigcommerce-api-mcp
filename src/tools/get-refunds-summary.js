/**
 * get_refunds_summary — refund activity within an HST (Pacific/Honolulu) date
 * window. Complements get_daily_sales: it answers "what refunds happened in
 * this window" rather than "what did we sell."
 *
 * Honolulu observes no daylight saving time, so HST is a fixed UTC-10 offset.
 * Uses the BigCommerce Refunds API (v3), paginates all records, and filters
 * locally by each refund's `created` timestamp — robust regardless of which
 * server-side date filters the endpoint supports.
 */

const HST_OFFSET = "-10:00";
const DAY_MS = 24 * 60 * 60 * 1000;
const HST_SHIFT_MS = 10 * 60 * 60 * 1000;

const executeFunction = async ({ start_date, end_date } = {}, { bc }) => {
  try {
    if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      return { error: `Invalid or missing start_date; expected YYYY-MM-DD.` };
    }
    const endDate = end_date || hstToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return { error: `Invalid end_date "${endDate}"; expected YYYY-MM-DD.` };
    }

    const { startMs, endMs } = hstWindowMs(start_date, endDate);
    if (startMs > endMs) {
      return { error: "start_date must be on or before end_date." };
    }

    // 1. Pull every refund, then sort newest-first client-side. The BigCommerce
    //    refunds endpoint does not support server-side sorting (returns HTTP 422
    //    for a `sort` param), so we order the records here instead.
    const allRefunds = await fetchAllRefunds(bc);
    allRefunds.sort((a, b) => (parseTimeMs(b.created) ?? 0) - (parseTimeMs(a.created) ?? 0));

    // Keep only refunds whose `created` falls inside the window.
    const inWindow = allRefunds.filter((r) => {
      const ms = parseTimeMs(r.created);
      return ms !== null && ms >= startMs && ms <= endMs;
    });

    const emptyResult = {
      start_date,
      end_date: endDate,
      timezone: "Pacific/Honolulu",
      refund_count: 0,
      refund_total: 0,
      unique_orders_refunded: 0,
      avg_days_from_order_to_refund: 0,
      refunds_by_original_order_month: {},
      top_10_refunded_orders: [],
    };

    // 2. Zero refunds in window -> return zeros gracefully (no error).
    if (inWindow.length === 0) {
      return emptyResult;
    }

    // 3. Look up each referenced order's date_created (one fetch per unique
    //    order, limited concurrency).
    const orderIds = [...new Set(inWindow.map((r) => r.order_id))];
    const orderDateById = new Map();
    await mapWithConcurrency(orderIds, 4, async (orderId) => {
      try {
        const order = await bc.get(`/v2/orders/${orderId}`);
        orderDateById.set(orderId, parseTimeMs(order?.date_created));
      } catch {
        orderDateById.set(orderId, null);
      }
    });

    // 4. Aggregate.
    let refundTotal = 0;
    let lagDaysSum = 0;
    let lagDaysCount = 0;
    const byMonth = {};
    const entries = [];

    for (const r of inWindow) {
      const amount = num(r.total_amount);
      const refundMs = parseTimeMs(r.created);
      const orderMs = orderDateById.get(r.order_id) ?? null;

      refundTotal += amount;

      if (orderMs !== null && refundMs !== null) {
        lagDaysSum += (refundMs - orderMs) / DAY_MS;
        lagDaysCount += 1;

        const monthKey = hstMonthKey(orderMs);
        if (!byMonth[monthKey]) byMonth[monthKey] = { count: 0, amount: 0 };
        byMonth[monthKey].count += 1;
        byMonth[monthKey].amount += amount;
      }

      entries.push({
        order_id: r.order_id,
        order_date: orderMs !== null ? new Date(orderMs).toISOString() : null,
        refund_amount: round2(amount),
        refund_date: refundMs !== null ? new Date(refundMs).toISOString() : null,
      });
    }

    // Round the per-month amounts.
    for (const key of Object.keys(byMonth)) {
      byMonth[key].amount = round2(byMonth[key].amount);
    }

    const topRefunds = entries
      .slice()
      .sort((a, b) => b.refund_amount - a.refund_amount)
      .slice(0, 10);

    return {
      start_date,
      end_date: endDate,
      timezone: "Pacific/Honolulu",
      refund_count: inWindow.length,
      refund_total: round2(refundTotal),
      unique_orders_refunded: orderIds.length,
      avg_days_from_order_to_refund:
        lagDaysCount > 0 ? round2(lagDaysSum / lagDaysCount) : 0,
      refunds_by_original_order_month: byMonth,
      top_10_refunded_orders: topRefunds,
    };
  } catch (error) {
    return {
      error: `An error occurred while summarizing refunds: ${error.message}`,
    };
  }
};

async function fetchAllRefunds(bc) {
  const refunds = [];
  const limit = 250;
  let page = 1;
  for (;;) {
    const q = new URLSearchParams({
      limit: String(limit),
      page: String(page),
    });
    const data = await bc.get(`/v3/orders/payment_actions/refunds?${q}`);
    const batch = Array.isArray(data) ? data : data.data || [];
    if (batch.length === 0) break;
    refunds.push(...batch);
    if (batch.length < limit) break;
    page++;
  }
  return refunds;
}

/** Today's date (YYYY-MM-DD) in the HST calendar. */
function hstToday() {
  const hstNow = new Date(Date.now() - HST_SHIFT_MS);
  return hstNow.toISOString().slice(0, 10);
}

/** Inclusive UTC millisecond bounds for an HST date window. */
function hstWindowMs(startStr, endStr) {
  const startMs = new Date(`${startStr}T00:00:00${HST_OFFSET}`).getTime();
  // End of the end_date's HST day: next HST midnight minus one second.
  const endMs =
    new Date(`${endStr}T00:00:00${HST_OFFSET}`).getTime() + DAY_MS - 1000;
  return { startMs, endMs };
}

/** YYYY-MM of an instant, expressed in the HST calendar. */
function hstMonthKey(ms) {
  return new Date(ms - HST_SHIFT_MS).toISOString().slice(0, 7);
}

/**
 * Parse a BigCommerce timestamp into epoch milliseconds. Handles ISO 8601 and
 * RFC-2822 strings as well as numeric epoch seconds. Returns null if unusable.
 */
function parseTimeMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    // BigCommerce numeric timestamps are epoch seconds.
    return value * 1000;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
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
      name: "get_refunds_summary",
      description:
        "Summarize BigCommerce refund activity within an HST (Pacific/Honolulu) date window. Complements get_daily_sales by reporting refunds that happened in the window rather than sales. Returns refund_count, refund_total, unique_orders_refunded, avg_days_from_order_to_refund, a refunds_by_original_order_month breakdown (keyed YYYY-MM by the original order's month), and the top 10 refunds by amount. Returns zeros gracefully when there are no refunds in the window.",
      parameters: {
        type: "object",
        properties: {
          start_date: {
            type: "string",
            description:
              "Start of the window as an ISO date (YYYY-MM-DD), interpreted in HST/Pacific/Honolulu. Required.",
          },
          end_date: {
            type: "string",
            description:
              "End of the window (inclusive) as an ISO date (YYYY-MM-DD), interpreted in HST. Optional; defaults to today in HST.",
          },
        },
        required: ["start_date"],
      },
    },
  },
};

export { apiTool };
