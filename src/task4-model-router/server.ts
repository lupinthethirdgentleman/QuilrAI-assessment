/**
 * Task 4: the HTTP front end for the model router.
 *   POST /v1/chat/completions   Authorization: Bearer <tenant API key>
 */
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createLogger, type Logger } from "../shared/logger.js";
import { BodyTooLargeError, readBody, sendJson } from "../shared/http.js";
import { GatewayError, toErrorResponse } from "./errors.js";
import { hashKey, TokenRateLimiter } from "./rate-limiter.js";
import { ModelRouter, type ChatCompletionRequest, type ProviderConfig } from "./router.js";

export interface RouterServerConfig {
  tenantApiKeys: string[];
  limiter: TokenRateLimiter;
  primary: ProviderConfig;
  secondary: ProviderConfig;
  log?: Logger;
  router?: ModelRouter;
}

export function createRouterServer(cfg: RouterServerConfig): http.Server {
  const log = cfg.log ?? createLogger("model-router");
  const router = cfg.router ?? new ModelRouter({ primary: cfg.primary, secondary: cfg.secondary, limiter: cfg.limiter, log });
  const tenantHashes = cfg.tenantApiKeys.map((k) => Buffer.from(hashKey(k), "hex"));

  const isKnownTenant = (key: string) => {
    const h = Buffer.from(hashKey(key), "hex");
    // Constant-time comparison against every known key hash.
    let match = false;
    for (const t of tenantHashes) match = timingSafeEqual(h, t) || match;
    return match;
  };

  return http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") throw new GatewayError(404, "invalid_request", "Route not found");

      const apiKey = req.headers.authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
      if (!apiKey || !isKnownTenant(apiKey)) throw new GatewayError(401, "unauthorized", "Invalid or missing API key");

      let body: ChatCompletionRequest;
      try {
        body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8"));
      } catch (err) {
        if (err instanceof BodyTooLargeError) throw new GatewayError(413, "request_too_large", "Request body too large");
        throw new GatewayError(400, "invalid_request", "Request body must be valid JSON");
      }
      if (typeof body !== "object" || body === null || !Array.isArray(body.messages) || body.messages.length === 0) {
        throw new GatewayError(400, "invalid_request", "messages must be a non-empty array");
      }

      const result = await router.route(apiKey, body, { requestId, signal: abort.signal });
      log.info("completion served", { requestId, route: result.route });
      sendJson(res, 200, result.body, {
        "x-request-id": requestId,
        "x-gateway-route": result.route,
        "x-ratelimit-limit-tokens": String(cfg.limiter.limit),
        "x-ratelimit-remaining-tokens": String(result.remainingTokens),
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      if (!(err instanceof GatewayError)) {
        log.error("unhandled error", { requestId, error: err instanceof Error ? err.stack : String(err) });
      }
      const { status, headers, body } = toErrorResponse(err, requestId);
      sendJson(res, status, body, { ...headers, "x-request-id": requestId });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = createLogger("model-router");
  const env = process.env;
  const limiter = new TokenRateLimiter({
    dbPath: env.RATE_LIMIT_DB ?? "./rate-limits.db",
    limitTokens: Number(env.TOKENS_PER_MINUTE ?? 50_000),
  });
  setInterval(() => limiter.sweep(), 30_000).unref();

  const server = createRouterServer({
    tenantApiKeys: (env.TENANT_API_KEYS ?? "tenant-a-key,tenant-b-key").split(",").map((s) => s.trim()).filter(Boolean),
    limiter,
    log,
    primary: { name: "primary", baseUrl: env.PRIMARY_BASE_URL ?? "http://127.0.0.1:9092/v1", apiKey: env.PRIMARY_API_KEY, model: env.PRIMARY_MODEL, timeoutMs: Number(env.PRIMARY_TIMEOUT_MS ?? 3000) },
    secondary: { name: "secondary", baseUrl: env.SECONDARY_BASE_URL ?? "http://127.0.0.1:9093/v1", apiKey: env.SECONDARY_API_KEY, model: env.SECONDARY_MODEL, timeoutMs: Number(env.SECONDARY_TIMEOUT_MS ?? 10_000) },
  });
  const port = Number(env.PORT ?? 8082);
  server.listen(port, () => log.info("model router listening", { port }));

  const shutdown = () => server.close(() => { limiter.close(); process.exit(0); });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
