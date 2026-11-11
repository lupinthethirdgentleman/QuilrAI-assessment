import "./helpers.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { luhnValid, redactText, safeBoundary, StreamingRedactor } from "../src/task3-llm-gateway/redactor.js";
import { DEFAULT_REPLY } from "../src/task3-llm-gateway/mock-llm.js";
import { SseParser } from "../src/task3-llm-gateway/sse.js";

/** Deterministic PRNG so property-test failures can be reproduced. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function streamThrough(text: string, sizes: () => number, maxHoldback?: number): { out: string; maxBuffered: number } {
  const r = new StreamingRedactor(undefined, maxHoldback);
  let out = "";
  let maxBuffered = 0;
  for (let i = 0; i < text.length; ) {
    const n = Math.max(1, sizes());
    out += r.push(text.slice(i, i + n));
    maxBuffered = Math.max(maxBuffered, r.buffered);
    i += n;
  }
  return { out: out + r.flush(), maxBuffered };
}

const CORPUS = [
  DEFAULT_REPLY,
  "Email me at a.b-c_d+tag@sub.domain.example.org, ok?",
  "SSNs: 123-45-6789, 078-05-1120; invalid: 000-12-3456 666-12-3456 900-12-3456 123-00-4567.",
  "Cards: 4111111111111111 / 4111-1111-1111-1111 / 4111 1111 1111 1111 / 378282246310005 / 6011 0009 9013 9424.",
  "Not a card: 4111111111111112 or order 1234567890123 or phone 555 123 4567.",
  "Edge: (jane@example.com) <bob@x.io> \"carol@y.co\". Then 4242 4242 4242 4242.",
  "Unicode ✅ café — 张伟 的邮箱是 zhang.wei@example.cn，SSN 219-09-9999。",
  "Run-on text4111111111111111text and mail@host.com.",
  "Prefixed x.4111 1111 1111 1111 y and a-4242 4242 4242 4242 z; item42 item43 4111 1111 1111 1111",
  "Counts 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 and years 2023 2024 2025 were fine; 5500 0000 0000 0004",
];

describe("Task 3: redaction patterns", () => {
  test("redacts emails, SSNs and Luhn-valid cards", () => {
    assert.equal(redactText("contact jane.doe@example.com now"), "contact [REDACTED] now");
    assert.equal(redactText("ssn 123-45-6789."), "ssn [REDACTED].");
    assert.equal(redactText("card 4111 1111 1111 1111!"), "card [REDACTED]!");
    assert.equal(redactText("card 5500-0000-0000-0004"), "card [REDACTED]");
  });

  test("leaves non-PII alone (invalid SSN ranges, numbers that fail Luhn)", () => {
    for (const s of ["000-12-3456", "666-12-3456", "123-00-4567", "4111111111111112", "order 1234567890123", "v1.2.3", "a@b"]) {
      assert.equal(redactText(s), s);
    }
    assert.equal(luhnValid("4111111111111111"), true);
    assert.equal(luhnValid("4111111111111112"), false);
  });

  test("safeBoundary holds back only the trailing partial token", () => {
    assert.equal(safeBoundary("hello wor"), 6);
    assert.equal(safeBoundary("mail jane.doe@exa"), 5);
    assert.equal(safeBoundary("card 4111 1111 "), 5); // a spaced card number may continue
    assert.equal(safeBoundary("done. "), 6);
    assert.equal(safeBoundary("year 2024 was"), 10); // digits followed by a word do not chain
    assert.equal(safeBoundary("item42 item43 ite"), 14);
  });
});

describe("Task 3: streaming equivalence (property test)", () => {
  test("for any chunking, streaming output === one-shot redaction", () => {
    let cases = 0;
    for (const text of CORPUS) {
      const expected = redactText(text);
      // Single characters, fixed sizes and 200 random chunkings per text.
      for (const size of [1, 2, 3, 5, 8, 13, 64, 10_000]) {
        assert.equal(streamThrough(text, () => size).out, expected, `size=${size} text=${text}`);
        cases++;
      }
      for (let seed = 1; seed <= 200; seed++) {
        const rand = rng(seed);
        assert.equal(streamThrough(text, () => 1 + Math.floor(rand() * 12)).out, expected, `seed=${seed} text=${text}`);
        cases++;
      }
    }
    assert.ok(cases > 1500);
  });

  test("raw PII never appears in any emitted fragment", () => {
    const rand = rng(7);
    const r = new StreamingRedactor();
    const emitted: string[] = [];
    for (let i = 0; i < DEFAULT_REPLY.length; ) {
      const n = 1 + Math.floor(rand() * 6);
      emitted.push(r.push(DEFAULT_REPLY.slice(i, i + n)));
      i += n;
    }
    emitted.push(r.flush());
    const joined = emitted.join("");
    for (const pii of ["jane.doe@example.com", "123-45-6789", "4111 1111 1111 1111", "5500-0000-0000-0004", "corp.example.co.uk"]) {
      assert.ok(!joined.includes(pii), `leaked ${pii}`);
    }
    assert.ok(joined.includes("1234567890123"), "non-Luhn order number should survive");
  });

  test("memory stays bounded: the holdback is about one word, and the cap holds on pathological input", () => {
    const words = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
    assert.ok(streamThrough(words, () => 3).maxBuffered <= 12);

    const noSpaces = "x".repeat(100_000);
    const { out, maxBuffered } = streamThrough(noSpaces, () => 97, 512);
    assert.ok(maxBuffered <= 512 + 97);
    assert.equal(out, noSpaces);
  });

  test("text is emitted incrementally (no waiting for the end of the stream)", () => {
    const r = new StreamingRedactor();
    assert.equal(r.push("Hello there, "), "Hello there, ");
    assert.equal(r.push("my email is jo"), "my email is ");
    assert.equal(r.push("e@example.com and"), "[REDACTED] ");
    assert.equal(r.flush(), "and");
  });
});

describe("Task 3: SSE parser", () => {
  test("handles events split anywhere and CRLF line endings", () => {
    const raw = 'data: {"a":1}\r\n\r\n: keep-alive\n\ndata: line1\ndata: line2\n\nevent: x\ndata: [DONE]\n\n';
    for (let size = 1; size <= raw.length; size++) {
      const p = new SseParser();
      const events = [];
      for (let i = 0; i < raw.length; i += size) events.push(...p.push(raw.slice(i, i + size)));
      events.push(...p.flush());
      assert.deepEqual(events.map((e) => e.data), ['{"a":1}', "line1\nline2", "[DONE]"], `size=${size}`);
    }
  });
});
