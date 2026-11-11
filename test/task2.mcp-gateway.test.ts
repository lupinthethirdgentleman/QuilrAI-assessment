import "./helpers.js";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/task2-mcp-gateway/gateway.js";
import { createMockMcpServer } from "../src/task2-mcp-gateway/mock-mcp-server.js";
import { signJwt, verifyJwt } from "../src/task2-mcp-gateway/jwt.js";
import { authorize, isAdminTool } from "../src/task2-mcp-gateway/policy.js";
import { close, listen } from "./helpers.js";

const SECRET = "test-secret";
const AUD = "mcp-gateway";
const now = () => Math.floor(Date.now() / 1000);
const token = (role: string, sub = `${role}-user`, extra: Record<string, unknown> = {}) =>
  signJwt({ sub, role, aud: AUD, exp: now() + 300, ...extra }, SECRET);

describe("Task 2: policy (unit)", () => {
  test("isAdminTool normalises case and Unicode look-alikes", () => {
    assert.equal(isAdminTool("admin_reset_key"), true);
    assert.equal(isAdminTool("ADMIN_reset_key"), true);
    assert.equal(isAdminTool("ａｄｍｉｎ_reset_key"), true); // full-width letters, folded by NFKC
    assert.equal(isAdminTool("get_admin_report"), false);
    assert.equal(isAdminTool("administrator"), false);
  });

  test("authorize applies method-level rules", () => {
    const call = (name: unknown) => ({ jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name } });
    assert.deepEqual(authorize({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "viewer"), { action: "forward" });
    assert.equal(authorize(call("admin_reset_key"), "viewer").action, "deny");
    assert.equal(authorize(call("admin_reset_key"), "admin").action, "forward");
    assert.equal(authorize(call("get_customer_record"), "viewer").action, "forward");
    const bad = authorize(call(42), "admin");
    assert.equal(bad.action === "deny" && bad.code, -32602);
  });

  test("JWT verification rejects alg=none, a bad signature, expiry and the wrong audience", () => {
    const good = token("admin");
    assert.equal(verifyJwt(good, SECRET, { audience: AUD }).role, "admin");
    const [, payload] = good.split(".");
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${payload}.`;
    assert.throws(() => verifyJwt(none, SECRET), /alg/);
    assert.throws(() => verifyJwt(good, "other-secret"), /signature/);
    assert.throws(() => verifyJwt(signJwt({ sub: "a", role: "admin", exp: now() - 3600 }, SECRET), SECRET), /expired/);
    assert.throws(() => verifyJwt(signJwt({ sub: "a", role: "admin", aud: "other", exp: now() + 60 }, SECRET), SECRET, { audience: AUD }), /audience/);
  });
});

describe("Task 2: gateway (integration)", () => {
  const mock = createMockMcpServer();
  let gatewayUrl = "";
  let gateway: ReturnType<typeof createGateway>;

  before(async () => {
    const upstream = await listen(mock.server);
    gateway = createGateway({ upstreamUrl: `${upstream}/mcp`, jwtSecret: SECRET, audience: AUD });
    gatewayUrl = await listen(gateway);
  });
  after(() => close(gateway, mock.server));
  beforeEach(() => {
    mock.calls.length = 0;
  });

  const rpc = async (body: unknown, auth?: string, extraHeaders: Record<string, string> = {}) => {
    const res = await fetch(`${gatewayUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...extraHeaders },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as any };
  };
  const toolCall = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

  test("missing, malformed or forged tokens get 401 and never reach downstream", async () => {
    for (const auth of [undefined, "not-a-jwt", token("admin").slice(0, -4) + "AAAA", signJwt({ sub: "x", role: "admin", aud: AUD, exp: now() + 60 }, "wrong-secret")]) {
      const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, -32000);
      assert.match(r.headers.get("www-authenticate") ?? "", /Bearer/);
    }
    assert.equal(mock.calls.length, 0);
  });

  test("a token with an unknown role is rejected", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token("superuser"));
    assert.equal(r.status, 401);
  });

  test("tools/list is forwarded transparently", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/list" }, token("viewer"));
    assert.equal(r.status, 200);
    assert.equal(r.json.id, 7);
    assert.ok(r.json.result.tools.some((t: any) => t.name === "admin_reset_key"));
    assert.equal(mock.calls.length, 1);
  });

  test("a viewer can call non-admin tools", async () => {
    const r = await rpc(toolCall(2, "get_customer_record"), token("viewer", "bob"));
    assert.equal(r.json.result.content[0].text, "executed get_customer_record as bob");
  });

  test("a viewer calling admin_* gets -32001 and downstream is never called", async () => {
    const r = await rpc(toolCall(42, "admin_reset_key"), token("viewer"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { jsonrpc: "2.0", id: 42, error: { code: -32001, message: "Unauthorized Tool Call" } });
    assert.equal(mock.calls.length, 0);
  });

  test("case variants of admin_ are also blocked for viewers", async () => {
    const r = await rpc(toolCall(3, "Admin_Reset_Key"), token("viewer"));
    assert.equal(r.json.error.code, -32001);
    assert.equal(mock.calls.length, 0);
  });

  test("an admin may call admin_* tools", async () => {
    const r = await rpc(toolCall(4, "admin_reset_key"), token("admin", "alice"));
    assert.equal(r.json.result.content[0].text, "executed admin_reset_key as alice");
    assert.equal(mock.calls.length, 1);
  });

  test("duplicate-key smuggling: downstream receives exactly what was authorized", async () => {
    // JSON.parse keeps the LAST duplicate key, so the gateway authorizes "get_customer_record".
    // Because the gateway re-serializes, the downstream server cannot read "admin_reset_key" instead.
    const smuggled = '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"admin_reset_key","name":"get_customer_record"}}';
    const r = await rpc(smuggled, token("viewer"));
    assert.ok(r.json.result);
    assert.equal(mock.calls.length, 1);
    assert.equal((mock.calls[0]!.params as any).name, "get_customer_record");

    const reversed = '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_customer_record","name":"admin_reset_key"}}';
    assert.equal((await rpc(reversed, token("viewer"))).json.error.code, -32001);
    assert.equal(mock.calls.length, 1);
  });

  test("no token passthrough, and spoofed identity headers are replaced", async () => {
    await rpc(toolCall(8, "get_customer_record"), token("viewer", "mallory"), { "x-mcp-user-role": "admin", "x-mcp-user-sub": "root" });
    const headers = mock.calls[0]!.headers;
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["x-mcp-user-role"], "viewer");
    assert.equal(headers["x-mcp-user-sub"], "mallory");
  });

  test("JSON-RPC wire errors: parse error, batch, bad envelope, missing tool name", async () => {
    const t = token("admin");
    assert.equal((await rpc("{not json", t)).json.error.code, -32700);
    const batch = await rpc([toolCall(1, "get_customer_record"), toolCall(2, "admin_reset_key")], token("viewer"));
    assert.equal(batch.status, 400);
    assert.equal(batch.json.error.code, -32600);
    assert.equal((await rpc({ id: 1, method: "tools/list" }, t)).json.error.code, -32600);
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }, t)).json.error.code, -32602);
    assert.equal(mock.calls.length, 0);
  });

  test("oversized bodies are rejected with 413", async () => {
    const big = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: { blob: "a".repeat(1_100_000) } } };
    const r = await rpc(big, token("admin"));
    assert.equal(r.status, 413);
  });

  test("an unreachable upstream maps to 502 / -32002", async () => {
    const orphan = createGateway({ upstreamUrl: "http://127.0.0.1:1/mcp", jwtSecret: SECRET, audience: AUD });
    const url = await listen(orphan);
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token("viewer")}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }),
      });
      assert.equal(res.status, 502);
      const json = (await res.json()) as any;
      assert.equal(json.error.code, -32002);
      assert.equal(json.id, 11);
    } finally {
      await close(orphan);
    }
  });
});
