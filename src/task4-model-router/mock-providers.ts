/**
 * Mock OpenAI-compatible providers for demonstrating failover.
 *   primary   :9092  behaviour set by MOCK_PRIMARY_MODE or POST /__mode {"mode": "..."}
 *   secondary :9093  always healthy
 * Modes: ok | 429 | 400 | slow (5 s, longer than the 3 s deadline) | 500 (returns a stack trace the gateway must not leak)
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createLogger } from "../shared/logger.js";
import { readBody, sendJson } from "../shared/http.js";

const log = createLogger("mock-providers");

export type MockMode = "ok" | "429" | "slow" | "500" | "400";

export function createMockProvider(name: string, initialMode: MockMode = "ok", slowMs = 5000) {
  const state = { mode: initialMode, calls: 0 };
  const server = http.createServer(async (req, res) => {
    const raw = (await readBody(req, 1024 * 1024)).toString("utf8");
    if (req.url === "/__mode") {
      state.mode = JSON.parse(raw).mode;
      return sendJson(res, 200, { mode: state.mode });
    }
    state.calls++;
    const body = JSON.parse(raw || "{}");
    switch (state.mode) {
      case "429":
        return sendJson(res, 429, { error: { message: `Rate limit reached for org-internal-123 on ${name}` } });
      case "500":
        return sendJson(res, 500, { error: "Error: connect ECONNREFUSED 10.0.3.17:5432\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)" });
      case "400":
        return sendJson(res, 400, { error: { message: "Invalid model parameter: temperature must be <= 2" } });
      case "slow":
        await new Promise((r) => setTimeout(r, slowMs));
        if (res.destroyed) return;
    }
    const content = `Hello from ${name}.`;
    const promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
    sendJson(res, 200, {
      id: `chatcmpl-${name}-${state.calls}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? `${name}-model`,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 },
    });
  });
  return { server, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const primary = createMockProvider("primary", (process.env.MOCK_PRIMARY_MODE as MockMode) ?? "ok");
  const secondary = createMockProvider("secondary");
  primary.server.listen(9092, () => log.info("mock primary on :9092", { mode: primary.state.mode }));
  secondary.server.listen(9093, () => log.info("mock secondary on :9093"));
}
