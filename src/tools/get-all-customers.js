/**
 * get_all_customers — list customers from the BigCommerce Customers API v3
 * with comprehensive filtering. Ported to the Workers `bc` client; tool name
 * and input schema are unchanged from the upstream fork.
 */

const executeFunction = async (
  {
    store_Hash,
    id,
    email,
    name,
    name_like,
    company,
    phone,
    customer_group_id,
    registration_ip_address,
    date_created,
    date_created_min,
    date_created_max,
    date_modified,
    date_modified_min,
    date_modified_max,
    sort,
    include,
    limit = 50,
    page = 1,
  } = {},
  { bc }
) => {
  try {
    const q = new URLSearchParams();
    if (id) q.append("id:in", id);
    if (email) q.append("email:in", email);
    if (name) q.append("name:in", name);
    if (name_like) q.append("name:like", name_like);
    if (company) q.append("company:in", company);
    if (phone) q.append("phone:in", phone);
    if (customer_group_id)
      q.append("customer_group_id:in", customer_group_id.toString());
    if (registration_ip_address)
      q.append("registration_ip_address:in", registration_ip_address);
    if (date_created) q.append("date_created", date_created);
    if (date_created_min) q.append("date_created:min", date_created_min);
    if (date_created_max) q.append("date_created:max", date_created_max);
    if (date_modified) q.append("date_modified", date_modified);
    if (date_modified_min) q.append("date_modified:min", date_modified_min);
    if (date_modified_max) q.append("date_modified:max", date_modified_max);
    if (sort) q.append("sort", sort);
    if (include) q.append("include", include);
    if (limit) q.append("limit", limit.toString());
    if (page) q.append("page", page.toString());

    const qs = q.toString();
    return await bc.get(`/v3/customers${qs ? `?${qs}` : ""}`, {
      storeHash: store_Hash,
    });
  } catch (error) {
    return {
      error: `An error occurred while getting all customers: ${error.message}`,
    };
  }
};

const apiTool = {
  function: executeFunction,
  definition: {
    type: "function",
    function: {
      name: "get_all_customers",
      description:
        "Get all customers from the BigCommerce API with comprehensive filtering options (email, name, company, phone, customer group, dates, pagination). Store hash is taken from the BC_STORE_HASH secret unless overridden.",
      parameters: {
        type: "object",
        properties: {
          store_Hash: {
            type: "string",
            description:
              "Optional store hash. If not provided, uses the BC_STORE_HASH secret.",
          },
          id: {
            type: "string",
            description:
              'Filter by customer IDs (comma-separated for multiple IDs, e.g., "1,2,3").',
          },
          email: {
            type: "string",
            description: "Filter by customer email address (exact match).",
          },
          name: {
            type: "string",
            description: "Filter by customer full name (exact match).",
          },
          name_like: {
            type: "string",
            description:
              "Filter by customer name using partial match (substring search).",
          },
          company: {
            type: "string",
            description: "Filter by company name (exact match).",
          },
          phone: {
            type: "string",
            description: "Filter by phone number (exact match).",
          },
          customer_group_id: {
            type: "string",
            description:
              "Filter by customer group ID (comma-separated for multiple groups).",
          },
          registration_ip_address: {
            type: "string",
            description: "Filter by registration IP address (exact match).",
          },
          date_created: {
            type: "string",
            description:
              "Filter by exact customer creation date (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS).",
          },
          date_created_min: {
            type: "string",
            description:
              "Filter customers created after this date (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS).",
          },
          date_created_max: {
            type: "string",
            description:
              "Filter customers created before this date (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS).",
          },
          date_modified: {
            type: "string",
            description:
              "Filter by exact customer modification date (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS).",
          },
          date_modified_min: {
            type: "string",
            description:
              "Filter customers modified after this date (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS).",
          },
          date_modified_max: {
            type: "string",
            description:
              "Filter customers modified before this date (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS).",
          },
          sort: {
            type: "string",
            description:
              'Sort field and direction (e.g., "date_created:desc", "last_name:asc", "date_modified:desc").',
          },
          include: {
            type: "string",
            description:
              "Include additional customer sub-resources (comma-separated: addresses, storecredit, attributes, formfields).",
          },
          limit: {
            type: "integer",
            description: "Number of results to return (max 250, default 50).",
          },
          page: {
            type: "integer",
            description: "Page number for pagination (default 1).",
          },
        },
        required: [],
      },
    },
  },
};

export { apiTool };
