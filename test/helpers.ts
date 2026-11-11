import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Starts a server on an ephemeral port and returns its base URL. */
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function close(...servers: Server[]): Promise<void> {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
}

/** Quiets service logs during tests unless LOG_LEVEL is set explicitly. */
process.env.LOG_LEVEL ??= "error";
