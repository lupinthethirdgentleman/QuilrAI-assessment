/**
 * A mock OpenAI-compatible provider that streams a response containing PII,
 * cut into small random chunks so that emails, SSNs and card numbers land
 * across chunk boundaries.
 *
 * If the last user message starts with "ECHO:", the rest of it is streamed back
 * instead (tests use this). The optional `x-mock-chunk-delay-ms` header sets the
 * pace between chunks.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createLogger } from "../shared/logger.js";
import { readBody, sendJson } from "../shared/http.js";

const log = createLogger("mock-llm");

export const DEFAULT_REPLY =
  "Sure! The customer on file is Jane Doe, reachable at jane.doe@example.com or j.doe+billing@corp.example.co.uk. " +
  "Her SSN is 123-45-6789 and the card on file is 4111 1111 1111 1111 (backup: 5500-0000-0000-0004). " +
  "Order number 1234567890123 is unaffected. Let me know if you need anything else.";

/** Splits text into chunks of 1-7 characters, like a tokenizer cutting mid-word. */
export function chunkText(text: string, seed = 42): string[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const n = 1 + Math.floor(rand() * 7);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

export function createMockLlm(): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return sendJson(res, 404, { error: "not found" });
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
    const last = [...(body.messages ?? [])].reverse().find((m: { role: string }) => m.role === "user");
    const text: string = typeof last?.content === "string" && last.content.startsWith("ECHO:") ? last.content.slice(5) : DEFAULT_REPLY;
    const id = "chatcmpl-mock";
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? "mock-model";

    if (!body.stream) {
      return sendJson(res, 200, { id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
    }

    const delay = Number(req.headers["x-mock-chunk-delay-ms"] ?? 15);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    for (const piece of chunkText(text)) {
      if (res.destroyed) return;
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.end("data: [DONE]\n\n");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 9091);
  createMockLlm().listen(port, () => log.info("mock LLM listening", { port, baseUrl: `http://127.0.0.1:${port}/v1` }));
}
