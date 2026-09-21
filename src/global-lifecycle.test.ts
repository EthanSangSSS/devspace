import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import { shutdownHttpServer, trackHttpConnections } from "./server-shutdown.js";
import { McpSessionRegistry } from "./mcp-sessions.js";
import { localAgentDaemonPaths, assertLocalAgentEndpoint } from "./local-agent-daemon-lifecycle.js";
import { ProcessSessionManager } from "./process-sessions.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("HTTP shutdown expires explicitly instead of waiting forever for held connections", async () => {
  let closed: ((error?: Error) => void) | undefined;
  let forced = false;
  const pending = shutdownHttpServer({
    close(callback) { closed = callback; },
    closeAllConnections() { forced = true; closed?.(); },
  }, async () => {}, { timeoutMs: 20 }).then(() => "success", () => "deadline");
  try {
    const result = await Promise.race([pending, delay(150).then(() => "unbounded")]);
    assert.equal(result, "deadline");
    assert.equal(forced, true);
  } finally {
    closed?.();
    await pending;
  }
});

test("MCP hanging transport close is bounded and recorded as unproven", async () => {
  const registry = new McpSessionRegistry({ transportCloseTimeoutMs: 20 });
  registry.register("hung", { close: () => new Promise<void>(() => {}) });
  const result = await Promise.race([
    registry.closeAll(),
    delay(150).then(() => undefined),
  ]);
  assert.ok(result, "closeAll must not hang behind a faulty transport");
  assert.equal(result.length, 1);
  assert.ok(result[0]?.error);
  assert.equal(registry.snapshot().closeErrorTotal, 1);
  assert.equal(registry.snapshot().state, "closed");
});

test("daemon Unix socket limit is checked before any filesystem mutation", () => {
  assert.throws(() => localAgentDaemonPaths(`/tmp/${"a".repeat(120)}`, "darwin"), /socket.*bytes/i);
  assert.throws(() => localAgentDaemonPaths(`/tmp/${"a".repeat(120)}`, "linux"), /socket.*bytes/i);
  assert.match(localAgentDaemonPaths(`/tmp/${"a".repeat(120)}`, "win32").endpoint, /pipe/);
  assert.doesNotThrow(() => assertLocalAgentEndpoint("/" + "a".repeat(102), "darwin"));
  assert.throws(() => assertLocalAgentEndpoint("/" + "a".repeat(103), "darwin"));
  assert.throws(() => assertLocalAgentEndpoint("/" + "\u00e9".repeat(52), "darwin"));
});

for (const mode of ["partial", "upgrade"] as const) {
  test(`real ${mode} HTTP connection cannot survive the server shutdown deadline`, async () => {
    const server = createServer((_req, res) => res.end("ok"));
    server.on("upgrade", (_req, socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n"));
    trackHttpConnections(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const socket = createConnection(address.port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    const closed = once(socket, "close");
    try {
      if (mode === "upgrade") {
        socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
        await once(socket, "data");
      } else {
        socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n");
      }
      await assert.rejects(shutdownHttpServer(server, async () => {}, { timeoutMs: 30 }), /deadline/);
      await Promise.race([closed, delay(500).then(() => { throw new Error("owned HTTP socket survived shutdown"); })]);
      assert.equal(socket.destroyed, true);
    } finally {
      socket.destroy();
      server.closeAllConnections();
      server.close();
    }
  });
}

test("shutdown stops owned TERM-resistant children and rejects new process admissions", { skip: process.platform === "win32" }, async () => {
  const manager = new ProcessSessionManager();
  let childPid: number | undefined;
  try {
    let snapshot = await manager.start({
      workspaceId: "shutdown-test", cwd: process.cwd(),
      command: `exec '${process.execPath}' -e 'process.on("SIGTERM",()=>{}); console.log("ready:"+process.pid); setInterval(()=>{},1000)'`,
      yieldTimeMs: 100,
    });
    let output = snapshot.output;
    for (let attempt = 0; !output.includes("ready:") && attempt < 20; attempt += 1) {
      assert.ok(snapshot.sessionId);
      snapshot = await manager.write({ workspaceId: "shutdown-test", sessionId: snapshot.sessionId, yieldTimeMs: 100 });
      output += snapshot.output;
    }
    childPid = Number(/ready:(\d+)/.exec(output)?.[1]);
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    await manager.shutdown({ graceMs: 20, killWaitMs: 500 });
    assert.throws(() => process.kill(childPid!, 0));
    await assert.rejects(manager.start({ workspaceId: "shutdown-test", cwd: process.cwd(), command: "echo should-not-start" }), /shut|clos/i);
  } finally {
    if (childPid && Number.isSafeInteger(childPid)) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    await manager.shutdown();
  }
});
