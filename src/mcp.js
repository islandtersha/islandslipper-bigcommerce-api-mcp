/**
 * Stateless MCP (Model Context Protocol) dispatcher over JSON-RPC 2.0.
 *
 * Implements the Streamable HTTP transport's request/response semantics for a
 * stateless tool server: initialize, tools/list, tools/call, ping, and
 * notifications. No sessions, no Durable Objects — every POST /mcp is handled
 * independently, which is all a remote tool connector needs.
 */

import { tools } from "./tools/index.js";
import { createBcClient } from "./bc-client.js";

export const SERVER_NAME = "islandslipper-bc-mcp";
export const SERVER_VERSION = "2.0.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/**
 * Handle a single parsed JSON-RPC message.
 * @returns a JSON-RPC response object, or `null` for notifications (no reply).
 */
export async function handleMcpMessage(message, env) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return errorResponse(message?.id ?? null, -32600, "Invalid Request");
  }

  const { id, method, params } = message;

  // Notifications have no id and expect no response.
  if (id === undefined || id === null) {
    if (typeof method === "string" && method.startsWith("notifications/")) {
      return null;
    }
  }

  switch (method) {
    case "initialize":
      return okResponse(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "ping":
      return okResponse(id, {});

    case "tools/list":
      return okResponse(id, { tools: listTools() });

    case "tools/call":
      return callTool(id, params, env);

    default:
      if (typeof method === "string" && method.startsWith("notifications/")) {
        return null; // tolerate notifications that arrive with an id
      }
      return errorResponse(id, -32601, `Method not found: ${method}`);
  }
}

function listTools() {
  return tools.map((t) => ({
    name: t.definition.function.name,
    description: t.definition.function.description,
    inputSchema: t.definition.function.parameters,
  }));
}

async function callTool(id, params, env) {
  const toolName = params?.name;
  const tool = tools.find((t) => t.definition.function.name === toolName);
  if (!tool) {
    return errorResponse(id, -32602, `Unknown tool: ${toolName}`);
  }

  const args = params.arguments || {};
  const required = tool.definition.function.parameters?.required || [];
  for (const key of required) {
    if (!(key in args)) {
      return errorResponse(id, -32602, `Missing required parameter: ${key}`);
    }
  }

  let bc;
  try {
    bc = createBcClient(env);
  } catch (e) {
    return toolErrorResult(id, e.message);
  }

  try {
    const result = await tool.function(args, { bc, env });

    // Tools signal domain errors by returning an object with an `error` field.
    if (result && typeof result === "object" && result.error) {
      return toolErrorResult(id, result.error);
    }

    return okResponse(id, {
      content: [{ type: "text", text: formatResult(result) }],
    });
  } catch (e) {
    return okResponse(id, {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      isError: true,
    });
  }
}

function formatResult(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    if (Array.isArray(result)) {
      return `Found ${result.length} items:\n${JSON.stringify(result, null, 2)}`;
    }
    if (Array.isArray(result.data)) {
      return `Found ${result.data.length} items:\n${JSON.stringify(result, null, 2)}`;
    }
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

// --- JSON-RPC envelope helpers ---------------------------------------------

function okResponse(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** MCP convention: tool execution failures are a successful RPC with isError. */
function toolErrorResult(id, message) {
  return okResponse(id, {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  });
}
