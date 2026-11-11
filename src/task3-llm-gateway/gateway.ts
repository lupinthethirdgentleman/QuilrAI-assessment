/**
 * Task 3: an LLM gateway with a real-time PII redaction guardrail on the response stream.
 *
 *   client --POST /v1/chat/completions--> gateway --(provider key)--> OpenAI-compatible provider
 *          <------ SSE, redacted --------         <------ SSE deltas ---------
 *
 * Latency and memory design:
 *  - Response headers are flushed right away and Nagle is disabled. Each
 *    upstream delta is redacted and written as soon as it arrives. Only the
 *    trailing partial word of each choice is held back (see redactor.ts), so
 *    TTFT increases by roughly one token and memory per stream is O(1).
 *  - Bytes are decoded with a streaming TextDecoder, so multi-byte UTF-8
 *    characters split across TCP chunks are never mangled.
 *  - Backpressure: if the client reads slowly we wait for 'drain' instead of
 *    buffering without limit. Because we iterate the upstream body with
 *    for-await, that pause propagates upstream too.
 *  - If the client disconnects, the upstream request is aborted, which stops token spend.
 *  - Tool-call argument deltas are redacted as well as content deltas, since PII
 *    can leak through either.
 */
import http, { type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createLogger } from "../shared/logger.js";
import { BodyTooLargeError, readBody, sendJson, writeWithBackpressure } from "../shared/http.js";
import { redactText, StreamingRedactor } from "./redactor.js";
import { formatSse, SseParser } from "./sse.js";

const log = createLogger("llm-gateway");

export interface LlmGatewayConfig {
  upstreamBaseUrl: string; // e.g. https://api.openai.com/v1
  upstreamApiKey?: string;
  maxBodyBytes?: number;
}

interface ChatChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{ index: number; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
}

function gatewayError(res: ServerResponse, status: number, type: string, message: string, requestId: string) {
  sendJson(res, status, { error: { type, message, request_id: requestId } });
}

export function createLlmGateway(cfg: LlmGatewayConfig): http.Server {
  return http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);

    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      return gatewayError(res, 404, "not_found", "Route not found", requestId);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req, cfg.maxBodyBytes ?? 2 * 1024 * 1024)).toString("utf8"));
      if (typeof body !== "object" || body === null || !Array.isArray(body.messages)) throw new Error("messages required");
    } catch (err) {
      if (err instanceof BodyTooLargeError) return gatewayError(res, 413, "invalid_request", "Request body too large", requestId);
      return gatewayError(res, 400, "invalid_request", "Body must be JSON with a messages array", requestId);
    }

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        log.info("client disconnected; aborting upstream", { requestId });
        abort.abort();
      }
    });

    try {
      if (body.stream === true) await handleStreaming(res, body, abort.signal, requestId);
      else await handleNonStreaming(res, body, abort.signal, requestId);
    } catch (err) {
      if (abort.signal.aborted) return;
      log.error("gateway failure", { requestId, error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) gatewayError(res, 502, "upstream_error", "LLM provider request failed", requestId);
      else {
        // Mid-stream failure: tell the client in-band, then close cleanly.
        res.write(formatSse(JSON.stringify({ error: { type: "upstream_error", message: "Stream interrupted", request_id: requestId } })));
        res.end();
      }
    }
  });

  async function callUpstream(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    return fetch(`${cfg.upstreamBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.upstreamApiKey ? { authorization: `Bearer ${cfg.upstreamApiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  async function handleNonStreaming(res: ServerResponse, body: Record<string, unknown>, signal: AbortSignal, requestId: string) {
    const upstream = await callUpstream(body, signal);
    if (!upstream.ok) return relayUpstreamFailure(res, upstream, requestId);
    const json = (await upstream.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    for (const choice of json.choices ?? []) {
      if (typeof choice.message?.content === "string") choice.message.content = redactText(choice.message.content);
    }
    sendJson(res, 200, json);
  }

  async function handleStreaming(res: ServerResponse, body: Record<string, unknown>, signal: AbortSignal, requestId: string) {
    const upstream = await callUpstream({ ...body, stream: true }, signal);
    if (!upstream.ok || !upstream.body) return relayUpstreamFailure(res, upstream, requestId);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // keep nginx-style proxies from buffering the stream
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const decoder = new TextDecoder("utf-8");
    const parser = new SseParser();
    // One redactor per output stream: a choice's content, or a choice's tool-call arguments.
    const redactors = new Map<string, StreamingRedactor>();
    const redactorFor = (key: string) => {
      let r = redactors.get(key);
      if (!r) redactors.set(key, (r = new StreamingRedactor()));
      return r;
    };
    let template: Pick<ChatChunk, "id" | "object" | "created" | "model"> = {};
    let done = false;

    /** Releases held-back text for every stream that is still open, as synthetic chunks. */
    const flushAll = async () => {
      for (const [key, r] of redactors) {
        const tail = r.flush();
        redactors.delete(key);
        if (!tail) continue;
        const [choiceIdx, kind, toolIdx] = key.split(":");
        const delta = kind === "tool" ? { tool_calls: [{ index: Number(toolIdx), function: { arguments: tail } }] } : { content: tail };
        await writeWithBackpressure(res, formatSse(JSON.stringify({ ...template, choices: [{ index: Number(choiceIdx), delta, finish_reason: null }] })));
      }
    };

    const handleData = async (data: string) => {
      if (data === "[DONE]") {
        await flushAll();
        await writeWithBackpressure(res, formatSse("[DONE]"));
        done = true;
        return;
      }
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        // Fail closed: an event we cannot parse cannot be inspected, so it is dropped.
        log.warn("dropping unparseable upstream event", { requestId });
        return;
      }
      template = { id: chunk.id, object: chunk.object, created: chunk.created, model: chunk.model };

      let meaningful = chunk.usage !== undefined;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (delta && typeof delta.content === "string") {
          const r = redactorFor(`${choice.index}:content`);
          delta.content = r.push(delta.content);
          if (choice.finish_reason) {
            delta.content += r.flush();
            redactors.delete(`${choice.index}:content`);
          }
        } else if (choice.finish_reason && redactors.has(`${choice.index}:content`)) {
          // The finish chunk had no content, but text is still held back: attach it here.
          const r = redactors.get(`${choice.index}:content`)!;
          choice.delta = { ...delta, content: r.flush() };
          redactors.delete(`${choice.index}:content`);
        }
        for (const tc of delta?.tool_calls ?? []) {
          if (typeof tc.function?.arguments === "string") {
            tc.function.arguments = redactorFor(`${choice.index}:tool:${tc.index}`).push(tc.function.arguments);
          }
        }
        if (choice.finish_reason) {
          // Before the finish chunk goes out, release any held-back tool-call arguments for this choice.
          for (const key of [...redactors.keys()].filter((k) => k.startsWith(`${choice.index}:tool:`))) {
            const tail = redactors.get(key)!.flush();
            redactors.delete(key);
            if (tail) {
              await writeWithBackpressure(res, formatSse(JSON.stringify({ ...template, choices: [{ index: choice.index, delta: { tool_calls: [{ index: Number(key.split(":")[2]), function: { arguments: tail } }] }, finish_reason: null }] })));
            }
          }
        }
        const d = choice.delta;
        if (choice.finish_reason || d?.role || d?.content || d?.tool_calls?.some((t) => t.function?.arguments || t.function?.name)) meaningful = true;
      }
      // Skip deltas that became empty because their text is held back; there is nothing to show yet.
      if (meaningful) await writeWithBackpressure(res, formatSse(JSON.stringify(chunk)));
    };

    for await (const bytes of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      for (const ev of parser.push(decoder.decode(bytes, { stream: true }))) await handleData(ev.data);
    }
    for (const ev of parser.push(decoder.decode())) await handleData(ev.data);
    for (const ev of parser.flush()) await handleData(ev.data);

    if (!done) {
      // The upstream ended without [DONE]: still release held-back text and end cleanly.
      await flushAll();
      await writeWithBackpressure(res, formatSse("[DONE]"));
    }
    res.end();
  }

  /** Never echo provider error bodies, which can contain account IDs or internal detail. */
  async function relayUpstreamFailure(res: ServerResponse, upstream: Response, requestId: string) {
    const detail = await upstream.text().catch(() => "");
    log.warn("upstream returned error", { requestId, status: upstream.status, detail: detail.slice(0, 500) });
    const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : upstream.status === 400 ? 400 : 502;
    const type = status === 429 ? "rate_limited" : status === 400 ? "invalid_request" : "upstream_error";
    gatewayError(res, status, type, status === 429 ? "LLM provider rate limit reached" : "LLM provider returned an error", requestId);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8081);
  const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:9091/v1";
  createLlmGateway({ upstreamBaseUrl, upstreamApiKey: process.env.UPSTREAM_API_KEY }).listen(port, () =>
    log.info("LLM gateway listening", { port, upstreamBaseUrl }),
  );
}
