import type { IncomingMessage, ServerResponse } from "node:http";

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
  }
}

/** Reads a request body into a Buffer, aborting once it passes `limit` bytes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new BodyTooLargeError(limit);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString(),
    ...headers,
  });
  res.end(payload);
}

/** Resolves when the socket can take more data again, or rejects if the client disconnects first. */
export function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      res.off("close", onClose);
      resolve();
    };
    const onClose = () => {
      res.off("drain", onDrain);
      reject(new Error("client disconnected"));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

/** Writes a chunk and respects backpressure, so a slow client never makes us buffer without limit. */
export async function writeWithBackpressure(res: ServerResponse, chunk: string): Promise<void> {
  if (!res.write(chunk)) await waitForDrain(res);
}
