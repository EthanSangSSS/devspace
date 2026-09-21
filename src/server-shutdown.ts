import type { Server } from "node:http";
import type { Socket } from "node:net";

export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
  closeAllConnections?(): void;
}

export const HTTP_SHUTDOWN_TIMEOUT_MS = 39_000;
const ownedConnections = new WeakMap<ClosableHttpServer, Set<Socket>>();

/** Install before accepting requests, so raw and upgraded sockets are covered. */
export function trackHttpConnections(server: Server): void {
  if (ownedConnections.has(server)) return;
  const sockets = new Set<Socket>();
  ownedConnections.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? HTTP_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("HTTP shutdown timeout must be positive");
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  // Attach rejection handlers to both operations immediately. Cleanup must
  // continue even when HTTP close fails synchronously.
  const completion = Promise.allSettled([httpClosed, Promise.resolve().then(closeApplication)]).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP/application shutdown deadline exceeded")), timeoutMs);
      }),
    ]);
  } catch (error) {
    // Only connections belonging to this server are destroyed. A deadline is
    // a failure, not proof that arbitrary application cleanup completed.
    for (const socket of ownedConnections.get(httpServer) ?? []) socket.destroy();
    httpServer.closeAllConnections?.();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
