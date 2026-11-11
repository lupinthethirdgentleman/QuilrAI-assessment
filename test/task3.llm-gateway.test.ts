import "./helpers.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createLlmGateway } from "../src/task3-llm-gateway/gateway.js";
import { createMockLlm, DEFAULT_REPLY } from "../src/task3-llm-gateway/mock-llm.js";
import { redactText } from "../src/task3-llm-gateway/redactor.js";
import { SseParser } from "../src/task3-llm-gateway/sse.js";
import { close, listen } from "./helpers.js";

interface StreamResult {
  content: string;
  events: any[];
  firstContentMs: number;
  totalMs: number;
}

async function streamChat(baseUrl: string, userText: string, delayMs = 10): Promise<StreamResult> {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mock-chunk-delay-ms": String(delayMs) },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: userText }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const events: any[] = [];
  let content = "";
  let firstContentMs = -1;
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    for (const ev of parser.push(decoder.decode(bytes, { stream: true }))) {
      if (ev.data === "[DONE]") {
        events.push("[DONE]");
        continue;
      }
      const chunk = JSON.parse(ev.data);
      events.push(chunk);
      const piece = chunk.choices?.[0]?.delta?.content;
      if (piece) {
        if (firstContentMs < 0) firstContentMs = performance.now() - t0;
        content += piece;
      }
    }
  }
  return { content, events, firstContentMs, totalMs: performance.now() - t0 };
}

describe("Task 3: LLM gateway streaming guardrail (end to end)", () => {
  const mock = createMockLlm();
  let gateway: http.Server;
  let url = "";

  before(async () => {
    const upstream = await listen(mock);
    gateway = createLlmGateway({ upstreamBaseUrl: `${upstream}/v1` });
    url = await listen(gateway);
  });
  after(() => close(gateway, mock));

  test("the streamed response is redacted and matches one-shot redaction exactly", async () => {
    const r = await streamChat(url, "who is the customer?", 2);
    assert.equal(r.content, redactText(DEFAULT_REPLY));
    for (const pii of ["jane.doe@example.com", "123-45-6789", "4111 1111 1111 1111", "5500-0000-0000-0004"]) {
      assert.ok(!r.content.includes(pii), `leaked ${pii}`);
    }
    assert.equal(r.events.at(-1), "[DONE]");
    assert.ok(r.events.some((e) => e !== "[DONE]" && e.choices?.[0]?.finish_reason === "stop"));
  });

  test("the response really streams: first token arrives long before the stream ends (low TTFT)", async () => {
    const r = await streamChat(url, "who is the customer?", 15);
    // About 60 chunks x 15 ms is roughly 900 ms total. The first redacted text must arrive near the start.
    assert.ok(r.firstContentMs >= 0);
    assert.ok(r.firstContentMs < r.totalMs * 0.25, `TTFT ${r.firstContentMs.toFixed(0)}ms vs total ${r.totalMs.toFixed(0)}ms`);
    const contentEvents = r.events.filter((e) => e !== "[DONE]" && e.choices?.[0]?.delta?.content);
    assert.ok(contentEvents.length > 20, "expected many incremental chunks, not one buffered blob");
  });

  test("multi-byte UTF-8 split across network chunks survives intact", async () => {
    const text = "你好 ✅ café — mail 张伟 at zhang.wei@example.cn — 🙂🙂🙂 SSN 219-09-9999 fin.";
    const r = await streamChat(url, `ECHO:${text}`, 0);
    assert.equal(r.content, redactText(text));
    assert.ok(!r.content.includes("�"));
  });

  test("non-streaming requests are redacted too", async () => {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "ECHO:reach me at a@b.io" }] }),
    });
    const json = (await res.json()) as any;
    assert.equal(json.choices[0].message.content, "reach me at [REDACTED]");
  });

  test("a client disconnect aborts the upstream stream", async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const slow = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "tick " } }] })}\n\n`), 10);
      res.on("close", () => {
        clearInterval(timer);
        upstreamClosed();
      });
    });
    const slowUrl = await listen(slow);
    const gw = createLlmGateway({ upstreamBaseUrl: `${slowUrl}/v1` });
    const gwUrl = await listen(gw);
    try {
      const ac = new AbortController();
      const res = await fetch(`${gwUrl}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
        signal: ac.signal,
      });
      const reader = res.body!.getReader();
      await reader.read();
      ac.abort();
      await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("upstream not aborted")), 2000))]);
    } finally {
      await close(gw, slow);
    }
  });

  test("upstream errors are sanitized", async () => {
    const failing = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Traceback: secret-internal-host:5432 password=hunter2" }));
    });
    const fUrl = await listen(failing);
    const gw = createLlmGateway({ upstreamBaseUrl: `${fUrl}/v1` });
    const gwUrl = await listen(gw);
    try {
      const res = await fetch(`${gwUrl}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ stream: true, messages: [] }) });
      const text = await res.text();
      assert.equal(res.status, 502);
      assert.ok(!text.includes("hunter2") && !text.includes("secret-internal-host"));
    } finally {
      await close(gw, failing);
    }
  });
});
