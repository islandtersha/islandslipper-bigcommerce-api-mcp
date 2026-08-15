/**
 * update_product — update a BigCommerce product's name, description,
 * is_visible, and/or URL. Composable write primitive: it changes only the
 * fields you pass and nothing else. Defaults to dry_run=true.
 *
 * SEO-CRITICAL URL HANDLING:
 * BigCommerce auto-regenerates a product's URL slug from its name on save
 * UNLESS the URL is marked customized (custom_url.is_customized = true). So
 * when `name` changes and no `url` is supplied, this tool pins the EXISTING
 * slug as customized in the PUT payload — a rename never silently changes the
 * product URL (we have SEO equity on these). When `url` IS supplied, it is
 * applied (also as customized) and a 301-redirect reminder is added to
 * next_steps; the tool does NOT create the redirect itself.
 *
 * A rename of a product that has NO pinned custom_url is REFUSED (there is no
 * existing slug to preserve, so BigCommerce would regenerate one) unless the
 * caller supplies `updates.url` or opts in with `allow_url_regeneration: true`.
 *
 * On a live run the PUT response is inspected to CONFIRM the resulting URL is
 * exactly what we asked for; a silent slug regeneration is surfaced as an
 * error with a 301 next step rather than reported as success.
 */

import { resolveProduct } from "./catalog-helpers.js";

const UPDATABLE_FIELDS = ["name", "description", "is_visible", "url"];
const PREVIEW_CHARS = 120;

const executeFunction = async (
  {
    identifier,
    updates,
    dry_run = true,
    allow_url_regeneration = false,
    store_Hash,
  } = {},
  { bc }
) => {
  try {
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return {
        error:
          "`updates` must be an object with any of: name, description, is_visible, url.",
      };
    }
    const keys = UPDATABLE_FIELDS.filter((k) => k in updates);
    if (keys.length === 0) {
      return {
        error:
          "`updates` must include at least one of: name, description, is_visible, url.",
      };
    }
    if (typeof allow_url_regeneration !== "boolean") {
      return { error: "`allow_url_regeneration` must be a boolean." };
    }

    // Light type validation so we never PUT malformed values.
    const typeError = validateTypes(updates, keys);
    if (typeError) return { error: typeError };

    let product;
    try {
      product = await resolveProduct(bc, identifier, store_Hash);
    } catch (e) {
      return { error: e.message };
    }

    const existing = product.custom_url || {};
    const existingUrl = existing.url; // raw, slash-wrapped, may be undefined
    const existingIsCustomized = Boolean(existing.is_customized);
    const normalizedExistingUrl =
      existingUrl != null ? normalizeSlug(existingUrl) : undefined;

    // Normalized "after" values: names are trimmed (both ends), URLs are
    // slash-normalized, so we never diff (or write) a spurious change. The
    // trimmed name is what gets written — intended, and visible in changes.after.
    const nextName = "name" in updates ? updates.name.trim() : undefined;
    const nextUrl = "url" in updates ? normalizeSlug(updates.url) : undefined;

    // Field-by-field diff of ONLY the fields actually changing.
    const changes = [];
    let nameChanged = false;
    let descriptionChanged = false;
    let visibilityChanged = false;
    let urlChanged = false;

    if ("name" in updates && nextName !== product.name) {
      changes.push({ field: "name", before: product.name, after: nextName });
      nameChanged = true;
    }
    if ("description" in updates && updates.description !== product.description) {
      // Descriptions can be thousands of characters — never echo them whole
      // (a chained style migration would blow the context window). Report
      // lengths + short previews; the FULL value still goes in the payload.
      const beforeDesc = product.description ?? "";
      const afterDesc = updates.description;
      changes.push({
        field: "description",
        before_length: beforeDesc.length,
        after_length: afterDesc.length,
        before_preview: preview(beforeDesc),
        after_preview: preview(afterDesc),
      });
      descriptionChanged = true;
    }
    if ("is_visible" in updates && updates.is_visible !== product.is_visible) {
      changes.push({
        field: "is_visible",
        before: product.is_visible,
        after: updates.is_visible,
      });
      visibilityChanged = true;
    }
    if ("url" in updates && nextUrl !== normalizedExistingUrl) {
      changes.push({
        field: "url",
        before: normalizedExistingUrl ?? null,
        after: nextUrl,
      });
      urlChanged = true;
    }

    // Refuse a rename that would let BigCommerce regenerate the slug: name is
    // changing, no new url was supplied, and there is no existing custom_url to
    // pin. This is a hard stop (not a warning buried in next_steps) because by
    // the time a chained recipe reads the warning, the old URL is already
    // 404ing. `allow_url_regeneration: true` is the explicit escape hatch.
    if (nameChanged && !urlChanged && !existingUrl && !allow_url_regeneration) {
      return {
        error:
          `Refusing to rename product #${product.id} (sku ${product.sku || "—"}): it has no ` +
          `pinned custom_url, so renaming will let BigCommerce auto-generate a new URL slug ` +
          `from the new name and the current URL will 404. Either set a custom URL in the BC ` +
          `admin (or pass \`updates.url\`) first, or pass \`allow_url_regeneration: true\` to ` +
          `proceed and accept the regenerated slug.`,
      };
    }

    // Build the PUT payload from changed fields only. Reporting-only entries
    // (e.g. the is_customized flip below) are added to `changes` AFTER this so
    // they never leak into the payload.
    const payload = {};
    if (nameChanged) payload.name = nextName;
    if (descriptionChanged) payload.description = updates.description;
    if (visibilityChanged) payload.is_visible = updates.is_visible;

    // expectedUrl = the exact slug we assert the product should carry after the
    // write. Left undefined when we did NOT pin a specific URL (i.e. a caller
    // who opted into regeneration), which is the only case we don't verify.
    let expectedUrl;
    let pinnedExistingSlug = false;
    if (urlChanged) {
      // Explicit new slug — mark customized so BC keeps exactly this URL.
      payload.custom_url = { url: nextUrl, is_customized: true };
      expectedUrl = nextUrl;
    } else if (nameChanged && existingUrl) {
      // Rename with no url supplied: pin the existing slug as customized so BC
      // does NOT auto-regenerate the URL from the new name.
      payload.custom_url = { url: normalizedExistingUrl, is_customized: true };
      expectedUrl = normalizedExistingUrl;
      pinnedExistingSlug = true;
    }

    // Writing custom_url (either an explicit url OR pinning the existing slug on
    // rename) sets is_customized: true. When it was false, that's a real state
    // change — record it in the audit trail regardless of which path caused it.
    const wroteCustomUrl = urlChanged || pinnedExistingSlug;
    const isCustomizedFlip = wroteCustomUrl && !existingIsCustomized;
    if (isCustomizedFlip) {
      changes.push({
        field: "custom_url.is_customized",
        before: false,
        after: true,
      });
    }
    // The "URL no longer tracks the name" note is only a surprise on a
    // rename-pin (the caller didn't touch the URL); the explicit-url path
    // already carries its own 301 / verify next_steps.
    const pinnedCustomizedFlip = pinnedExistingSlug && !existingIsCustomized;

    const resultingUrl = urlChanged ? nextUrl : normalizedExistingUrl;

    const next_steps = buildNextSteps({
      resultingUrl,
      urlChanged,
      oldUrl: normalizedExistingUrl,
      newUrl: nextUrl,
      nameChanged,
      pinnedCustomizedFlip,
      visibilityChanged,
      visibilityAfter: updates.is_visible,
    });

    const base = { product_id: product.id, sku: product.sku, changes };

    // Nothing differs — identical outcome for dry and live runs.
    if (changes.length === 0) {
      return {
        ...base,
        status: "no_changes",
        next_steps: ["No fields differ from current values; nothing to update."],
      };
    }

    if (dry_run) {
      return { ...base, status: "skipped_dry_run", next_steps };
    }

    let putResp;
    try {
      putResp = await bc.put(`/v3/catalog/products/${product.id}`, payload, {
        storeHash: store_Hash,
      });
    } catch (err) {
      return {
        ...base,
        status: "error",
        error_message: err.body || err.message,
        next_steps,
      };
    }

    // POST-WRITE URL VERIFICATION — the whole premise of the tool is that a
    // rename never silently changes the URL, so prove it landed.
    if (expectedUrl) {
      let actualUrl = readCustomUrl(putResp);
      if (actualUrl === undefined) {
        // PUT response didn't echo custom_url — do ONE follow-up GET rather
        // than assume. custom_url is a default product field (no include).
        try {
          const fresh = await bc.get(`/v3/catalog/products/${product.id}`, {
            storeHash: store_Hash,
          });
          actualUrl = readCustomUrl(fresh);
        } catch {
          /* leave undefined → treated as a mismatch below (fail safe) */
        }
      }
      const normalizedActual =
        actualUrl != null ? normalizeSlug(actualUrl) : undefined;

      if (normalizedActual === undefined) {
        // Could NOT read the resulting URL (PUT omitted custom_url and the
        // follow-up GET failed). This is a flaky subrequest, not a confirmed
        // regeneration — a different problem from an actual slug change. Fail
        // safe: the field write already applied, but the URL is unverified.
        return {
          ...base,
          status: "error",
          write_applied: true,
          error_message:
            `Field changes were applied to product #${product.id}, but the resulting URL could ` +
            `NOT be confirmed — BigCommerce did not return custom_url and the follow-up read ` +
            `failed. The field update landed and does NOT need to be re-run; the URL is simply ` +
            `unverified (expected "${expectedUrl}").`,
          next_steps: [
            "Do NOT re-run this update — the field changes are already live.",
            `Manually check the product URL is still ${expectedUrl}; if BigCommerce regenerated it, create a 301 from ${expectedUrl} to the new URL.`,
            ...next_steps,
          ],
        };
      }

      if (normalizedActual !== expectedUrl) {
        // Confirmed silent regeneration — a live SEO fire. The PUT already
        // succeeded, so the field changes are live; only the URL assertion
        // failed. Do not present this as a failed write.
        return {
          ...base,
          status: "error",
          write_applied: true,
          error_message:
            `Field changes were applied to product #${product.id}, but BigCommerce regenerated ` +
            `the product URL: expected "${expectedUrl}", the product now resolves to ` +
            `"${normalizedActual}". The field update landed and does NOT need to be re-run — only ` +
            `the URL assertion failed, and the expected URL will now 404.`,
          next_steps: [
            "Do NOT re-run this update — the field changes are already live, and re-pinning the slug will be overridden by BigCommerce identically.",
            `Create a 301 redirect IMMEDIATELY: ${expectedUrl} -> ${normalizedActual}`,
            ...next_steps,
          ],
        };
      }
    } else if (nameChanged && allow_url_regeneration) {
      // Caller accepted regeneration and we did not pin a slug — surface the
      // URL BigCommerce actually generated so it isn't a silent surprise.
      const actualUrl = readCustomUrl(putResp);
      if (actualUrl) {
        next_steps.unshift(
          `BigCommerce generated a new slug: ${normalizeSlug(actualUrl)} (URL regeneration was explicitly allowed). Add a 301 from any previously known URL.`
        );
      }
    }

    return { ...base, status: "updated", next_steps };
  } catch (error) {
    return {
      error: `An error occurred while updating product: ${error.message}`,
    };
  }
};

function validateTypes(updates, keys) {
  for (const field of keys) {
    const v = updates[field];
    if (field === "is_visible" && typeof v !== "boolean") {
      return "`updates.is_visible` must be a boolean.";
    }
    if (
      (field === "name" || field === "description" || field === "url") &&
      typeof v !== "string"
    ) {
      return `\`updates.${field}\` must be a string.`;
    }
    // Reject absolute URLs before the write: normalizeSlug assumes a path, so
    // "https://shop.example.com/products/t810/" would be mangled into
    // "/https:/shop.example.com/products/t810/" and written verbatim. Catch a
    // scheme ("://"), a protocol-relative "//host", or a leading host-looking
    // segment (a dot before the first slash).
    if (field === "url") {
      const trimmed = v.trim();
      const firstSegment = trimmed.replace(/^\/+/, "").split("/")[0];
      if (
        trimmed.includes("://") ||
        trimmed.startsWith("//") ||
        firstSegment.includes(".")
      ) {
        return (
          "`updates.url` must be a path-only slug (e.g. '/products/t810-black/'), " +
          "not an absolute URL or hostname. Pass just the path."
        );
      }
    }
  }
  return null;
}

/**
 * Normalize a BigCommerce product URL slug to exactly one leading and one
 * trailing slash (how BC stores it, e.g. "/products/t810-black/"), trimming
 * surrounding whitespace. So "products/t810-black" and "/products/t810-black"
 * both normalize to "/products/t810-black/" and stop looking like a change.
 */
function normalizeSlug(url) {
  const trimmed = String(url).trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "/" : `/${trimmed}/`;
}

/** First PREVIEW_CHARS characters of a (possibly huge) string, with an ellipsis. */
function preview(s) {
  const str = String(s ?? "");
  return str.length > PREVIEW_CHARS ? `${str.slice(0, PREVIEW_CHARS)}…` : str;
}

/** Pull custom_url.url out of a BC product envelope ({ data: { custom_url } }). */
function readCustomUrl(resp) {
  const cu = resp && resp.data && resp.data.custom_url;
  return cu ? cu.url : undefined;
}

function buildNextSteps({
  resultingUrl,
  urlChanged,
  oldUrl,
  newUrl,
  nameChanged,
  pinnedCustomizedFlip,
  visibilityChanged,
  visibilityAfter,
}) {
  const steps = [];
  if (resultingUrl) steps.push(`Verify product page renders at ${resultingUrl}`);
  if (urlChanged) {
    steps.push(`Create 301 redirect: ${oldUrl || "(old URL)"} -> ${newUrl}`);
    steps.push("Resubmit sitemap and request GSC recrawl");
  }
  if (nameChanged) {
    steps.push("Check Google Merchant Center feed picks up new title");
    steps.push("Check Klaviyo product blocks referencing old name");
  }
  if (pinnedCustomizedFlip) {
    steps.push(
      "URL is now pinned as customized (is_customized true) and will no longer track the product name; supply updates.url explicitly if a future name change should also change the slug."
    );
  }
  if (visibilityChanged && visibilityAfter === false) {
    // Product Discontinuation SOP — the Vault transition.
    steps.push(
      `Create 301 redirect from the product URL${
        resultingUrl ? ` (${resultingUrl})` : ""
      } to the parent style page or collection landing page`
    );
    steps.push(
      "Remove from category 113 (Last Call) and all standard merchandising categories"
    );
    steps.push("Leave the Yotpo review group intact");
  }
  if (visibilityChanged && visibilityAfter === true) {
    steps.push("Remove any existing 301 redirect for the product URL");
    steps.push("Re-add to merchandising categories");
    steps.push("Verify pricing");
  }
  return steps;
}

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "update_product",
      description:
        "Update a single BigCommerce product's name, description, is_visible, and/or URL (Catalog Products API v3). Composable primitive: changes only the fields you pass. Identify the product by { product_id } or { sku } in `identifier`. WRITE TOOL — defaults to dry_run=true (reports the field-by-field diff without writing). SEO-safe URL handling: renaming a product NEVER changes its URL unless you explicitly supply `updates.url` — when name changes without a url, the existing slug is pinned as customized so BigCommerce does not auto-regenerate it. A rename of a product that has NO existing custom_url is REFUSED (nothing to pin) unless you pass `updates.url` or `allow_url_regeneration: true`. Supplying `url` applies the new slug and adds a 301-redirect reminder to next_steps (the redirect is NOT created for you). On a live run the resulting URL is verified against the PUT response and a silent BigCommerce slug regeneration is reported as status 'error' with a 301 next step. URL comparison is slash-normalized and description diffs are returned as lengths + 120-char previews (never the full body). Returns { product_id, sku, changes: [{field, before, after} | description:{before_length, after_length, before_preview, after_preview}], status: 'updated'|'no_changes'|'skipped_dry_run'|'error', write_applied?, error_message?, next_steps: [] }. write_applied is true on a status 'error' return where the field PUT already succeeded but the URL could not be confirmed or was regenerated — the field changes are LIVE and the call must NOT be re-run.",
      parameters: {
        type: "object",
        properties: {
          identifier: {
            type: "object",
            description:
              "How to locate the product. Provide exactly one of product_id or sku.",
            properties: {
              product_id: {
                type: "integer",
                description: "BigCommerce product id.",
              },
              sku: {
                type: "string",
                description:
                  "Product base SKU or a variant SKU. Errors if it matches more than one product.",
              },
            },
          },
          updates: {
            type: "object",
            description:
              "Fields to change. Include any of the four; omitted fields are left untouched.",
            properties: {
              name: { type: "string", description: "New product name." },
              description: {
                type: "string",
                description: "New product description (HTML allowed).",
              },
              is_visible: {
                type: "boolean",
                description: "Storefront visibility.",
              },
              url: {
                type: "string",
                description:
                  "New URL slug (e.g. '/my-product/'). Applied as a customized URL; add a 301 redirect from the old URL yourself. Slash-normalized before comparing and writing.",
              },
            },
          },
          allow_url_regeneration: {
            type: "boolean",
            description:
              "Escape hatch (default false). When true, permit renaming a product that has no existing custom_url even though BigCommerce will auto-generate a new URL slug from the new name (the old URL will 404). Leave false to have such renames refused.",
          },
          dry_run: {
            type: "boolean",
            description:
              "When true (default), report the diff without writing to BigCommerce.",
          },
          store_Hash: {
            type: "string",
            description:
              "Optional store hash. If not provided, uses the BC_STORE_HASH secret.",
          },
        },
        required: ["identifier", "updates"],
      },
    },
  },
};

export { apiTool };
