/**
 * Task 2: an MCP security gateway, i.e. an HTTP/JSON-RPC reverse proxy.
 *
 *   AI agent --(Bearer JWT)--> [ gateway: authn -> parse -> authz -> forward ] --> downstream MCP server
 *
 * Responsibilities:
 *  1. Authenticate: verify the Bearer JWT (HS256, exp/aud) and pull out `sub` and `role`.
 *  2. Parse: strict JSON-RPC 2.0 envelope checks. Batches are rejected.
 *  3. Authorize: tools/list is forwarded transparently. tools/call to an admin_* tool
 *     needs role=admin; otherwise the gateway answers with -32001 itself and the
 *     downstream server is never contacted.
 *  4. Forward: stream the response back, so both plain JSON and Streamable-HTTP SSE
 *     responses work. Hop-by-hop headers are removed, and the client's credential
 *     is NOT passed downstream (no token passthrough). The downstream server gets
 *     gateway-asserted identity headers instead.
 *
 * Security detail: we forward the *re-serialized* message we authorized, never
 * the raw bytes. This closes parser-differential attacks such as
 * {"params":{"name":"admin_reset_key","name":"get_customer_record"}}, where the
 * gateway's parser and the downstream parser pick different duplicate keys.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createLogger } from "../shared/logger.js";
import { BodyTooLargeError, readBody, sendJson } from "../shared/http.js";
import { verifyJwt, JwtError } from "./jwt.js";
import { authorize, GatewayErrorCode, isRole, validateEnvelope, type Role } from "./policy.js";

const log = createLogger("mcp-gateway");

export interface GatewayConfig {
  upstreamUrl: string;
  jwtSecret: string;
  audience?: string;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Headers the gateway asserts. Any client-supplied copies are stripped to prevent spoofing. */
const IDENTITY_HEADERS = ["x-mcp-user-sub", "x-mcp-user-role", "x-request-id"];

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown) {
  const idOut = typeof id === "string" || typeof id === "number" ? id : null;
  return { jsonrpc: "2.0" as const, id: idOut, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function filterRequestHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (v === undefined || HOP_BY_HOP.has(key) || key === "authorization" || IDENTITY_HEADERS.includes(key)) continue;
    out[key] = v;
  }
  return out;
}

function filterResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || (HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "content-length")) continue;
    out[k] = v;
  }
  return out;
}

interface Principal {
  sub: string;
  role: Role;
}

function authenticate(req: IncomingMessage, cfg: GatewayConfig): Principal | { error: string } {
  const header = req.headers.authorization;
  const match = header?.match(/^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)\s*$/);
  if (!match?.[1]) return { error: "missing or malformed Bearer token" };
  try {
    const claims = verifyJwt(match[1], cfg.jwtSecret, { audience: cfg.audience });
    if (!isRole(claims.role)) return { error: "unknown role" };
    return { sub: claims.sub, role: claims.role };
  } catch (err) {
    return { error: err instanceof JwtError ? err.message : "invalid token" };
  }
}

export function createGateway(cfg: GatewayConfig): http.Server {
  const maxBody = cfg.maxBodyBytes ?? 1024 * 1024;
  const upstream = new URL(cfg.upstreamUrl);

  return http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);

    // 1. Authentication (zero trust: every request, every method).
    const principal = authenticate(req, cfg);
    if ("error" in principal) {
      log.warn("authentication failed", { requestId, reason: principal.error });
      return sendJson(res, 401, jsonRpcError(null, GatewayErrorCode.Unauthenticated, "Unauthenticated"), {
        "www-authenticate": `Bearer error="invalid_token"`,
      });
    }

    // GET (SSE stream) and DELETE (session end) on Streamable HTTP carry no JSON-RPC body to inspect.
    if (req.method !== "POST") {
      if (req.method === "GET" || req.method === "DELETE") return forward(req, res, undefined, principal, requestId);
      return sendJson(res, 405, jsonRpcError(null, GatewayErrorCode.InvalidRequest, "Method not allowed"), { allow: "GET, POST, DELETE" });
    }

    // 2. Parse JSON-RPC.
    let parsed: unknown;
    try {
      const raw = await readBody(req, maxBody);
      parsed = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return sendJson(res, 413, jsonRpcError(null, GatewayErrorCode.InvalidRequest, "Request body too large"));
      }
      return sendJson(res, 400, jsonRpcError(null, GatewayErrorCode.ParseError, "Parse error"));
    }

    const envelope = validateEnvelope(parsed);
    if (!envelope.ok) {
      const d = envelope.decision;
      if (d.action === "deny") return sendJson(res, d.httpStatus, jsonRpcError((parsed as { id?: unknown })?.id, d.code, d.message));
      return;
    }
    const msg = envelope.msg;

    // 3. Authorization.
    const decision = authorize(msg, principal.role);
    const toolName = msg.method === "tools/call" ? (msg.params as { name?: unknown })?.name : undefined;
    if (decision.action === "deny") {
      log.warn("request denied", { requestId, sub: principal.sub, role: principal.role, method: msg.method, tool: toolName, code: decision.code });
      return sendJson(res, decision.httpStatus, jsonRpcError(msg.id, decision.code, decision.message));
    }
    log.info("request allowed", { requestId, sub: principal.sub, role: principal.role, method: msg.method, tool: toolName });

    // 4. Forward exactly what we authorized.
    return forward(req, res, Buffer.from(JSON.stringify(msg)), principal, requestId, msg.id);
  });

  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer | undefined,
    principal: Principal,
    requestId: string,
    rpcId?: unknown,
  ): void {
    const target = new URL(req.url ?? "/", upstream);
    // Keep the upstream base path and refuse to let the client point elsewhere.
    target.protocol = upstream.protocol;
    target.host = upstream.host;

    const headers = {
      ...filterRequestHeaders(req.headers),
      "x-mcp-user-sub": principal.sub,
      "x-mcp-user-role": principal.role,
      "x-request-id": requestId,
      "x-forwarded-for": req.socket.remoteAddress ?? "",
      ...(body ? { "content-length": String(body.length), "content-type": "application/json" } : {}),
    };

    const upstreamReq = http.request(target, { method: req.method, headers, timeout: cfg.upstreamTimeoutMs ?? 30_000 }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, filterResponseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    });

    // Waiting for response headers is bounded. Once streaming starts (SSE), the socket timeout is lifted.
    upstreamReq.on("response", () => upstreamReq.setTimeout(0));
    upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream timeout")));
    upstreamReq.on("error", (err) => {
      log.error("upstream request failed", { requestId, error: err.message });
      if (!res.headersSent) sendJson(res, 502, jsonRpcError(rpcId, GatewayErrorCode.UpstreamUnavailable, "Upstream MCP server unavailable"));
      else res.destroy();
    });
    // If the agent disconnects, tear down the upstream request too.
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });

    if (body) upstreamReq.end(body);
    else req.pipe(upstreamReq);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.GATEWAY_JWT_SECRET ?? "dev-only-secret-change-me";
  if (!process.env.GATEWAY_JWT_SECRET) log.warn("GATEWAY_JWT_SECRET not set; using an insecure development secret");
  const port = Number(process.env.PORT ?? 8080);
  const upstreamUrl = process.env.UPSTREAM_MCP_URL ?? "http://127.0.0.1:9090/mcp";
  createGateway({ upstreamUrl, jwtSecret: secret, audience: process.env.GATEWAY_AUDIENCE ?? "mcp-gateway" }).listen(port, () =>
    log.info("MCP gateway listening", { port, upstreamUrl }),
  );
}
