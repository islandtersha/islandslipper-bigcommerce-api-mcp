/**
 * BigCommerce API client for Cloudflare Workers.
 *
 * Web-standard only (fetch / URL / Headers) — no Node APIs. Credentials are
 * read from the Worker `env` binding (Workers Secrets), never process.env.
 */

const BASE_URL = "https://api.bigcommerce.com/stores";

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