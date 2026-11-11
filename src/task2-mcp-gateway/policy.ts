/**
 * Authorization policy for MCP traffic. These are pure functions with no I/O,
 * so the logic is easy to unit-test and to audit.
 */

export const ROLES = ["admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

/** JSON-RPC error codes the gateway uses. The -32000..-32099 range is reserved for implementations. */
export const GatewayErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  InvalidParams: -32602,
  InternalError: -32603,
  Unauthenticated: -32000,
  UnauthorizedToolCall: -32001,
  UpstreamUnavailable: -32002,
} as const;

/**
 * Decides whether a tool name is privileged. We normalise before checking
 * (Unicode NFKC + lower-case) so look-alike names such as "ADMIN_reset_key" or
 * a full-width "ａｄｍｉｎ_reset_key" cannot slip past the prefix check if the
 * downstream server ever matches names loosely. False positives here only ever
 * deny, never allow.
 */
export function isAdminTool(toolName: string): boolean {
  return toolName.normalize("NFKC").trim().toLowerCase().startsWith("admin_");
}

export type Decision =
  | { action: "forward" }
  | { action: "deny"; code: number; message: string; httpStatus: number };

export interface JsonRpcRequestLike {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

/** Validates that a parsed body is one JSON-RPC 2.0 message (batches are rejected). */
export function validateEnvelope(body: unknown): { ok: true; msg: JsonRpcRequestLike } | { ok: false; decision: Decision } {
  if (Array.isArray(body)) {
    // MCP (2025-06-18) dropped JSON-RPC batching. Rejecting batches outright
    // also closes a common bypass, where one admin_* call hides inside an
    // otherwise allowed batch.
    return { ok: false, decision: deny(GatewayErrorCode.InvalidRequest, "Batch requests are not supported", 400) };
  }
  if (typeof body !== "object" || body === null) {
    return { ok: false, decision: deny(GatewayErrorCode.InvalidRequest, "Request must be a JSON-RPC 2.0 object", 400) };
  }
  const msg = body as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0") {
    return { ok: false, decision: deny(GatewayErrorCode.InvalidRequest, 'jsonrpc must be "2.0"', 400) };
  }
  // JSON-RPC responses (from client to server, e.g. answering sampling/elicitation) have no method.
  if ("method" in msg && typeof msg.method !== "string") {
    return { ok: false, decision: deny(GatewayErrorCode.InvalidRequest, "method must be a string", 400) };
  }
  return { ok: true, msg: msg as unknown as JsonRpcRequestLike };
}

/** Method-level authorization for one JSON-RPC message. */
export function authorize(msg: JsonRpcRequestLike, role: Role): Decision {
  if (msg.method !== "tools/call") {
    // tools/list and the rest of the MCP surface pass through transparently.
    return { action: "forward" };
  }
  const params = msg.params as { name?: unknown } | undefined;
  if (typeof params !== "object" || params === null || typeof params.name !== "string" || params.name.length === 0) {
    return deny(GatewayErrorCode.InvalidParams, "tools/call requires params.name (string)", 200);
  }
  if (isAdminTool(params.name) && role !== "admin") {
    // HTTP 200 with a JSON-RPC error body: the agent's MCP client surfaces this
    // as a normal tool-call error, not as a transport failure.
    return deny(GatewayErrorCode.UnauthorizedToolCall, "Unauthorized Tool Call", 200);
  }
  return { action: "forward" };
}

function deny(code: number, message: string, httpStatus: number): Decision {
  return { action: "deny", code, message, httpStatus };
}
