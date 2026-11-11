/**
 * PII redaction for text that arrives in arbitrary chunks.
 *
 * The hard part: a token stream splits text anywhere, e.g. "jane.d" | "oe@exam" | "ple.com".
 * Redacting each chunk on its own would miss these matches. Buffering the whole
 * response would wreck TTFT and memory use.
 *
 * Approach: a minimal holdback.
 *  - Every pattern we detect (email, SSN, card number) is built only from
 *    "token characters" [A-Za-z0-9._%+-@], plus single spaces between digits for
 *    card numbers like "4111 1111 1111 1111".
 *  - After each chunk we emit everything up to the start of the trailing run of
 *    characters that could still grow into a match, and hold back only that
 *    run. Typically this is the last partial word, so added latency is about one word.
 *  - Because a cut always lands right after a non-token character, no match can
 *    cross a cut, and \b anchors behave as they would on the full string. Streaming
 *    output is therefore identical to redacting the whole text at once
 *    (property-tested in test/task3.redactor.test.ts).
 *  - The holdback is capped (default 512 chars, more than the 254-char RFC email
 *    limit), so memory per stream stays O(1) whatever the response length.
 *
 * Cost: each chunk is scanned once, plus the small held-back tail, so the total
 * work is linear in the response size.
 */

export const REDACTION_TOKEN = "[REDACTED]";

export interface RedactionRule {
  name: string;
  /** Must carry the global flag. */
  pattern: RegExp;
  /** Optional second check that cuts false positives (e.g. Luhn for card numbers). */
  validate?: (match: string) => boolean;
}

/** Luhn checksum. It stops order IDs and long numbers from being redacted as card numbers. */
export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const DEFAULT_RULES: readonly RedactionRule[] = [
  {
    name: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  {
    // US SSN in dashed form, excluding ranges the SSA never issues (000, 666, 9xx, 00 group, 0000 serial).
    name: "ssn",
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    // 13-19 digits, optionally grouped by single spaces or dashes, confirmed with Luhn.
    name: "credit_card",
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: luhnValid,
  },
];

/** One-shot redaction of a complete string. */
export function redactText(text: string, rules: readonly RedactionRule[] = DEFAULT_RULES): string {
  let out = text;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (m) => (rule.validate && !rule.validate(m) ? m : REDACTION_TOKEN));
  }
  return out;
}

// --- character classes as char codes (faster than a regex per character) ---
const isDigit = (c: number) => c >= 48 && c <= 57;
const isTokenChar = (c: number) =>
  isDigit(c) ||
  (c >= 65 && c <= 90) || // A-Z
  (c >= 97 && c <= 122) || // a-z
  c === 46 || // .
  c === 95 || // _
  c === 37 || // %
  c === 43 || // +
  c === 45 || // -
  c === 64; // @
const SPACE = 32;

/**
 * Returns the index where text that could still become part of a match begins.
 * Everything before it is final and safe to redact and emit now.
 */
export function safeBoundary(s: string): number {
  const n = s.length;
  let k = n;
  // Trailing run of token characters (a partial email, SSN or card group, or just a word).
  while (k > 0 && isTokenChar(s.charCodeAt(k - 1))) k--;
  // A spaced card number ("4111 1111 ...") can continue across a single space,
  // but only when a digit sits on both sides, or the text ends right after the
  // space (the next group has not arrived yet). Ordinary prose such as
  // "word123 word124" therefore never chains.
  while (
    k > 1 &&
    s.charCodeAt(k - 1) === SPACE &&
    isDigit(s.charCodeAt(k - 2)) &&
    (k === n || isDigit(s.charCodeAt(k)))
  ) {
    k--;
    while (k > 0 && isTokenChar(s.charCodeAt(k - 1))) k--;
  }
  return k;
}

export class StreamingRedactor {
  private pending = "";

  constructor(
    private readonly rules: readonly RedactionRule[] = DEFAULT_RULES,
    private readonly maxHoldback = 512,
  ) {}

  /** Feeds one chunk and returns the redacted text that is now safe to send (it may be ""). */
  push(chunk: string): string {
    if (!chunk) return "";
    this.pending += chunk;
    let cut = safeBoundary(this.pending);
    // Memory bound: never hold back more than maxHoldback characters. Only a
    // pathological run (500+ chars without whitespace) reaches this.
    if (this.pending.length - cut > this.maxHoldback) cut = this.pending.length - this.maxHoldback;
    if (cut <= 0) return "";
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return redactText(ready, this.rules);
  }

  /** Call at the end of the stream to release the held-back tail. */
  flush(): string {
    const out = redactText(this.pending, this.rules);
    this.pending = "";
    return out;
  }

  /** Characters currently held back (useful for metrics and tests). */
  get buffered(): number {
    return this.pending.length;
  }
}
