/**
 * Static tool registry. Cloudflare Workers bundles imports at build time, so
 * tools are imported explicitly here rather than discovered from the filesystem
 * at runtime (as the original Node fork did).
 */

import { apiTool as getAllProducts } from "./get-all-products.js";
import { apiTool as getAllCustomers } from "./get-all-customers.js";
import { apiTool as getAllOrders } from "./get-all-orders.js";
import { apiTool as getDailySales } from "./get-daily-sales.js";
import { apiTool as getRefundsSummary } from "./get-refunds-summary.js";
import { apiTool as getInventoryLevels } from "./get-inventory-levels.js";
import { apiTool as updateInventory } from "./update-inventory.js";

export const tools = [
  getAllProducts,
  getAllCustomers,
  getAllOrders,
  getDailySales,
  getRefundsSummary,
  getInventoryLevels,
  updateInventory,
];
