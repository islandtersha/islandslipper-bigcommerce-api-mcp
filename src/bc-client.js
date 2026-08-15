/**
 * BigCommerce API client for Cloudflare Workers.
 *
 * Web-standard only (fetch / URL / Headers) — no Node APIs. Credentials are
 * read from the Worker `env` binding (Workers Secrets), never process.env.
 */

const BASE_URL = "https://api.bigcommerce.com/stores";

/**
 * Cloudflare Workers cap outbound subrequests per incoming request: 50 on the
 * Free plan, 1000 on paid. This budget is shared across the WHOLE tool call —
 * pagination, resolveProduct, the write, and read-back verification all draw
 * from the same pool. We throw our own clear error at a soft cap safely below
 * 50 so it wins the race against Cloudflare's opaque abort at the ceiling. The
 * counter is incremented per ACTUAL fetch — 429 retries included — so the cap
 * reflects real Cloudflare subrequest usage even under throttling; the gap
 * below 50 is margin against that opaque abort, not an allowance for uncounted
 * retries.
 */
export const SUBREQUEST_SOFT_CAP = 45;

/**
 * Build a BigCommerce client from the Worker env bindings.
 * @param {Record<string, string>} env
 * @returns {BcClient}
 */
export function createBcClient(env) {
  const storeHash = env.BC_STORE_HASH;
  const token = env.BC_ACCESS_TOKEN;
  if (!storeHash || !token) {
    throw new Error(
      "Missing BigCommerce credentials: set BC_STORE_HASH and BC_ACCESS_TOKEN as Workers secrets."
    );
  }
  return new BcClient(storeHash, token);
}

export class BcClient {
  constructor(storeHash, token) {
    this.storeHash = storeHash;
    this.token = token;
    // Per-request (per-isolate-invocation) subrequest budget. This client is
    // built fresh for every tool call (see mcp.js), so the count is naturally
    // scoped to one incoming request. `toolName` is stamped by the dispatcher
    // so the budget error can name the offending tool.
    this.subrequestCount = 0;
    this.toolName = null;
  }

  #headers() {
    return {
      "X-Auth-Token": this.token,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  #url(path, storeHashOverride) {
    if (path.startsWith("http")) return path;
    const hash = storeHashOverride || this.storeHash;
    return `${BASE_URL}/${hash}${path}`;
  }

  /**
   * Perform a request, transparently honoring BigCommerce rate limits.
   * On HTTP 429 it waits for the Retry-After / X-Rate-Limit-Time-Reset-Ms
   * hint and retries (up to `maxRetries`).
   */
  async request(method, path, { body, storeHash, maxRetries = 4 } = {}) {
    const url = this.#url(path, storeHash);
    let attempt = 0;

    for (;;) {
      // Shared per-request subrequest budget (see SUBREQUEST_SOFT_CAP). Guard at
      // the TOP of the loop so every actual fetch — first attempt AND each 429
      // retry — is counted before it is issued. This throws a returnable error
      // before the Worker hits the hard ceiling and aborts opaquely, and stays
      // accurate under a 429 storm (each retry is a real subrequest).
      if (this.subrequestCount >= SUBREQUEST_SOFT_CAP) {
        throw subrequestBudgetError(this.toolName, this.subrequestCount, attempt);
      }
      this.subrequestCount++;

      const response = await fetch(url, {
        method,
        headers: this.#headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (response.status === 429 && attempt < maxRetries) {
        await sleep(retryDelayMs(response));
        attempt++;
        continue;
      }

      if (!response.ok) {
        const text = await safeText(response);
        const err = new Error(
          `BigCommerce ${method} ${stripBase(url)} -> HTTP ${response.status}: ${truncate(text)}`
        );
        err.status = response.status;
        // Raw, untruncated response body so tools can surface BigCommerce's
        // exact error text (e.g. verbatim SKU-uniqueness messages) instead of
        // parsing it back out of err.message.
        err.body = text;
        throw err;
      }

      // 204 No Content (common for v2 empty results) or empty body.
      if (response.status === 204) return { data: [] };
      const text = await safeText(response);
      if (!text || text.trim() === "") return { data: [] };

      try {
        return JSON.parse(text);
      } catch {
        // Auth failures sometimes return an HTML error page.
        if (text.trim().startsWith("<")) {
          throw new Error(
            "BigCommerce returned HTML instead of JSON — likely an auth error (check BC_ACCESS_TOKEN / BC_STORE_HASH)."
          );
        }
        throw new Error(`Invalid JSON response: ${truncate(text)}`);
      }
    }
  }

  get(path, opts) {
    return this.request("GET", path, opts);
  }

  put(path, body, opts) {
    return this.request("PUT", path, { ...opts, body });
  }

  post(path, body, opts) {
    return this.request("POST", path, { ...opts, body });
  }
}

/**
 * Build the shared-subrequest-budget error. `attempt` is the number of 429
 * retries already performed in this request() call: 0 means the cap was hit
 * pre-flight (the tool is over-fetching — narrow the query), > 0 means it was
 * hit while retrying a rate-limited request (the store is being throttled —
 * back off). The retry case can ALSO be an over-fetch (a tool that spent most
 * of the budget before catching one 429 has both problems), so its message
 * carries the subrequest count and says to narrow too when that count is high.
 */
function subrequestBudgetError(toolName, count, attempt) {
  const who = toolName || "unknown";
  const msg =
    attempt > 0
      ? `Subrequest budget exhausted while RETRYING a rate-limited (429) request: tool "${who}" ` +
        `reached the soft cap of ${SUBREQUEST_SOFT_CAP} BigCommerce subrequests (Cloudflare Workers ` +
        `Free plan aborts at 50) on retry attempt ${attempt}, after ${count} subrequests. Each 429 ` +
        `retry is itself a counted subrequest, so back off and retry later. AND — because ${count} of ` +
        `${SUBREQUEST_SOFT_CAP} subrequests were already spent before this 429 — if that count is high ` +
        `the call is also over-fetching and should be narrowed, not just retried (a low count means it ` +
        `is mostly throttling). A paid Workers plan raises the ceiling to 1000.`
      : `Subrequest budget exhausted: tool "${who}" reached the soft cap of ${SUBREQUEST_SOFT_CAP} ` +
        `BigCommerce subrequests in a single request (Cloudflare Workers Free plan aborts at 50; ` +
        `${count} subrequests, attempt ${attempt}). The budget is shared across the whole tool call — ` +
        `pagination, lookups, the write, read-back verification, and 429 retries all draw from it — so ` +
        `narrow the query or split the work across calls. A paid Workers plan raises the ceiling to 1000.`;
  const err = new Error(msg);
  // Distinguishing marker so the dispatcher (and tools) can tell a budget stop
  // from a transient BigCommerce error — they need opposite responses.
  err.code = "SUBREQUEST_BUDGET_EXHAUSTED";
  err.subrequestCount = count;
  err.attempt = attempt;
  return err;
}

/** Convert a 429 response's headers into a delay in milliseconds. */
function retryDelayMs(response) {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  }
  const resetMs = response.headers.get("X-Rate-Limit-Time-Reset-Ms");
  if (resetMs) {
    const ms = Number(resetMs);
    if (!Number.isNaN(ms)) return Math.max(0, ms);
  }
  return 1000; // sensible default backoff
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(str, n = 300) {
  if (!str) return "";
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function stripBase(url) {
  return url.replace(BASE_URL, "").replace(/^\/[^/]+/, "");
}