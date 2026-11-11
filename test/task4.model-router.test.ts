import "./helpers.js";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type http from "node:http";
import { TokenRateLimiter, estimateRequestTokens } from "../src/task4-model-router/rate-limiter.js";
import { createRouterServer } from "../src/task4-model-router/server.js";
import { CircuitBreaker, ModelRouter } from "../src/task4-model-router/router.js";
import { createMockProvider } from "../src/task4-model-router/mock-providers.js";
import { createLogger } from "../src/shared/logger.js";
import { close, listen } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "router-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let dbN = 0;
const freshDb = () => join(dir, `limits-${++dbN}.db`);

describe("Task 4: token sliding-window rate limiter (SQLite)", () => {
  test("admits up to the limit, rejects beyond it, and computes Retry-After", () => {
    let now = 1_000_000;
    const rl = new TokenRateLimiter({ dbPath: freshDb(), limitTokens: 50_000, now: () => now });
    const a = rl.reserve("key-a", 30_000);
    assert.ok(a.allowed);
    now += 20_000;
    assert.ok(rl.reserve("key-a", 20_000).allowed); // exactly at the limit
    now += 1_000;
    const denied = rl.reserve("key-a", 1);
    assert.equal(denied.allowed, false);
    // The first reservation (30k at t=1,000,000) leaves the window at t=1,060,000, which is 39 s from now.
    assert.ok(!denied.allowed && denied.retryAfterMs === 39_000, JSON.stringify(denied));
    rl.close();
  });

  test("the window slides: old usage is evicted exactly at window expiry", () => {
    let now = 0;
    const rl = new TokenRateLimiter({ dbPath: freshDb(), limitTokens: 10_000, windowMs: 60_000, now: () => now });
    assert.ok(rl.reserve("k", 10_000).allowed);
    now = 59_999;
    assert.equal(rl.reserve("k", 1).allowed, false);
    now = 60_000;
    assert.ok(rl.reserve("k", 10_000).allowed);
    assert.equal(rl.usage("k"), 10_000);
    rl.close();
  });

  test("tenants are isolated", () => {
    const rl = new TokenRateLimiter({ dbPath: freshDb(), limitTokens: 100 });
    assert.ok(rl.reserve("tenant-a", 100).allowed);
    assert.ok(rl.reserve("tenant-b", 100).allowed);
    assert.equal(rl.reserve("tenant-a", 1).allowed, false);
    rl.close();
  });

  test("commit corrects the estimate and release refunds it", () => {
    const rl = new TokenRateLimiter({ dbPath: freshDb(), limitTokens: 1000 });
    const r = rl.reserve("k", 800);
    assert.ok(r.allowed);
    rl.commit(r.reservationId, 120);
    assert.equal(rl.usage("k"), 120);
    const r2 = rl.reserve("k", 500);
    assert.ok(r2.allowed);
    rl.release(r2.reservationId);
    assert.equal(rl.usage("k"), 120);
    rl.close();
  });

  test("a request larger than the whole budget is rejected as exceeds_limit", () => {
    const rl = new TokenRateLimiter({ dbPath: freshDb(), limitTokens: 1000 });
    const r = rl.reserve("k", 1001);
    assert.ok(!r.allowed && r.reason === "exceeds_limit");
    rl.close();
  });

  test("state is persisted on disk and shared between instances (multi-process safe)", () => {
    const path = freshDb();
    const a = new TokenRateLimiter({ dbPath: path, limitTokens: 1000 });
    const b = new TokenRateLimiter({ dbPath: path, limitTokens: 1000 });
    assert.ok(a.reserve("k", 600).allowed);
    assert.equal(b.reserve("k", 600).allowed, false, "second instance must see first instance's usage");
    assert.ok(b.reserve("k", 400).allowed);
    a.close();
    b.close();
    const reopened = new TokenRateLimiter({ dbPath: path, limitTokens: 1000 });
    assert.equal(reopened.usage("k"), 1000);
    reopened.close();
  });

  test("sweep() evicts expired rows across all tenants", () => {
    let now = 0;
    const rl = new TokenRateLimiter({ dbPath: freshDb(), now: () => now });
    rl.reserve("a", 10);
    rl.reserve("b", 10);
    now = 120_000;
    assert.equal(rl.sweep(), 2);
    rl.close();
  });

  test("estimateRequestTokens counts the prompt plus the completion budget", () => {
    assert.equal(estimateRequestTokens({ messages: [{ content: "x".repeat(400) }], max_tokens: 100 }), 100 + 4 + 100);
  });
});

describe("Task 4: model router with failover (integration)", () => {
  const primary = createMockProvider("primary", "ok", 600);
  const secondary = createMockProvider("secondary");
  let server: http.Server;
  let url = "";
  let limiter: TokenRateLimiter;
  const TENANT = "tenant-a-key";

  before(async () => {
    const pUrl = await listen(primary.server);
    const sUrl = await listen(secondary.server);
    limiter = new TokenRateLimiter({ dbPath: freshDb(), limitTokens: 50_000 });
    const log = createLogger("test-router");
    const primaryCfg = { name: "primary", baseUrl: `${pUrl}/v1`, timeoutMs: 300 };
    const secondaryCfg = { name: "secondary", baseUrl: `${sUrl}/v1`, timeoutMs: 2000 };
    // A high breaker threshold keeps these tests independent; the breaker has its own unit test.
    const router = new ModelRouter({ primary: primaryCfg, secondary: secondaryCfg, limiter, log, breaker: new CircuitBreaker(1000) });
    server = createRouterServer({ tenantApiKeys: [TENANT, "tenant-b-key"], limiter, primary: primaryCfg, secondary: secondaryCfg, log, router });
    url = await listen(server);
  });
  after(async () => {
    await close(server, primary.server, secondary.server);
    limiter.close();
  });
  beforeEach(() => {
    primary.state.mode = "ok";
    primary.state.calls = 0;
    secondary.state.mode = "ok";
    secondary.state.calls = 0;
  });

  const complete = async (key = TENANT, body: Record<string, unknown> = { model: "gpt-x", max_tokens: 50, messages: [{ role: "user", content: "hi" }] }) => {
    const t0 = performance.now();
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: JSON.parse(text), ms: performance.now() - t0 };
  };

  test("a healthy primary serves the request and actual usage is committed", async () => {
    const before = limiter.usage(TENANT);
    const r = await complete();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-gateway-route"), "primary");
    assert.equal(secondary.state.calls, 0);
    assert.equal(limiter.usage(TENANT) - before, r.json.usage.total_tokens, "reservation replaced by actual usage");
  });

  test("primary 429 fails over to secondary", async () => {
    primary.state.mode = "429";
    const r = await complete();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-gateway-route"), "fallback");
    assert.match(r.json.choices[0].message.content, /secondary/);
    assert.equal(primary.state.calls, 1);
    assert.equal(secondary.state.calls, 1);
  });

  test("a primary timeout fails over at the deadline, without waiting for the slow reply", async () => {
    primary.state.mode = "slow"; // replies after 600 ms; the deadline is 300 ms
    const r = await complete();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-gateway-route"), "fallback");
    assert.ok(r.ms < 580, `took ${r.ms.toFixed(0)}ms; should fail over at ~300ms`);
  });

  test("primary 5xx with a stack trace fails over, and nothing leaks", async () => {
    primary.state.mode = "500";
    secondary.state.mode = "500";
    const r = await complete();
    assert.equal(r.status, 503);
    assert.deepEqual(Object.keys(r.json.error).sort(), ["code", "message", "request_id", "type"]);
    assert.equal(r.json.error.code, "upstream_unavailable");
    for (const secret of ["ECONNREFUSED", "10.0.3.17", "TCPConnectWrap", "primary", "secondary", "org-internal"]) {
      assert.ok(!r.text.includes(secret), `leaked ${secret}`);
    }
  });

  test("both providers timing out gives 504, and the reservation is released", async () => {
    primary.state.mode = "slow";
    const slowSecondary = createMockProvider("secondary-slow", "slow", 1000);
    const sUrl = await listen(slowSecondary.server);
    const rl = new TokenRateLimiter({ dbPath: freshDb() });
    const router = new ModelRouter({
      primary: { name: "p", baseUrl: `http://127.0.0.1:${(primary.server.address() as any).port}/v1`, timeoutMs: 150 },
      secondary: { name: "s", baseUrl: `${sUrl}/v1`, timeoutMs: 150 },
      limiter: rl,
      log: createLogger("t"),
    });
    await assert.rejects(
      router.route("k", { messages: [{ role: "user", content: "hi" }] }, { requestId: "r1", signal: new AbortController().signal }),
      (e: any) => e.status === 504 && e.code === "upstream_timeout",
    );
    assert.equal(rl.usage("k"), 0, "tenant must not be charged for a failed request");
    rl.close();
    await close(slowSecondary.server);
  });

  test("a primary 4xx (bad request) does NOT fail over", async () => {
    primary.state.mode = "400";
    const r = await complete();
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "invalid_request");
    assert.equal(secondary.state.calls, 0);
    assert.ok(!r.text.includes("temperature"), "upstream error text is not echoed");
  });

  test("an unknown API key gets 401 with the standard error shape", async () => {
    const r = await complete("nope");
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, "unauthorized");
    assert.ok(r.json.error.request_id);
  });

  test("going over the token budget gets 429 with Retry-After, and providers are never called", async () => {
    const key = "tenant-b-key";
    const big = { messages: [{ role: "user", content: "x" }], max_tokens: 30_000 };
    primary.state.mode = "slow"; // keep the first request in flight so its reservation is still the estimate
    const first = complete(key, big);
    await new Promise((r) => setTimeout(r, 50));
    const second = await complete(key, big);
    assert.equal(second.status, 429);
    assert.equal(second.json.error.code, "rate_limited");
    assert.ok(Number(second.headers.get("retry-after")) > 0);
    await first;
  });

  test("concurrent requests never over-admit beyond the token budget", async () => {
    const rl = new TokenRateLimiter({ dbPath: freshDb(), limitTokens: 10_000 });
    let inflight = 0;
    let admitted = 0;
    const fakeFetch: typeof fetch = async (_url, init) => {
      inflight++;
      await new Promise((r) => setTimeout(r, 50));
      inflight--;
      admitted++;
      const req = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [], usage: { total_tokens: req.max_tokens } }), { status: 200 });
    };
    const router = new ModelRouter({
      primary: { name: "p", baseUrl: "http://p", timeoutMs: 1000 },
      secondary: { name: "s", baseUrl: "http://s", timeoutMs: 1000 },
      limiter: rl,
      log: createLogger("t"),
      fetchImpl: fakeFetch,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        router.route("k", { messages: [{ role: "user", content: "hi" }], max_tokens: 995 }, { requestId: String(i), signal: new AbortController().signal }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const limited = results.filter((r) => r.status === "rejected" && (r.reason as any).status === 429).length;
    assert.equal(ok, 10, "1000-token requests against a 10,000-token budget: exactly 10 fit");
    assert.equal(limited, 15);
    assert.equal(admitted, 10);
    assert.ok(rl.usage("k") <= 10_000);
    rl.close();
  });

  test("the circuit breaker skips a failing primary after the threshold, then half-opens after the cooldown", () => {
    let now = 0;
    const cb = new CircuitBreaker(3, 1000, () => now);
    cb.failure();
    cb.failure();
    assert.ok(cb.canAttempt());
    cb.failure();
    assert.equal(cb.canAttempt(), false);
    now = 1000;
    assert.ok(cb.canAttempt(), "half-open after cooldown");
    cb.success();
    assert.ok(cb.canAttempt());
  });
});
