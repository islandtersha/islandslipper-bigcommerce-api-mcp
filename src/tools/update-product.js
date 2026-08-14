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
 */

import { resolveProduct } from "./catalog-helpers.js";

const UPDATABLE_FIELDS = ["name", "description", "is_visible", "url"];

const executeFunction = async (
  { identifier, updates, dry_run = true, store_Hash } = {},
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

    // Light type validation so we never PUT malformed values.
    const typeError = validateTypes(updates, keys);
    if (typeError) return { error: typeError };

    let product;
    try {
      product = await resolveProduct(bc, identifier, store_Hash);
    } catch (e) {
      return { error: e.message };
    }

    const existingUrl = product.custom_url ? product.custom_url.url : undefined;
    const before = {
      name: product.name,
      description: product.description,
      is_visible: product.is_visible,
      url: existingUrl,
    };

    // Field-by-field diff of ONLY the fields actually changing.
    const changes = [];
    for (const field of keys) {
      const after = updates[field];
      if (after !== before[field]) {
        changes.push({ field, before: before[field], after });
      }
    }

    const nameChanged = changes.some((c) => c.field === "name");
    const urlChanged = changes.some((c) => c.field === "url");
    const resultingUrl = urlChanged ? updates.url : existingUrl;

    // Build the PUT payload from changed fields only.
    const payload = {};
    for (const c of changes) {
      if (c.field === "url") continue; // URL is applied via custom_url below.
      payload[c.field] = c.after;
    }
    if (urlChanged) {
      // Explicit new slug — mark customized so BC keeps exactly this URL.
      payload.custom_url = { url: updates.url, is_customized: true };
    } else if (nameChanged && existingUrl) {
      // Rename with no url supplied: pin the existing slug as customized so BC
      // does NOT auto-regenerate the URL from the new name.
      payload.custom_url = { url: existingUrl, is_customized: true };
    }

    const next_steps = buildNextSteps({
      resultingUrl,
      urlChanged,
      oldUrl: existingUrl,
      newUrl: updates.url,
      nameChanged,
      existingUrl,
    });

    const base = { product_id: product.id, sku: product.sku, changes };

    if (changes.length === 0) {
      return {
        ...base,
        status: dry_run ? "skipped_dry_run" : "updated",
        next_steps: ["No fields differ from current values; nothing to update."],
      };
    }

    if (dry_run) {
      return { ...base, status: "skipped_dry_run", next_steps };
    }

    try {
      await bc.put(`/v3/catalog/products/${product.id}`, payload, {
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
  }
  return null;
}

function buildNextSteps({
  resultingUrl,
  urlChanged,
  oldUrl,
  newUrl,
  nameChanged,
  existingUrl,
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
  if (nameChanged && !urlChanged && !existingUrl) {
    steps.push(
      "WARNING: product has no existing custom URL to preserve; BigCommerce may auto-generate a new slug from the new name — verify the URL did not change."
    );
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
        "Update a single BigCommerce product's name, description, is_visible, and/or URL (Catalog Products API v3). Composable primitive: changes only the fields you pass. Identify the product by { product_id } or { sku } in `identifier`. WRITE TOOL — defaults to dry_run=true (reports the field-by-field diff without writing). SEO-safe URL handling: renaming a product NEVER changes its URL unless you explicitly supply `updates.url` — when name changes without a url, the existing slug is pinned as customized so BigCommerce does not auto-regenerate it. Supplying `url` applies the new slug and adds a 301-redirect reminder to next_steps (the redirect is NOT created for you). Returns { product_id, sku, changes: [{field, before, after}], status: 'updated'|'skipped_dry_run'|'error', error_message?, next_steps: [] }.",
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
                  "New URL slug (e.g. '/my-product/'). Applied as a customized URL; add a 301 redirect from the old URL yourself.",
              },
            },
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
