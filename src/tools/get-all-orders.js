/**
 * get_all_orders — list orders from the BigCommerce Orders API v2 with
 * filtering. Ported to the Workers `bc` client; tool name and input schema are
 * unchanged from the upstream fork.
 */

const executeFunction = async (
  {
    store_Hash,
    customer_id,
    email,
    status_id,
    min_id,
    max_id,
    min_total,
    max_total,
    min_date_created,
    max_date_created,
    min_date_modified,
    max_date_modified,
    channel_id,
    payment_method,
    cart_id,
    external_order_id,
    sort,
    limit = 50,
    page = 1,
  } = {},
  { bc }
) => {
  try {
    const q = new URLSearchParams();
    if (customer_id) q.append("customer_id", customer_id.toString());
    if (email) q.append("email", email);
    if (status_id) q.append("status_id", status_id.toString());
    if (min_id) q.append("min_id", min_id.toString());
    if (max_id) q.append("max_id", max_id.toString());
    if (min_total) q.append("min_total", min_total.toString());
    if (max_total) q.append("max_total", max_total.toString());
    if (min_date_created) q.append("min_date_created", min_date_created);
    if (max_date_created) q.append("max_date_created", max_date_created);
    if (min_date_modified) q.append("min_date_modified", min_date_modified);
    if (max_date_modified) q.append("max_date_modified", max_date_modified);
    if (channel_id) q.append("channel_id", channel_id.toString());
    if (payment_method) q.append("payment_method", payment_method);
    if (cart_id) q.append("cart_id", cart_id);
    if (external_order_id) q.append("external_order_id", external_order_id);
    if (sort) q.append("sort", sort);
    if (limit) q.append("limit", limit.toString());
    if (page) q.append("page", page.toString());

    const qs = q.toString();
    return await bc.get(`/v2/orders${qs ? `?${qs}` : ""}`, {
      storeHash: store_Hash,
    });
  } catch (error) {
    return {
      error: `An error occurred while getting all orders: ${error.message}`,
    };
  }
};

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "get_all_orders",
      description:
        "Get all orders from the BigCommerce API. Can filter by customer_id to get products associated with specific customers through their order history. Store hash is taken from the BC_STORE_HASH secret unless overridden.",
      parameters: {
        type: "object",
        properties: {
          store_Hash: {
            type: "string",
            description:
              "Optional store hash. If not provided, uses the BC_STORE_HASH secret.",
          },
          customer_id: {
            type: "integer",
            description:
              "Filter orders by specific customer ID to get products associated with that customer.",
          },
          email: {
            type: "string",
            description: "Filter orders by customer email address.",
          },
          status_id: {
            type: "integer",
            description:
              "Filter orders by status ID (e.g., 1=Pending, 7=Awaiting Payment, 11=Awaiting Fulfillment).",
          },
          min_id: {
            type: "integer",
            description: "Minimum order ID for filtering.",
          },
          max_id: {
            type: "integer",
            description: "Maximum order ID for filtering.",
          },
          min_total: {
            type: "number",
            description: "Minimum order total amount for filtering.",
          },
          max_total: {
            type: "number",
            description: "Maximum order total amount for filtering.",
          },
          min_date_created: {
            type: "string",
            description:
              "Minimum date created for filtering (ISO 8601 format, e.g., 2023-01-01T00:00:00Z).",
          },
          max_date_created: {
            type: "string",
            description:
              "Maximum date created for filtering (ISO 8601 format, e.g., 2023-12-31T23:59:59Z).",
          },
          min_date_modified: {
            type: "string",
            description:
              "Minimum date modified for filtering (ISO 8601 format, e.g., 2023-01-01T00:00:00Z).",
          },
          max_date_modified: {
            type: "string",
            description:
              "Maximum date modified for filtering (ISO 8601 format, e.g., 2023-12-31T23:59:59Z).",
          },
          channel_id: {
            type: "integer",
            description: "Filter orders by channel ID.",
          },
          payment_method: {
            type: "string",
            description:
              "Filter orders by payment method (e.g., credit_card, paypal, manual).",
          },
          cart_id: {
            type: "string",
            description: "Filter orders by cart ID.",
          },
          external_order_id: {
            type: "string",
            description: "Filter orders by external order ID.",
          },
          sort: {
            type: "string",
            description:
              "Sort field and direction (e.g., date_created:desc, id:asc, total:desc).",
          },
          limit: {
            type: "integer",
            description: "Number of results to return (default: 50, max: 250).",
          },
          page: {
            type: "integer",
            description: "Page number to return (default: 1).",
          },
        },
        required: [],
      },
    },
  },
};

export { apiTool };
