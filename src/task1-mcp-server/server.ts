#!/usr/bin/env node
/**
 * Task 1: a customer-operations MCP server over stdio.
 *
 * Design notes:
 *  - It uses the SDK's low-level `Server` rather than `McpServer`. In SDK 1.x,
 *    `McpServer` catches input validation failures and turns them into a
 *    successful result with `isError: true`. The brief asks for standard JSON-RPC
 *    error codes, so we validate ourselves and throw `McpError(InvalidParams, -32602)`.
 *  - We separate protocol errors from tool errors, as the MCP spec does:
 *      * malformed or invalid arguments, or an unknown tool -> JSON-RPC error -32602
 *      * an unknown JSON-RPC method -> -32601 (the SDK handles this)
 *      * valid input that breaks a business rule (customer not found, refund
 *        over balance) -> tool result with isError: true, so the LLM can reason about it
 *      * unexpected crashes -> -32603, with a generic message (no stack traces on the wire)
 *  - stdout carries JSON-RPC only. All logging goes through a stderr logger, and
 *    console.* is redirected to stderr as a safety net.
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { createLogger, redirectConsoleToStderr } from "../shared/logger.js";
import { formatIssues, GetCustomerRecordInput, toInputSchema, TriggerRefundInput } from "./schemas.js";
import { CustomerStore, DomainError } from "./store.js";

const log = createLogger("mcp-customer-server");

interface ToolDefinition<S extends z.ZodType> {
  tool: Tool;
  schema: S;
  handler: (args: z.infer<S>, store: CustomerStore) => CallToolResult;
}

function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

const TOOLS = [
  defineTool({
    schema: GetCustomerRecordInput,
    tool: {
      name: "get_customer_record",
      title: "Get customer record",
      description: "Look up a customer's profile, tier, status and refund history by customer ID (format CUST-XXXXX).",
      inputSchema: toInputSchema(GetCustomerRecordInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler: ({ customer_id }, store) => {
      const record = store.get(customer_id);
      if (!record) throw new DomainError(`Customer ${customer_id} not found`);
      return {
        content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
        structuredContent: { ...record },
      };
    },
  }),
  defineTool({
    schema: TriggerRefundInput,
    tool: {
      name: "trigger_refund",
      title: "Trigger refund",
      description:
        "Issue a refund to a customer. Amount must be positive with at most 2 decimals; reason must be at least 10 characters.",
      inputSchema: toInputSchema(TriggerRefundInput),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler: ({ customer_id, amount, reason }, store) => {
      const refund = store.refund(customer_id, amount, reason);
      return {
        content: [{ type: "text", text: `Refund ${refund.refund_id} of $${refund.amount.toFixed(2)} processed for ${customer_id}.` }],
        structuredContent: { ...refund },
      };
    },
  }),
] as const;

const toolsByName = new Map<string, (typeof TOOLS)[number]>(TOOLS.map((t) => [t.tool.name, t]));

export function createCustomerServer(store = new CustomerStore()): Server {
  const server = new Server(
    { name: "customer-ops-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: "Customer operations tools. Always call get_customer_record before trigger_refund.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const def = toolsByName.get(name);
    if (!def) {
      // The MCP spec uses -32602 for "Unknown tool".
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`, { tool: name });
    }

    // A missing `arguments` is validated as {}, so required-field errors stay precise.
    const parsed = def.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = formatIssues(parsed.error);
      log.warn("rejected tool call: invalid arguments", { tool: name, issues });
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool ${name}`, { tool: name, issues });
    }

    try {
      // The cast is safe: `parsed` came from this definition's own schema.
      const result = (def.handler as (a: unknown, s: CustomerStore) => CallToolResult)(parsed.data, store);
      log.info("tool call succeeded", { tool: name });
      return result;
    } catch (err) {
      if (err instanceof DomainError) {
        log.info("tool call rejected by business rule", { tool: name, reason: err.message });
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      log.error("tool call failed unexpectedly", { tool: name, error: err instanceof Error ? err.stack : String(err) });
      throw new McpError(ErrorCode.InternalError, "Internal error while executing tool");
    }
  });

  server.onerror = (err) => log.error("protocol error", { error: err.message });
  return server;
}

async function main(): Promise<void> {
  redirectConsoleToStderr();

  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: err.stack });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { error: reason instanceof Error ? reason.stack : String(reason) });
    process.exit(1);
  });

  const server = createCustomerServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("customer-ops MCP server listening on stdio");

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // When the client closes stdin we deliberately do NOT call process.exit().
  // Pipe writes are asynchronous on Windows, and exiting early could drop
  // responses still being flushed to stdout. With stdin closed, no handles keep
  // the event loop alive, so the process exits on its own once output drains.
  process.stdin.on("end", () => log.info("stdin closed; exiting after pending output drains"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
