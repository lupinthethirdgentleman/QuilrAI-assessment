/**
 * Mock downstream MCP server (JSON-RPC over HTTP POST).
 * It records every request it receives, so tests can prove that denied calls
 * never reached it and that client credentials were not forwarded.
 */
import http, { type IncomingHttpHeaders } from "node:http";
import { pathToFileURL } from "node:url";
import { createLogger } from "../shared/logger.js";
import { readBody, sendJson } from "../shared/http.js";

const log = createLogger("mock-mcp-server");

export interface ReceivedCall {
  method: string;
  params: unknown;
  headers: IncomingHttpHeaders;
}

const TOOLS = [
  { name: "get_customer_record", description: "Read a customer record", inputSchema: { type: "object", properties: { customer_id: { type: "string" } } } },
  { name: "list_api_keys", description: "List API key metadata", inputSchema: { type: "object", properties: {} } },
  { name: "admin_reset_key", description: "Rotate a tenant API key (privileged)", inputSchema: { type: "object", properties: { key_id: { type: "string" } } } },
];

export function createMockMcpServer(): { server: http.Server; calls: ReceivedCall[] } {
  const calls: ReceivedCall[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
    const msg = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    calls.push({ method: msg.method, params: msg.params, headers: req.headers });
    log.debug("received", { method: msg.method });

    switch (msg.method) {
      case "initialize":
        return sendJson(res, 200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "1.0.0" } },
        });
      case "notifications/initialized":
        res.writeHead(202).end();
        return;
      case "tools/list":
        return sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      case "tools/call":
        return sendJson(res, 200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `executed ${msg.params?.name} as ${req.headers["x-mcp-user-sub"]}` }] },
        });
      default:
        return sendJson(res, 200, { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: "Method not found" } });
    }
  });
  return { server, calls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 9090);
  createMockMcpServer().server.listen(port, () => log.info("mock MCP server listening", { port, url: `http://127.0.0.1:${port}/mcp` }));
}
