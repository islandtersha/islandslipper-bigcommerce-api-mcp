/**
 * get_all_products — list products from the BigCommerce Catalog API v3.
 *
 * Credentials come from the Worker `env` (via the injected `bc` client), not
 * process.env. Tool name and input schema are unchanged from the upstream fork.
 */

const executeFunction = async ({ store_Hash } = {}, { bc }) => {
  try {
    return await bc.get("/v3/catalog/products", { storeHash: store_Hash });
  } catch (error) {
    return {
      error: `An error occurred while getting all products: ${error.message}`,
    };
  }
};

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "get_all_products",
      description:
        "Get all products from the BigCommerce API. Store hash is taken from the BC_STORE_HASH secret unless overridden.",
      parameters: {
        type: "object",
        properties: {
          store_Hash: {
            type: "string",
            description:
              "Optional store hash. If not provided, uses the BC_STORE_HASH secret.",
          },
        },
        required: [],
      },
    },
  },
};

export { apiTool };
