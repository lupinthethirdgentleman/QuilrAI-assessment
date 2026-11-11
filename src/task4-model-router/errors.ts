/**
 * Standardized gateway errors. Clients only ever receive:
 *   { "error": { "type": string, "code": string, "message": string, "request_id": string } }
 * Upstream status bodies, stack traces, hostnames and provider names stay in
 * server-side logs, which are correlated by request_id.
 */
export type GatewayErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "rate_limited"
  | "request_too_large"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "internal_error";

const TYPE_BY_CODE: Record<GatewayErrorCode, string> = {
  invalid_request: "invalid_request_error",
  unauthorized: "authentication_error",
  rate_limited: "rate_limit_error",
  request_too_large: "invalid_request_error",
  upstream_unavailable: "api_error",
  upstream_timeout: "api_error",
  internal_error: "api_error",
};

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: GatewayErrorCode,
    readonly publicMessage: string,
    readonly headers: Record<string, string> = {},
    /** Internal detail, logged only, never serialized to clients. */
    readonly internal?: unknown,
  ) {
    super(publicMessage);
  }
}

export interface GatewayErrorBody {
  error: { type: string; code: GatewayErrorCode; message: string; request_id: string };
}

/** Maps any thrown value to a safe status, headers and body. Unknown errors become a generic 500. */
export function toErrorResponse(err: unknown, requestId: string): { status: number; headers: Record<string, string>; body: GatewayErrorBody } {
  const ge = err instanceof GatewayError ? err : new GatewayError(500, "internal_error", "An internal error occurred");
  return {
    status: ge.status,
    headers: ge.headers,
    body: { error: { type: TYPE_BY_CODE[ge.code], code: ge.code, message: ge.publicMessage, request_id: requestId } },
  };
}
