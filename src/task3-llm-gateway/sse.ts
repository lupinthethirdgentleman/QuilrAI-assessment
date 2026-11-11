/**
 * Incremental Server-Sent Events parser (per the WHATWG spec, minus reconnection fields).
 * Feed it decoded text in any chunk sizes; it returns each event once it is complete.
 */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";

  push(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];
    for (;;) {
      // Events end with a blank line. Accept \n\n, \r\n\r\n and \r\r.
      const m = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!m) break;
      const block = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = parseBlock(block);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Returns any final event that was not followed by a blank line. */
  flush(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const ev = rest.trim() ? parseBlock(rest) : undefined;
    return ev ? [ev] : [];
  }
}

function parseBlock(block: string): SseEvent | undefined {
  const data: string[] = [];
  const ev: SseEvent = { data: "" };
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue; // a comment or keep-alive line
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") ev.event = value;
    else if (field === "id") ev.id = value;
  }
  if (data.length === 0) return undefined;
  ev.data = data.join("\n");
  return ev;
}

export function formatSse(data: string, event?: string): string {
  const lines = data.split("\n").map((l) => `data: ${l}`).join("\n");
  return (event ? `event: ${event}\n` : "") + lines + "\n\n";
}
