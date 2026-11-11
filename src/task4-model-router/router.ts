/**
 * A resilient model router: rate limit, then primary, then fallback to secondary.
 *
 *   reserve tokens (SQLite, atomic) ──► primary (3000 ms deadline) ──ok──► commit actual usage
 *                                          │ 429 / timeout / 5xx / network error
 *                                          ▼
 *                                       secondary (own deadline) ──ok──► commit actual usage
 *                                          │ fails
 *                                          ▼
 *                                   release reservation, return a sanitized gateway error
 *
 * Concurrency and timeout race handling:
 *  - Each attempt gets its own AbortController. The deadline timer aborts the
 *    in-flight fetch AND the body read, so a primary that sends headers at
 *    2.9 s and then stalls still counts as a timeout. The aborted request is
 *    torn down (no orphaned sockets), and a late primary response can never
 *    resolve the request once failover has begun.
 *  - The deadline timer is always cleared in `finally`, so no stray timers keep firing.
 *  - A client disconnect (parent signal) aborts whichever attempt is running,
 *    and we do NOT fail over (no point paying for a reply nobody will read).
 *  - 4xx responses other than 429 are not retried on the secondary: the request
 *    itself is bad, so retrying only doubles cost and latency.
 *  - A small circuit breaker skips a primary that keeps failing, so every
 *    request is not charged 3 s of timeout during an outage.
 */
import { GatewayError } from "./errors.js";
import { estimateRequestTokens, type TokenRateLimiter } from "./rate-limiter.js";
import type { Logger } from "../shared/logger.js";

export interface ProviderConfig {
  name: string;
  baseUrl: string; // OpenAI-compatible base, e.g. https://api.openai.com/v1
  apiKey?: string;
  model?: string; // overrides the requested model (e.g. the fallback model name)
  timeoutMs: number;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: Array<{ role: string; content: unknown }>;
  max_tokens?: number;
  max_completion_tokens?: number;
  [k: string]: unknown;
}

export interface RouteResult {
  route: "primary" | "fallback";
  body: Record<string, unknown>;
  remainingTokens: number;
}

type AttemptOutcome =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "retryable"; reason: "rate_limited" | "timeout" | "server_error" | "network_error"; status?: number }
  | { kind: "fatal"; status: number };

class DeadlineExceeded extends Error {}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** False while open. After the cooldown it allows a trial request (half-open). */
  canAttempt(): boolean {
    return this.failures < this.threshold || this.now() - this.openedAt >= this.cooldownMs;
  }

  success(): void {
    this.failures = 0;
  }

  failure(): void {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

export interface RouterDeps {
  primary: ProviderConfig;
  secondary: ProviderConfig;
  limiter: TokenRateLimiter;
  log: Logger;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
}

export class ModelRouter {
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: RouterDeps) {
    this.breaker = deps.breaker ?? new CircuitBreaker();
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async route(apiKey: string, req: ChatCompletionRequest, ctx: { requestId: string; signal: AbortSignal }): Promise<RouteResult> {
    const { limiter, log } = this.deps;
    const estimate = estimateRequestTokens(req);
    const reservation = limiter.reserve(apiKey, estimate);
    if (!reservation.allowed) {
      if (reservation.reason === "exceeds_limit") {
        throw new GatewayError(413, "request_too_large", `Request needs ~${estimate} tokens, above the per-minute limit of ${limiter.limit}`);
      }
      throw new GatewayError(429, "rate_limited", "Token rate limit exceeded for this API key", {
        "retry-after": String(Math.ceil(reservation.retryAfterMs / 1000)),
        "x-ratelimit-limit-tokens": String(limiter.limit),
        "x-ratelimit-remaining-tokens": String(reservation.remaining),
      });
    }

    // This endpoint returns complete JSON responses, so streaming is turned off.
    const body = { ...req, stream: false };

    try {
      let primaryOutcome: AttemptOutcome | undefined;
      if (this.breaker.canAttempt()) {
        primaryOutcome = await this.attempt(this.deps.primary, body, ctx.signal);
        if (primaryOutcome.kind === "ok") {
          this.breaker.success();
          return this.finish("primary", primaryOutcome.body, reservation.reservationId, estimate, apiKey);
        }
        if (primaryOutcome.kind === "fatal") throw this.fatalToGatewayError(primaryOutcome.status);
        this.breaker.failure();
        log.warn("primary failed; failing over", { requestId: ctx.requestId, reason: primaryOutcome.reason, status: primaryOutcome.status });
      } else {
        log.warn("primary circuit open; routing to fallback", { requestId: ctx.requestId });
      }

      const secondaryOutcome = await this.attempt(this.deps.secondary, body, ctx.signal);
      if (secondaryOutcome.kind === "ok") return this.finish("fallback", secondaryOutcome.body, reservation.reservationId, estimate, apiKey);
      if (secondaryOutcome.kind === "fatal") throw this.fatalToGatewayError(secondaryOutcome.status);

      log.error("all providers failed", { requestId: ctx.requestId, primary: primaryOutcome, secondary: secondaryOutcome });
      const allTimedOut = secondaryOutcome.reason === "timeout" && (!primaryOutcome || (primaryOutcome.kind === "retryable" && primaryOutcome.reason === "timeout"));
      throw allTimedOut
        ? new GatewayError(504, "upstream_timeout", "The model providers did not respond in time")
        : new GatewayError(503, "upstream_unavailable", "All model providers are currently unavailable", { "retry-after": "5" });
    } catch (err) {
      // Nothing completed, so the tenant gets the budget back.
      limiter.release(reservation.reservationId);
      throw err;
    }
  }

  private finish(route: RouteResult["route"], body: Record<string, unknown>, reservationId: number, estimate: number, apiKey: string): RouteResult {
    const usage = body.usage as { total_tokens?: unknown } | undefined;
    const actual = typeof usage?.total_tokens === "number" ? usage.total_tokens : estimate;
    this.deps.limiter.commit(reservationId, actual);
    return { route, body, remainingTokens: Math.max(0, this.deps.limiter.limit - this.deps.limiter.usage(apiKey)) };
  }

  private fatalToGatewayError(status: number): GatewayError {
    // 400/404/422 point to a bad request. 401/403 point to OUR credentials, which is not the client's business.
    if (status === 400 || status === 404 || status === 422) {
      return new GatewayError(400, "invalid_request", "The model provider rejected the request");
    }
    return new GatewayError(502, "upstream_unavailable", "The model provider returned an unexpected error");
  }

  /** One provider call under a hard deadline that covers headers AND body. */
  private async attempt(provider: ProviderConfig, body: ChatCompletionRequest, parent: AbortSignal): Promise<AttemptOutcome> {
    if (parent.aborted) throw new GatewayError(499, "invalid_request", "Client closed request");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DeadlineExceeded()), provider.timeoutMs);
    const onParentAbort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", onParentAbort, { once: true });

    try {
      const res = await this.fetchImpl(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
        body: JSON.stringify(provider.model ? { ...body, model: provider.model } : body),
        signal: controller.signal,
      });
      if (res.ok) {
        const json = (await res.json()) as Record<string, unknown>;
        return { kind: "ok", body: json };
      }
      // Read the error body for logs only; it is never returned to clients.
      const detail = await res.text().catch(() => "");
      this.deps.log.warn("provider error response", { provider: provider.name, status: res.status, detail: detail.slice(0, 300) });
      if (res.status === 429) return { kind: "retryable", reason: "rate_limited", status: 429 };
      if (res.status >= 500) return { kind: "retryable", reason: "server_error", status: res.status };
      return { kind: "fatal", status: res.status };
    } catch (err) {
      if (parent.aborted) throw new GatewayError(499, "invalid_request", "Client closed request");
      if (controller.signal.reason instanceof DeadlineExceeded) {
        this.deps.log.warn("provider timed out", { provider: provider.name, timeoutMs: provider.timeoutMs });
        return { kind: "retryable", reason: "timeout" };
      }
      this.deps.log.warn("provider network error", { provider: provider.name, error: err instanceof Error ? err.message : String(err) });
      return { kind: "retryable", reason: "network_error" };
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    }
  }
}
