/**
 * update_product — update a BigCommerce product's name, description, and/or
 * is_visible. Composable write primitive: it changes only the fields you pass.
 * Defaults to dry_run=true.
 *
 * URL WRITING IS INTENTIONALLY NOT SUPPORTED. BigCommerce's V3 Catalog API does
 * NOT auto-create a 301 redirect when a product URL changes (only the BC admin
 * UI does), so an API-driven URL change silently breaks the indexed link with
 * no recovery. `updates.url` and the old `allow_url_regeneration` escape hatch
 * are removed and rejected. If MCP Tool 4 (`set_redirect`) ships, `updates.url`
 * can return to this tool paired with an automatic 301. Until then this
 * invariant holds.
 *
 * THE is_customized PIN IS THE ENFORCEMENT MECHANISM. On any rename BigCommerce
 * regenerates the slug from the new name UNLESS the existing custom_url is
 * written back with is_customized:true in the SAME PUT. So on every rename this
 * tool pins the existing custom_url — url kept BYTE-IDENTICAL, is_customized set
 * true — and that pin is what makes "never change the URL" actually hold. A
 * rename of a product with NO custom_url to pin is REFUSED (status "refused").
 *
 * On a live rename the read-back verifies the url did not move and the pin took.
 * A url that moved is an INVARIANT VIOLATION (should be impossible now) and a
 * hard error.
 */

import { resolveProduct } from "./catalog-helpers.js";

const UPDATABLE_FIELDS = ["name", "description", "is_visible"];
const PREVIEW_CHARS = 120;

// The unconditional pin was written but could not be re-read to confirm it stuck.
const PIN_UNCONFIRMED_STEP =
  "The customized-URL pin was written but could NOT be confirmed — check custom_url.is_customized is true in BC admin (an unpinned URL regenerates on the next rename).";

const executeFunction = async (args = {}, { bc }) => {
  try {
    const { identifier, updates, dry_run = true, store_Hash } = args;

    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return {
        error:
          "`updates` must be an object with any of: name, description, is_visible.",
      };
    }

    // URL writing is intentionally gone (see file header). Reject a `url` /
    // `custom_url` key ANYWHERE in `updates` BEFORE any BC API call — no write,
    // no partial application.
    if (containsUrlKey(updates)) {
      return {
        error:
          "URL changes are not supported by this tool. Product URLs must be changed in the BigCommerce admin UI so the 301 redirect is created automatically. The V3 API does not create redirects, so an API URL change would silently break the old link.",
      };
    }

    // The escape hatch is gone — its only purpose was permitting a rename that
    // knowingly broke the URL, and that path no longer exists.
    if ("allow_url_regeneration" in args) {
      return {
        error:
          "allow_url_regeneration is no longer supported. URL preservation is now unconditional on every rename.",
      };
    }

    const keys = UPDATABLE_FIELDS.filter((k) => k in updates);
    if (keys.length === 0) {
      return {
        error:
          "`updates` must include at least one of: name, description, is_visible.",
      };
    }

    // Light type validation so we never PUT malformed values.
    const typeError = validateTypes(updates, keys);
    if (typeError) return { error: typeError };

    let product;
    try {
      product = await resolveProduct(bc, identifier, store_Hash);
    } catch (e) {
      // A marked error (e.code, e.g. the subrequest-budget error) must reach the
      // dispatcher's dedicated handling — never flatten it to a generic string.
      if (e && e.code) throw e;
      return { error: e.message };
    }

    // Echo the caller's identifier verbatim. `sku` is the product's BASE sku,
    // which differs from a variant sku the caller may have passed — identifier_used
    // keeps a log row traceable to the exact call that produced it.
    const identifier_used =
      identifier && typeof identifier === "object" && !Array.isArray(identifier)
        ? { ...identifier }
        : identifier;

    const existing = product.custom_url || {};
    const existingUrl = existing.url; // RAW value; pinned back byte-identical
    const existingIsCustomized = Boolean(existing.is_customized);
    // Normalized form is used only for COMPARISON in read-back verification, so
    // a trailing-slash difference from BC doesn't read as a URL move.
    const expectedUrl =
      existingUrl != null ? normalizeSlug(existingUrl) : undefined;

    const nextName = "name" in updates ? updates.name.trim() : undefined;
    const nameChanged = "name" in updates && nextName !== product.name;

    // REFUSAL: a rename of a product with NO custom_url to pin would let BC
    // generate a fresh slug from the new name — nothing to preserve, so refuse.
    // A product whose custom_url EXISTS but is_customized:false is the NORMAL
    // path (pin it and proceed), not a refusal. No escape hatch.
    if (nameChanged && !existingUrl) {
      return {
        product_id: product.id,
        sku: product.sku,
        identifier_used,
        status: "refused",
        reason:
          "Product has no custom_url to pin. Renaming without a URL to preserve would let BigCommerce generate a fresh slug from the new name.",
        next_steps:
          "Set the product URL in BC admin first, then retry the rename.",
      };
    }

    // Field-by-field diff of ONLY the fields actually changing.
    const changes = [];
    let descriptionChanged = false;
    let visibilityChanged = false;

    if (nameChanged) {
      changes.push({ field: "name", before: product.name, after: nextName });
    }
    if ("description" in updates && updates.description !== product.description) {
      // Descriptions can be thousands of characters — never echo them whole.
      // Report lengths + short previews; the FULL value still goes in the payload.
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

    // Build the PUT payload from changed fields.
    const payload = {};
    if (nameChanged) payload.name = nextName;
    if (descriptionChanged) payload.description = updates.description;
    if (visibilityChanged) payload.is_visible = updates.is_visible;

    // UNCONDITIONAL PIN: on every rename, write the existing custom_url back
    // with is_customized:true, url kept BYTE-IDENTICAL, so BC does not
    // regenerate the slug from the new name. custom_url is touched ONLY when
    // renaming — an is_visible/description-only change never includes it.
    let pinned = false;
    if (nameChanged) {
      payload.custom_url = { url: existingUrl, is_customized: true };
      pinned = true;
      // Report the is_customized flip only when it actually changes value
      // (false -> true). Already-customized products pin silently.
      if (!existingIsCustomized) {
        changes.push({
          field: "custom_url.is_customized",
          before: false,
          after: true,
        });
      }
    }

    const resultingUrl = expectedUrl; // the URL never changes now
    const next_steps = buildNextSteps({
      resultingUrl,
      nameChanged,
      visibilityChanged,
      visibilityAfter: updates.is_visible,
    });

    const base = {
      product_id: product.id,
      sku: product.sku,
      identifier_used,
      changes,
    };

    // Nothing differs — identical outcome for dry and live runs.
    if (changes.length === 0) {
      return {
        ...base,
        status: "no_changes",
        next_steps: ["No fields differ from current values; nothing to update."],
      };
    }

    // Dry run echoes the exact PUT body so the caller can confirm custom_url is
    // present-and-byte-identical on a rename, or absent otherwise.
    if (dry_run) {
      return { ...base, status: "skipped_dry_run", payload, next_steps };
    }

    let putResp;
    try {
      putResp = await bc.put(`/v3/catalog/products/${product.id}`, payload, {
        storeHash: store_Hash,
      });
    } catch (err) {
      // A marked error (e.code) propagates to the dispatcher's budget handling.
      if (err && err.code) throw err;
      // The write failed entirely — nothing landed.
      return {
        ...base,
        status: "error",
        write_applied: false,
        error_message: err.body || err.message,
        next_steps,
      };
    }

    // POST-WRITE VERIFICATION (rename only — the pin is the invariant). We never
    // send a url and always pin, so custom_url.url MUST come back unchanged and
    // is_customized MUST be true.
    if (pinned) {
      let cu = readCustomUrlObj(putResp);
      let verifyBudgetHit = false;
      if (!cu || cu.url === undefined || cu.is_customized === undefined) {
        // PUT responses are often leaner than GETs; a follow-up GET resolves a
        // missing url OR is_customized. If it throws the shared budget error we
        // swallow it (the write already landed — the tool owns write_applied:true)
        // and note it so the message can say "budget" instead of "missing field".
        try {
          const fresh = await bc.get(`/v3/catalog/products/${product.id}`, {
            storeHash: store_Hash,
          });
          cu = readCustomUrlObj(fresh);
        } catch (e) {
          if (e && e.code === "SUBREQUEST_BUDGET_EXHAUSTED") verifyBudgetHit = true;
          /* leave cu undefined → routed to could-not-verify below (fail safe) */
        }
      }
      const actualUrl = cu ? cu.url : undefined;
      const normalizedActual =
        actualUrl != null ? normalizeSlug(actualUrl) : undefined;
      const actualIsCustomized = cu ? cu.is_customized : undefined;

      // Annotate change entries a verification branch PROVED did not persist,
      // keeping `changes` as the attempted diff.
      const markNotPersisted = (pairs) =>
        changes.map((c) => {
          const hit = pairs.find((p) => p.field === c.field);
          return hit
            ? { ...c, attempted: true, persisted: false, actual: hit.actual }
            : c;
        });

      // URL UNREADABLE (could-not-verify) — unchanged.
      if (normalizedActual === undefined) {
        return {
          ...base,
          status: "error",
          write_applied: true,
          error_message:
            `Field changes were applied to product #${product.id}, but the resulting URL could ` +
            `NOT be confirmed — ${
              verifyBudgetHit
                ? "the per-request subrequest budget was exhausted before read-back verification could run"
                : "BigCommerce did not return custom_url and the follow-up read failed"
            }. The field update landed and does NOT need to be re-run; the URL pin is simply ` +
            `unverified (expected "${expectedUrl}").`,
          next_steps: [
            "Do NOT re-run this update — the field changes are already live.",
            `Manually check the product URL is still ${expectedUrl}; if BigCommerce regenerated it, set it back as customized in BC admin.`,
            ...(existingIsCustomized ? [] : [PIN_UNCONFIRMED_STEP]),
            ...next_steps,
          ],
        };
      }

      // INVARIANT VIOLATION (was "silent slug regeneration"). We never sent a
      // url and always pin, so the url moving should be impossible — a hard
      // error, not routine 301 remediation.
      if (normalizedActual !== expectedUrl) {
        return {
          ...base,
          changes: markNotPersisted([
            { field: "custom_url.is_customized", actual: actualIsCustomized },
          ]),
          status: "error",
          write_applied: true,
          error_message:
            "Invariant violation: custom_url.url changed during an update that did not request a URL change. This should never happen. Do not repeat the operation. Investigate BC-side behavior before further writes.",
          next_steps: [
            "Do NOT repeat the operation.",
            "Investigate BC-side behavior before further writes.",
            ...next_steps,
          ],
        };
      }

      // PIN UNCONFIRMABLE — unchanged.
      if (actualIsCustomized === undefined) {
        return {
          ...base,
          status: "error",
          write_applied: true,
          error_message:
            `Field changes and the URL "${expectedUrl}" landed on product #${product.id}, but the ` +
            `response did not include custom_url.is_customized, so the pin could NOT be confirmed. ` +
            `The field update landed and does NOT need to be re-run; the URL's pinned state is ` +
            `unverified — if it is not customized it will regenerate on the next rename.`,
          next_steps: [
            "Do NOT re-run this update — the field changes are already live.",
            `Check custom_url.is_customized is true for ${expectedUrl} in BC admin.`,
            ...next_steps,
          ],
        };
      }

      // PIN NOT TAKING — unchanged.
      if (actualIsCustomized !== true) {
        return {
          ...base,
          changes: markNotPersisted([
            { field: "custom_url.is_customized", actual: actualIsCustomized },
          ]),
          status: "error",
          write_applied: true,
          error_message:
            `Field changes were applied to product #${product.id} and the URL "${expectedUrl}" ` +
            `landed, but custom_url.is_customized did NOT take (still false). The URL is NOT ` +
            `protected from future renames and will regenerate on the next rename. The field ` +
            `changes are live and do NOT need to be re-run.`,
          next_steps: [
            `Set the URL ${expectedUrl} as customized (is_customized true) in BC admin so it survives future renames.`,
            "Do NOT re-run this update — the field changes are already live.",
            ...next_steps,
          ],
        };
      }
    }

    return { ...base, status: "updated", next_steps };
  } catch (error) {
    // Marked errors (e.code, e.g. subrequest-budget) propagate to the dispatcher
    // rather than being flattened by this backstop.
    if (error && error.code) throw error;
    return {
      error: `An error occurred while updating product: ${error.message}`,
    };
  }
};

/** True if `obj` contains a `url` or `custom_url` key at ANY depth. */
function containsUrlKey(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const [k, v] of Object.entries(obj)) {
    const kl = k.toLowerCase();
    if (kl === "url" || kl === "custom_url") return true;
    if (v && typeof v === "object" && containsUrlKey(v)) return true;
  }
  return false;
}

function validateTypes(updates, keys) {
  for (const field of keys) {
    const v = updates[field];
    if (field === "is_visible" && typeof v !== "boolean") {
      return "`updates.is_visible` must be a boolean.";
    }
    if ((field === "name" || field === "description") && typeof v !== "string") {
      return `\`updates.${field}\` must be a string.`;
    }
  }
  return null;
}

/**
 * Normalize a BigCommerce product URL slug to exactly one leading and one
 * trailing slash. Used only for COMPARISON in read-back verification — the value
 * WRITTEN back is the raw existing url, byte-identical.
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

/** Pull the custom_url object ({ url, is_customized }) from a BC product envelope. */
function readCustomUrlObj(resp) {
  return resp && resp.data && resp.data.custom_url
    ? resp.data.custom_url
    : undefined;
}

function buildNextSteps({
  resultingUrl,
  nameChanged,
  visibilityChanged,
  visibilityAfter,
}) {
  const steps = [];
  if (resultingUrl) steps.push(`Verify product page renders at ${resultingUrl}`);
  // A name change still propagates to product feeds even though the URL is
  // frozen. (301 / sitemap / GSC reminders are gone — the URL never changes.)
  if (nameChanged) {
    steps.push("Check Google Merchant Center feed picks up new title");
    steps.push("Check Klaviyo product blocks referencing old name");
  }
  if (visibilityChanged && visibilityAfter === false) {
    // Product Discontinuation SOP — the Vault transition (unrelated to URL
    // writing; hiding a product still wants a redirect set up in BC admin).
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

// TODO(batch): update_product is single-product only. Whole-style retirement
// (Product Discontinuation SOP Procedure D) needs a batch form that takes an
// array of product_ids and applies the same updates to each. Deferred until
// that work — do not build it here. See README "Known gaps".
//
// Reversibility: URL changes are intentionally not supported. If MCP Tool 4
// (`set_redirect`) ships, `updates.url` can return to this tool paired with an
// automatic 301. Until then this invariant holds.
const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "update_product",
      description:
        "Update a single BigCommerce product's name, description, and/or is_visible (Catalog Products API v3). Composable primitive: changes only the fields you pass. Identify the product by { product_id } or { sku } in `identifier`. WRITE TOOL — defaults to dry_run=true (reports the field-by-field diff without writing). URL CHANGES ARE NOT SUPPORTED: `updates.url` (at any depth) and the old `allow_url_regeneration` argument are rejected — the V3 API does not create 301 redirects, so a product URL must be changed in the BC admin UI (where the redirect is made automatically). On every rename the product's existing custom_url is pinned — url kept BYTE-IDENTICAL, is_customized set true — in the same PUT, so BigCommerce never regenerates the slug from the new name; a rename of a product that has NO custom_url to pin returns status 'refused' (no escape hatch). On a live rename the read-back verifies the URL did not move — a move is an invariant-violation hard error — and that the pin took. URL comparison is slash-normalized; description diffs are returned as lengths + 120-char previews (never the full body). Dry runs also echo the exact `payload` that would be PUT. Returns { product_id, sku, identifier_used, changes: [{field, before, after} | description:{before_length, after_length, before_preview, after_preview}], status: 'updated'|'no_changes'|'skipped_dry_run'|'refused'|'error', payload? (dry-run only), reason? (refused only), write_applied?, error_message?, next_steps }. On a status 'error' return, write_applied is false when the PUT itself failed (nothing changed) and true when the field PUT succeeded but the URL pin could not be confirmed, did not take, or the URL moved — the field changes are LIVE and the call must NOT be re-run. A change entry that verification proved did not persist is annotated with { attempted: true, persisted: false, actual: <final value> }.",
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
              "Fields to change. Include any of the three; omitted fields are left untouched. URL changes are not supported and are rejected.",
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
            },
          },
          dry_run: {
            type: "boolean",
            description:
              "When true (default), report the diff and the exact PUT payload without writing to BigCommerce.",
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
