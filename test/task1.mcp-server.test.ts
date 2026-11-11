import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const SERVER = join(import.meta.dirname, "..", "src", "task1-mcp-server", "server.ts");

/** Drives the real server binary over stdio and records every raw stdout line. */
class StdioHarness {
  readonly stdoutLines: string[] = [];
  private readonly waiters = new Map<number, (msg: any) => void>();
  private nextId = 1;
  private proc!: ChildProcessWithoutNullStreams;

  start(): void {
    this.proc = spawn(process.execPath, ["--import", "tsx", SERVER], { env: { ...process.env, LOG_LEVEL: "debug" } });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      this.stdoutLines.push(line);
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === "number") this.waiters.get(msg.id)?.(msg);
      } catch {
        /* the stdout-purity test catches this */
      }
    });
    this.proc.stderr.resume(); // drain stderr so the pipe never fills up
  }

  writeRaw(line: string): void {
    this.proc.stdin.write(line + "\n");
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const p = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
      this.waiters.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
    this.writeRaw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
    return p;
  }

  callTool(name: string, args?: unknown) {
    return this.request("tools/call", { name, ...(args !== undefined ? { arguments: args } : {}) });
  }

  stop(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

describe("Task 1: MCP server over stdio", () => {
  const h = new StdioHarness();

  before(async () => {
    h.start();
    const init = await h.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.serverInfo.name, "customer-ops-mcp");
    h.writeRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  });

  after(() => h.stop());

  test("tools/list advertises both tools with strict JSON schemas", async () => {
    const res = await h.request("tools/list");
    const byName = Object.fromEntries(res.result.tools.map((t: any) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ["get_customer_record", "trigger_refund"]);
    assert.equal(byName.get_customer_record.inputSchema.properties.customer_id.pattern, "^CUST-\\d{5}$");
    assert.equal(byName.trigger_refund.inputSchema.additionalProperties, false);
    assert.deepEqual(byName.trigger_refund.inputSchema.required.sort(), ["amount", "customer_id", "reason"]);
    assert.equal(byName.trigger_refund.annotations.destructiveHint, true);
  });

  test("get_customer_record returns structured content for a valid ID", async () => {
    const res = await h.callTool("get_customer_record", { customer_id: "CUST-00042" });
    assert.equal(res.result.isError, undefined);
    assert.equal(res.result.structuredContent.name, "Alan Turing");
  });

  for (const [label, args] of [
    ["too few digits", { customer_id: "CUST-1234" }],
    ["too many digits", { customer_id: "CUST-123456" }],
    ["lower-case prefix", { customer_id: "cust-12345" }],
    ["leading whitespace", { customer_id: " CUST-12345" }],
    ["letters in the digit block", { customer_id: "CUST-12A45" }],
    ["number instead of string", { customer_id: 12345 }],
    ["missing field", {}],
    ["null", { customer_id: null }],
    ["unknown extra key", { customer_id: "CUST-00042", include_ssn: true }],
  ] as const) {
    test(`get_customer_record rejects ${label} with -32602`, async () => {
      const res = await h.callTool("get_customer_record", args);
      assert.equal(res.result, undefined);
      assert.equal(res.error.code, -32602);
      assert.ok(Array.isArray(res.error.data.issues) && res.error.data.issues.length > 0);
    });
  }

  test("tools/call without an arguments object is rejected with -32602", async () => {
    const res = await h.callTool("get_customer_record");
    assert.equal(res.error.code, -32602);
    assert.equal(res.error.data.issues[0].field, "customer_id");
  });

  const validRefund = { customer_id: "CUST-00001", amount: 25.5, reason: "Item arrived damaged" };
  for (const [label, override, field] of [
    ["zero amount", { amount: 0 }, "amount"],
    ["negative amount", { amount: -10 }, "amount"],
    ["string amount", { amount: "25.50" }, "amount"],
    ["three decimal places", { amount: 10.555 }, "amount"],
    ["amount over the cap", { amount: 1_000_000 }, "amount"],
    ["short reason", { reason: "too short" }, "reason"],
    ["whitespace-padded short reason", { reason: "     abc      " }, "reason"],
    ["non-string reason", { reason: 1234567890 }, "reason"],
    ["bad customer_id", { customer_id: "CUST-1" }, "customer_id"],
  ] as const) {
    test(`trigger_refund rejects ${label} with -32602`, async () => {
      const res = await h.callTool("trigger_refund", { ...validRefund, ...override });
      assert.equal(res.error?.code, -32602, JSON.stringify(res));
      assert.ok(res.error.data.issues.some((i: any) => i.field === field), JSON.stringify(res.error.data));
    });
  }

  test("trigger_refund reports every invalid field at once", async () => {
    const res = await h.callTool("trigger_refund", { customer_id: "x", amount: -1, reason: "no" });
    assert.deepEqual(res.error.data.issues.map((i: any) => i.field).sort(), ["amount", "customer_id", "reason"]);
  });

  test("trigger_refund succeeds for valid input", async () => {
    const res = await h.callTool("trigger_refund", validRefund);
    assert.equal(res.result.isError, undefined);
    assert.match(res.result.structuredContent.refund_id, /^RF-/);
    assert.equal(res.result.structuredContent.amount, 25.5);
  });

  test("business-rule failures are tool errors (isError), not protocol errors", async () => {
    const overBalance = await h.callTool("trigger_refund", { customer_id: "CUST-00042", amount: 9999, reason: "Refund everything please" });
    assert.equal(overBalance.error, undefined);
    assert.equal(overBalance.result.isError, true);
    assert.match(overBalance.result.content[0].text, /exceeds refundable balance/);

    const suspended = await h.callTool("trigger_refund", { customer_id: "CUST-31337", amount: 5, reason: "Courtesy credit for outage" });
    assert.equal(suspended.result.isError, true);

    const missing = await h.callTool("get_customer_record", { customer_id: "CUST-99999" });
    assert.equal(missing.result.isError, true);
  });

  test("unknown tool returns -32602 and unknown method returns -32601", async () => {
    assert.equal((await h.callTool("drop_tables", {})).error.code, -32602);
    assert.equal((await h.request("does/not/exist")).error.code, -32601);
  });

  test("malformed input lines do not crash the server or pollute stdout", async () => {
    h.writeRaw("this is not json");
    h.writeRaw('{"jsonrpc":"2.0","id":');
    const res = await h.callTool("get_customer_record", { customer_id: "CUST-00001" });
    assert.equal(res.result.structuredContent.customer_id, "CUST-00001");
  });

  test("STDIO isolation: every stdout line is a JSON-RPC 2.0 message", () => {
    assert.ok(h.stdoutLines.length > 10);
    for (const line of h.stdoutLines) {
      let msg: any;
      assert.doesNotThrow(() => (msg = JSON.parse(line)), `non-JSON on stdout: ${line}`);
      assert.equal(msg.jsonrpc, "2.0", `non-JSON-RPC on stdout: ${line}`);
      assert.ok("result" in msg || "error" in msg || "method" in msg);
    }
  });
});

describe("Task 1: static STDIO hygiene", () => {
  test("server source never writes to stdout directly", () => {
    const dir = join(import.meta.dirname, "..", "src", "task1-mcp-server");
    for (const file of readdirSync(dir)) {
      const code = readFileSync(join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(code, /console\.(log|info|debug|dir|table)\s*\(/, `${file} uses a stdout console method`);
      assert.doesNotMatch(code, /process\.stdout/, `${file} touches process.stdout`);
    }
  });

  test("redirectConsoleToStderr routes console.log away from stdout", async () => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "-e",
      `import { redirectConsoleToStderr } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "src", "shared", "logger.ts")).href)};
       redirectConsoleToStderr(); console.log("stray log"); console.info("stray info");`,
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    await new Promise((r) => child.on("close", r));
    assert.equal(out, "");
    assert.match(err, /stray log/);
  });
});
