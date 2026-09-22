import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import type { McpSessionLifecycleEvent } from "./mcp-sessions.js";
import { createServer, type McpHttpLifecycleEvent } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

interface McpHttpResult {
  status: number;
  sessionId?: string;
  messages: Array<Record<string, unknown>>;
}

async function getFreeLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function bootstrapOAuth(baseUrl: string, ownerToken: string): Promise<string> {
  const redirectUri = "http://127.0.0.1:65534/oauth-callback";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const resource = `${baseUrl}/mcp`;

  const registrationResponse = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "devspace-reliability-test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registrationResponse.status, 201);
  const registration = (await registrationResponse.json()) as { client_id: string };

  const authorizationFields = {
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "devspace",
    resource,
  };
  const authorization = new URL(`${baseUrl}/authorize`);
  for (const [key, value] of Object.entries(authorizationFields)) {
    authorization.searchParams.set(key, value);
  }

  const authorizationResponse = await fetch(authorization, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...authorizationFields, owner_token: ownerToken }),
  });
  assert.equal(authorizationResponse.status, 302);
  const location = authorizationResponse.headers.get("location");
  assert.ok(location);
  const redirect = new URL(location);
  assert.equal(redirect.hostname, "127.0.0.1");
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = (await tokenResponse.json()) as { access_token: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

async function postMcp(
  baseUrl: string,
  accessToken: string,
  message: Record<string, unknown>,
  sessionId?: string,
): Promise<McpHttpResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId ?? undefined;
  const text = await response.text();
  if (!text.trim()) {
    return { status: response.status, sessionId: nextSessionId, messages: [] };
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(text) as
      | Record<string, unknown>
      | Array<Record<string, unknown>>;
    return {
      status: response.status,
      sessionId: nextSessionId,
      messages: Array.isArray(parsed) ? parsed : [parsed],
    };
  }
  if (contentType.includes("text/event-stream")) {
    const messages = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((data) => data && data !== "[DONE]")
      .map((data) => JSON.parse(data) as Record<string, unknown>);
    return { status: response.status, sessionId: nextSessionId, messages };
  }
  throw new Error(`Unexpected MCP content type: ${contentType}`);
}

function responseForId(result: McpHttpResult, id: number): Record<string, unknown> {
  const message = result.messages.find((candidate) => candidate.id === id);
  assert.ok(message, `Missing JSON-RPC response id=${id}`);
  return message;
}

let nextId = 1_000;
async function initializeSession(
  baseUrl: string,
  accessToken: string,
): Promise<string> {
  const id = nextId++;
  const result = await postMcp(baseUrl, accessToken, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "devspace-reliability-test", version: "1.0.0" },
    },
  });
  assert.equal(result.status, 200);
  assert.ok(result.sessionId);
  assert.equal("error" in responseForId(result, id), false);
  return result.sessionId;
}

async function notifyInitialized(
  baseUrl: string,
  accessToken: string,
  sessionId: string,
): Promise<void> {
  const result = await postMcp(
    baseUrl,
    accessToken,
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    sessionId,
  );
  assert.equal(result.status, 202);
}

async function listTools(
  baseUrl: string,
  accessToken: string,
  sessionId: string,
): Promise<McpHttpResult> {
  const id = nextId++;
  const result = await postMcp(
    baseUrl,
    accessToken,
    { jsonrpc: "2.0", id, method: "tools/list", params: {} },
    sessionId,
  );
  if (result.status === 200) {
    assert.equal(result.sessionId, sessionId);
    assert.equal("error" in responseForId(result, id), false);
  }
  return result;
}

async function deleteMcpSession(
  baseUrl: string,
  accessToken: string,
  sessionId: string,
): Promise<number> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
  });
  await response.text();
  return response.status;
}

async function initializeExpectCapacityRejection(
  baseUrl: string,
  accessToken: string,
): Promise<{ httpStatus: number; jsonRpcCode: number }> {
  const id = nextId++;
  const result = await postMcp(baseUrl, accessToken, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "devspace-reliability-test", version: "1.0.0" },
    },
  });
  assert.equal(result.messages.length, 1);
  const message = result.messages[0]!;
  assert.equal(message.id, null);
  const error = message.error as { code?: unknown } | undefined;
  const errorCode = error?.code;
  assert.equal(typeof errorCode, "number");
  return { httpStatus: result.status, jsonRpcCode: errorCode as number };
}

function workspaceIdFromToolResponse(message: Record<string, unknown>): string {
  const result = message.result as
    | { structuredContent?: { workspaceId?: unknown } }
    | undefined;
  const workspaceId = result?.structuredContent?.workspaceId;
  if (typeof workspaceId !== "string") {
    assert.fail("open_workspace did not return a string workspaceId");
  }
  return workspaceId;
}

async function initializeReadySession(
  baseUrl: string,
  accessToken: string,
  project: string,
): Promise<{ sessionId: string; workspaceId: string }> {
  const sessionId = await initializeSession(baseUrl, accessToken);
  await notifyInitialized(baseUrl, accessToken, sessionId);
  const id = nextId++;
  const opened = await postMcp(
    baseUrl,
    accessToken,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "open_workspace", arguments: { path: project } },
    },
    sessionId,
  );
  assert.equal(opened.status, 200);
  assert.equal(opened.sessionId, sessionId);
  return {
    sessionId,
    workspaceId: workspaceIdFromToolResponse(responseForId(opened, id)),
  };
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for test signal: ${path}`);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for test condition");
}

async function rawHttpStatus(
  baseUrl: string,
  requestLines: readonly string[],
): Promise<number> {
  const url = new URL(baseUrl);
  const port = Number(url.port);
  return await new Promise<number>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw HTTP request timed out"));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.end(requestLines.join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      const statusLine = response.split("\r\n", 1)[0] ?? "";
      const match = /^HTTP\/1\.1 (\d{3})\b/.exec(statusLine);
      if (!match) {
        reject(new Error(`Missing HTTP status line: ${statusLine}`));
        return;
      }
      resolve(Number(match[1]));
    });
  });
}

function activeExecArgs(
  workspaceId: string,
  readyPath: string,
  releasePath: string,
) {
  const script = [
    "const fs=require('node:fs');",
    "const ready=process.argv[1];",
    "const release=process.argv[2];",
    "fs.writeFileSync(ready,'ready');",
    "const timer=setInterval(()=>{",
    "if(fs.existsSync(release)){clearInterval(timer);process.exit(0);}",
    "},10);",
  ].join("");
  return {
    workspaceId,
    cmd: [
      JSON.stringify(process.execPath),
      "-e",
      JSON.stringify(script),
      JSON.stringify(readyPath),
      JSON.stringify(releasePath),
    ].join(" "),
    yieldTimeMs: 30_000,
  };
}

interface HttpFixture {
  root: string;
  project: string;
  baseUrl: string;
  ownerToken: string;
  accessToken: string;
  close(): Promise<void>;
}

interface HttpFixtureOptions {
  idleTimeoutMs?: number;
  cleanupIntervalMs?: number;
  httpLifecycleObserver?: (event: McpHttpLifecycleEvent) => void;
  sessionLifecycleObserver?: (event: McpSessionLifecycleEvent) => void;
  deleteHandleBarrier?: (sessionId: string, requestId: string) => Promise<void>;
}

async function startFixture(
  maxSessions: number,
  mcpInitializeCommitBarrier?: (sessionId: string) => Promise<void>,
  options: HttpFixtureOptions = {},
): Promise<HttpFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-mcp-http-test-"));
  const project = join(root, "projects", "fixture");
  await mkdir(project, { recursive: true });
  const port = await getFreeLoopbackPort();
  const ownerToken = "test-owner-token-that-is-long-enough";
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: {
      host: "127.0.0.1",
      port,
      publicBaseUrl: baseUrl,
      allowedHosts: ["localhost", "127.0.0.1"],
    },
    workspaces: {
      allowedRoots: [join(root, "projects")],
      worktreeRoot: join(root, "worktrees"),
    },
    storage: { stateDir: join(root, "state") },
    tools: { mode: "codex" },
    ui: { enabled: false },
    skills: { enabled: false, agentDir: join(root, "agent") },
    subagents: { enabled: false, providers: [] },
  }));
  const running = createServer(config, {
    mcpInitializeCommitBarrier,
    mcpDeleteHandleBarrier: options.deleteHandleBarrier,
    mcpMaxSessions: maxSessions,
    mcpSessionIdleTimeoutMs: options.idleTimeoutMs,
    mcpSessionCleanupIntervalMs: options.cleanupIntervalMs,
    runtimeSnapshotIntervalMs: 1_000,
    httpLifecycleObserver: options.httpLifecycleObserver,
    mcpSessionLifecycleObserver: options.sessionLifecycleObserver,
  });
  const httpServer = running.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const accessToken = await bootstrapOAuth(baseUrl, ownerToken);
  let closed = false;
  return {
    root,
    project,
    baseUrl,
    ownerToken,
    accessToken,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      await running.close();
    },
  };
}

test("idle session is evicted when a new initialize reaches maxSessions", async (t) => {
  const fixture = await startFixture(1);
  t.after(() => fixture.close());
  const sessionA = await initializeSession(fixture.baseUrl, fixture.accessToken);
  await notifyInitialized(fixture.baseUrl, fixture.accessToken, sessionA);
  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, sessionA)).status,
    200,
  );

  const sessionB = await initializeSession(fixture.baseUrl, fixture.accessToken);
  await notifyInitialized(fixture.baseUrl, fixture.accessToken, sessionB);
  assert.notEqual(sessionB, sessionA);
  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, sessionA)).status,
    404,
  );
  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, sessionB)).status,
    200,
  );
});

test("initializing session stays protected until initialize handleRequest completes", async (t) => {
  let releaseInitialize: (() => void) | undefined;
  let markCommitReached: ((sessionId: string) => void) | undefined;
  const commitReached = new Promise<string>((resolve) => {
    markCommitReached = resolve;
  });
  let barrierUsed = false;
  const fixture = await startFixture(1, async (sessionId) => {
    if (barrierUsed) return;
    barrierUsed = true;
    markCommitReached?.(sessionId);
    await new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
  });
  t.after(async () => {
    releaseInitialize?.();
    await fixture.close();
  });

  let initializeASettled = false;
  const initializeA = initializeSession(fixture.baseUrl, fixture.accessToken).finally(
    () => {
      initializeASettled = true;
    },
  );
  const committedA = await Promise.race([
    commitReached,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("initialize commit barrier timeout")), 2_000),
    ),
  ]);
  assert.equal(initializeASettled, false);

  const rejectedB = await initializeExpectCapacityRejection(
    fixture.baseUrl,
    fixture.accessToken,
  );
  assert.equal(rejectedB.httpStatus, 503);
  assert.equal(rejectedB.jsonRpcCode, -32001);
  assert.equal(initializeASettled, false);

  releaseInitialize?.();
  const sessionA = await initializeA;
  assert.equal(sessionA, committedA);
  const sessionC = await initializeSession(fixture.baseUrl, fixture.accessToken);
  assert.notEqual(sessionC, sessionA);
  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, sessionA)).status,
    404,
  );
});

test("active sessions are never evicted and all-active capacity rejects deterministically", {
  timeout: 5_000,
}, async (t) => {
  const fixture = await startFixture(2);
  const releasePaths: string[] = [];
  t.after(async () => {
    await Promise.all(
      releasePaths.map((path) => writeFile(path, "release").catch(() => {})),
    );
    await fixture.close();
  });

  const a = await initializeReadySession(
    fixture.baseUrl,
    fixture.accessToken,
    fixture.project,
  );
  const b = await initializeReadySession(
    fixture.baseUrl,
    fixture.accessToken,
    fixture.project,
  );

  const readyA = join(fixture.root, "active-a.ready");
  const releaseA = join(fixture.root, "active-a.release");
  releasePaths.push(releaseA);
  let activeASettled = false;
  const activeAId = nextId++;
  const activeA = postMcp(
    fixture.baseUrl,
    fixture.accessToken,
    {
      jsonrpc: "2.0",
      id: activeAId,
      method: "tools/call",
      params: {
        name: "exec_command",
        arguments: activeExecArgs(a.workspaceId, readyA, releaseA),
      },
    },
    a.sessionId,
  ).finally(() => {
    activeASettled = true;
  });

  await waitForFile(readyA, 2_000);
  assert.equal(activeASettled, false);
  const c = await initializeReadySession(
    fixture.baseUrl,
    fixture.accessToken,
    fixture.project,
  );
  assert.equal(activeASettled, false);
  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, b.sessionId)).status,
    404,
  );
  await writeFile(releaseA, "release");
  const activeAResult = await activeA;
  assert.equal(activeAResult.status, 200);
  assert.equal("error" in responseForId(activeAResult, activeAId), false);

  const readyA2 = join(fixture.root, "active-a2.ready");
  const releaseA2 = join(fixture.root, "active-a2.release");
  const readyC = join(fixture.root, "active-c.ready");
  const releaseC = join(fixture.root, "active-c.release");
  releasePaths.push(releaseA2, releaseC);
  let activeA2Settled = false;
  let activeCSettled = false;
  const activeA2Id = nextId++;
  const activeCId = nextId++;
  const activeA2 = postMcp(
    fixture.baseUrl,
    fixture.accessToken,
    {
      jsonrpc: "2.0",
      id: activeA2Id,
      method: "tools/call",
      params: {
        name: "exec_command",
        arguments: activeExecArgs(a.workspaceId, readyA2, releaseA2),
      },
    },
    a.sessionId,
  ).finally(() => {
    activeA2Settled = true;
  });
  const activeC = postMcp(
    fixture.baseUrl,
    fixture.accessToken,
    {
      jsonrpc: "2.0",
      id: activeCId,
      method: "tools/call",
      params: {
        name: "exec_command",
        arguments: activeExecArgs(c.workspaceId, readyC, releaseC),
      },
    },
    c.sessionId,
  ).finally(() => {
    activeCSettled = true;
  });

  await Promise.all([waitForFile(readyA2, 2_000), waitForFile(readyC, 2_000)]);
  assert.equal(activeA2Settled, false);
  assert.equal(activeCSettled, false);
  const rejectedD = await initializeExpectCapacityRejection(
    fixture.baseUrl,
    fixture.accessToken,
  );
  assert.equal(rejectedD.httpStatus, 503);
  assert.equal(rejectedD.jsonRpcCode, -32001);
  assert.equal(activeA2Settled, false);
  assert.equal(activeCSettled, false);

  await Promise.all([
    writeFile(releaseA2, "release"),
    writeFile(releaseC, "release"),
  ]);
  const [activeA2Result, activeCResult] = await Promise.all([activeA2, activeC]);
  assert.equal(activeA2Result.status, 200);
  assert.equal(activeCResult.status, 200);
  assert.equal("error" in responseForId(activeA2Result, activeA2Id), false);
  assert.equal("error" in responseForId(activeCResult, activeCId), false);
  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, a.sessionId)).status,
    200,
  );
  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, c.sessionId)).status,
    200,
  );
});

test("idle expiry rejects the old session and a fresh initialize remains usable", async (t) => {
  const sessionEvents: McpSessionLifecycleEvent[] = [];
  const fixture = await startFixture(4, undefined, {
    idleTimeoutMs: 40,
    cleanupIntervalMs: 10,
    sessionLifecycleObserver: (event) => sessionEvents.push(event),
  });
  t.after(() => fixture.close());

  const expiredSession = await initializeSession(
    fixture.baseUrl,
    fixture.accessToken,
  );
  await notifyInitialized(fixture.baseUrl, fixture.accessToken, expiredSession);
  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, expiredSession)).status,
    200,
  );

  await waitForCondition(
    () => sessionEvents.some(
      (event) => event.type === "closed"
        && event.sessionId === expiredSession
        && event.reason === "idle_timeout",
    ),
    2_000,
  );

  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, expiredSession)).status,
    404,
  );
  const freshSession = await initializeSession(
    fixture.baseUrl,
    fixture.accessToken,
  );
  assert.notEqual(freshSession, expiredSession);
  await notifyInitialized(fixture.baseUrl, fixture.accessToken, freshSession);
  assert.equal(
    (await listTools(fixture.baseUrl, fixture.accessToken, freshSession)).status,
    200,
  );

  const timeoutClosed = sessionEvents.find(
    (event) => event.type === "closed"
      && event.sessionId === expiredSession
      && event.reason === "idle_timeout",
  );
  assert.ok(timeoutClosed);
  assert.equal(timeoutClosed.closeInitiator, "server_policy");
  assert.equal(timeoutClosed.activeRequests, 0);
  assert.ok((timeoutClosed.idleForMs ?? 0) >= 40);
  assert.equal(timeoutClosed.snapshot.idleTimeoutDetachedTotal, 1);
});

test("stale-session miss details are rate-limited while exact miss accounting is preserved", async (t) => {
  const sessionEvents: McpSessionLifecycleEvent[] = [];
  const fixture = await startFixture(1, undefined, {
    sessionLifecycleObserver: (event) => sessionEvents.push(event),
  });
  t.after(() => fixture.close());

  const staleSession = await initializeSession(fixture.baseUrl, fixture.accessToken);
  await notifyInitialized(fixture.baseUrl, fixture.accessToken, staleSession);
  const replacementSession = await initializeSession(
    fixture.baseUrl,
    fixture.accessToken,
  );
  await notifyInitialized(fixture.baseUrl, fixture.accessToken, replacementSession);

  const originalWarn = console.warn;
  const warningLines: string[] = [];
  console.warn = (...args: unknown[]) => {
    warningLines.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  for (let index = 0; index < 20; index += 1) {
    assert.equal(
      (await listTools(fixture.baseUrl, fixture.accessToken, staleSession)).status,
      404,
    );
  }

  const missEvents = sessionEvents.filter((event) => event.type === "miss");
  assert.equal(missEvents.length, 20);
  assert.equal(missEvents.at(-1)?.snapshot.unknownSessionTotal, 20);

  const missLogs = warningLines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry?.event === "mcp_session_miss");
  assert.equal(missLogs.length, 8);
  assert.equal("sessionIdPrefix" in (missLogs[0] ?? {}), false);
  assert.equal(typeof missLogs[0]?.sessionCorrelation, "string");
  assert.notEqual(
    missLogs[0]?.sessionCorrelation,
    staleSession.slice(0, 16),
  );
});

test("pre-parser observer records a request whose JSON body is aborted mid-upload", async (t) => {
  const httpEvents: McpHttpLifecycleEvent[] = [];
  const fixture = await startFixture(4, undefined, {
    httpLifecycleObserver: (event) => httpEvents.push(event),
  });
  t.after(() => fixture.close());
  const url = new URL(fixture.baseUrl);
  const port = Number(url.port);

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("partial-body socket test timed out"));
    }, 2_000);
    socket.once("connect", () => {
      socket.write([
        "POST /mcp HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Content-Type: application/json",
        "Content-Length: 512",
        "Connection: close",
        "",
        '{"jsonrpc":"2.0","id":1',
      ].join("\r\n"));
      setTimeout(() => socket.destroy(), 20);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  await waitForCondition(
    () => httpEvents.some((event) => event.type === "request_aborted"),
    2_000,
  );
  const started = httpEvents.find((event) => event.type === "request_start");
  const aborted = httpEvents.find((event) => event.type === "request_aborted");
  assert.ok(started);
  assert.ok(aborted);
  assert.equal(aborted.requestId, started.requestId);
  assert.equal(started.path, "/mcp");
  assert.equal(started.method, "POST");
});

test("parser and Host early rejections emit structured terminal attribution", async (t) => {
  const httpEvents: McpHttpLifecycleEvent[] = [];
  const fixture = await startFixture(4, undefined, {
    httpLifecycleObserver: (event) => httpEvents.push(event),
  });
  t.after(() => fixture.close());
  const url = new URL(fixture.baseUrl);
  const port = Number(url.port);

  const malformedBody = "{bad";
  assert.equal(
    await rawHttpStatus(fixture.baseUrl, [
      "POST /mcp HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(malformedBody)}`,
      "Connection: close",
      "",
      malformedBody,
    ]),
    400,
  );

  const parserStart = httpEvents.find(
    (event) => event.type === "request_start" && event.method === "POST",
  );
  const parserFinished = httpEvents.find(
    (event) => event.type === "early_response_finished"
      && event.statusCode === 400,
  );
  assert.ok(parserStart);
  assert.ok(parserFinished);
  assert.equal(parserFinished.requestId, parserStart.requestId);
  assert.equal(parserFinished.responsePhase, "headers_sent");

  const validBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "host-parity-test", version: "1.0.0" },
    },
  });
  assert.equal(
    await rawHttpStatus(fixture.baseUrl, [
      "POST /mcp HTTP/1.1",
      "Host: attacker.invalid",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(validBody)}`,
      "Connection: close",
      "",
      validBody,
    ]),
    403,
  );

  const hostFinished = httpEvents.find(
    (event) => event.type === "early_response_finished"
      && event.statusCode === 403,
  );
  assert.ok(hostFinished);
  const hostStart = httpEvents.find(
    (event) => event.type === "request_start"
      && event.requestId === hostFinished.requestId,
  );
  assert.ok(hostStart);
  assert.equal(hostStart.requestId, hostFinished.requestId);
  assert.equal(hostStart.method, "POST");
  assert.equal(hostStart.path, "/mcp");
  assert.equal(hostFinished.method, "POST");
  assert.equal(hostFinished.path, "/mcp");
  assert.notEqual(hostFinished.requestId, parserFinished.requestId);
});

test("explicit DELETE is distinguished from an unknown SDK transport close", async (t) => {
  const sessionEvents: McpSessionLifecycleEvent[] = [];
  const fixture = await startFixture(4, undefined, {
    sessionLifecycleObserver: (event) => sessionEvents.push(event),
  });
  t.after(() => fixture.close());

  const sessionId = await initializeSession(fixture.baseUrl, fixture.accessToken);
  await notifyInitialized(fixture.baseUrl, fixture.accessToken, sessionId);
  assert.equal(
    await deleteMcpSession(fixture.baseUrl, fixture.accessToken, sessionId),
    200,
  );

  await waitForCondition(
    () => sessionEvents.some(
      (event) => event.type === "closed"
        && event.sessionId === sessionId
        && event.reason === "transport_close",
    ),
    2_000,
  );
  const closed = sessionEvents.find(
    (event) => event.type === "closed"
      && event.sessionId === sessionId
      && event.reason === "transport_close",
  );
  assert.ok(closed);
  assert.equal(closed.closeInitiator, "explicit_delete");
  assert.equal(typeof closed.requestId, "string");
  assert.equal(typeof closed.sessionAgeMs, "number");
  assert.equal(closed.idleForMs, undefined);
  assert.equal(closed.activeRequests, 1);
});

test("overlapping DELETEs never attach an ambiguous requestId to the close event", {
  timeout: 5_000,
}, async (t) => {
  const sessionEvents: McpSessionLifecycleEvent[] = [];
  const entered: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  let bothEnteredResolve: (() => void) | undefined;
  const bothEntered = new Promise<void>((resolve) => {
    bothEnteredResolve = resolve;
  });
  const fixture = await startFixture(4, undefined, {
    sessionLifecycleObserver: (event) => sessionEvents.push(event),
    deleteHandleBarrier: async (_sessionId, requestId) => {
      entered.push(requestId);
      if (entered.length === 2) bothEnteredResolve?.();
      await new Promise<void>((resolve) => {
        if (entered.length === 1) releaseFirst = resolve;
        else releaseSecond = resolve;
      });
    },
  });
  t.after(async () => {
    releaseFirst?.();
    releaseSecond?.();
    await fixture.close();
  });

  const sessionId = await initializeSession(fixture.baseUrl, fixture.accessToken);
  await notifyInitialized(fixture.baseUrl, fixture.accessToken, sessionId);

  const deleteA = deleteMcpSession(
    fixture.baseUrl,
    fixture.accessToken,
    sessionId,
  );
  const deleteB = deleteMcpSession(
    fixture.baseUrl,
    fixture.accessToken,
    sessionId,
  );
  await Promise.race([
    bothEntered,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("overlapping DELETE barrier timeout")), 2_000),
    ),
  ]);
  assert.equal(entered.length, 2);

  releaseFirst?.();
  await waitForCondition(
    () => sessionEvents.some(
      (event) => event.type === "closed"
        && event.sessionId === sessionId
        && event.reason === "transport_close",
    ),
    2_000,
  );

  const closed = sessionEvents.find(
    (event) => event.type === "closed"
      && event.sessionId === sessionId
      && event.reason === "transport_close",
  );
  assert.ok(closed);
  assert.equal(closed.closeInitiator, "explicit_delete");
  assert.equal(closed.requestId, undefined);
  assert.equal(closed.activeRequests, 2);

  releaseSecond?.();
  const statuses = await Promise.all([deleteA, deleteB]);
  assert.ok(statuses.every((status) => status >= 200 && status < 500));
});

test("invalid tool input is rejected before any tool operation starts", async (t) => {
  const logs = captureDiagnosticLogs(t);
  const fixture = await startFixture(4);
  t.after(() => fixture.close());
  const ready = await initializeReadySession(fixture.baseUrl, fixture.accessToken, fixture.project);
  logs.lines.length = 0;
  const id = nextId++;
  const response = responseForId(await postMcp(fixture.baseUrl, fixture.accessToken, {
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "exec_command", arguments: { workspaceId: ready.workspaceId, cmd: 123 } },
  }, ready.sessionId), id);
  assert.ok("error" in response || (response.result as { isError?: boolean } | undefined)?.isError);
  const events = logs.events();
  assert.equal(events.filter((event) => event.event === "mcp_http_request_start").length, 1);
  assert.equal(events.filter((event) => event.event === "http_request").length, 1);
  assert.equal(events.some((event) => event.event === "mcp_tool_started" || event.event === "mcp_tool_finished"), false);
});

function captureDiagnosticLogs(t: { after: (fn: () => void) => void }): {
  lines: string[];
  events: () => Array<Record<string, unknown>>;
} {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  t.after(() => Object.assign(console, original));
  return {
    lines,
    events: () => lines.flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    }),
  };
}

test("real SDK HTTP dispatch correlates concurrent calls without session or RPC-id bleed", {
  timeout: 15_000,
}, async (t) => {
  const logs = captureDiagnosticLogs(t);
  const fixture = await startFixture(4);
  t.after(() => fixture.close());
  const first = await initializeReadySession(fixture.baseUrl, fixture.accessToken, fixture.project);
  const second = await initializeReadySession(fixture.baseUrl, fixture.accessToken, fixture.project);
  const execute = (sessionId: string, id: number) => postMcp(fixture.baseUrl, fixture.accessToken, {
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "exec_command", arguments: {
      workspaceId: first.workspaceId,
      cmd: `"${process.execPath}" -e "setTimeout(()=>process.exit(0),250)"`,
      yieldTimeMs: 1_000,
    } },
  }, sessionId);
  for (const targets of [
    [[first.sessionId, 81], [first.sessionId, 82]],
    [[first.sessionId, 83], [second.sessionId, 83]],
  ] as const) {
    logs.lines.length = 0;
    await Promise.all(targets.map(async ([session, id]) => {
      const response = responseForId(await execute(session, id), id);
      assert.equal("error" in response, false);
    }));
    const events = logs.events();
    const starts = events.filter((event) => event.event === "mcp_tool_started");
    const finishes = events.filter((event) => event.event === "mcp_tool_finished");
    assert.equal(starts.length, 2);
    assert.equal(finishes.length, 2);
    assert.notEqual(starts[0]!.requestId, starts[1]!.requestId);
    assert.notEqual(starts[0]!.toolCallId, starts[1]!.toolCallId);
    assert.equal(starts[0]!.runtimeGeneration, starts[1]!.runtimeGeneration);
    if (targets[0][0] === targets[1][0]) {
      assert.equal(starts[0]!.sessionCorrelation, starts[1]!.sessionCorrelation);
    } else {
      assert.notEqual(starts[0]!.sessionCorrelation, starts[1]!.sessionCorrelation);
    }
    assert.ok(events.indexOf(starts[1]!) < events.indexOf(finishes[0]!), "calls really overlap");
    for (const start of starts) {
      assert.equal(typeof start.requestId, "string");
      assert.equal(typeof start.sessionCorrelation, "string");
      const finish = finishes.find((event) => event.toolCallId === start.toolCallId)!;
      assert.equal(finish.requestId, start.requestId);
      assert.equal(finish.sessionCorrelation, start.sessionCorrelation);
      assert.equal(finish.outcome, "process_exit_zero");
      const arrival = events.find((event) => event.event === "mcp_http_request_start" && event.requestId === start.requestId)!;
      const response = events.find((event) => event.event === "http_request" && event.requestId === start.requestId)!;
      assert.ok(arrival && response);
      assert.equal(arrival.runtimeGeneration, start.runtimeGeneration);
      assert.equal(response.sessionCorrelation, start.sessionCorrelation);
      assert.equal(response.status, 200);
      assert.equal(events.filter((event) => event.event === "mcp_http_early_response_finished" && event.requestId === start.requestId).length, 0);
    }
    assert.equal(events.some((event) => event.event === "tool_call"), false);
  }
});

test("MCP route variants and errors emit only whitelisted diagnostic fields", {
  timeout: 15_000,
}, async (t) => {
  const logs = captureDiagnosticLogs(t);
  const fixture = await startFixture(4);
  t.after(() => fixture.close());
  const ready = await initializeReadySession(fixture.baseUrl, fixture.accessToken, fixture.project);
  logs.lines.length = 0;
  const secret = "SYNTHETIC_SECRET_CANARY";
  for (const route of ["/mcp", "/mcp/", "/MCP"]) {
    const headers = {
      Authorization: `Bearer ${fixture.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": ready.sessionId,
      Referer: `https://example.invalid/${secret}`,
      "User-Agent": secret,
    };
    const response = await fetch(`${fixture.baseUrl}${route}?ignored=${secret}`, {
      method: "POST", headers, signal: AbortSignal.timeout(3_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call",
        params: { name: "read", arguments: { workspaceId: ready.workspaceId, path: secret } } }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const malformed = await fetch(`${fixture.baseUrl}${route}`, {
      method: "POST", headers, body: `{${secret}`, signal: AbortSignal.timeout(3_000),
    });
    assert.equal(malformed.status, 400);
    await malformed.text();
  }
  const events = logs.events();
  const arrivals = events.filter((event) => event.event === "mcp_http_request_start");
  assert.equal(arrivals.length, 6);
  const finishes = events.filter((event) => event.event === "mcp_tool_finished");
  assert.equal(finishes.length, 3);
  assert.ok(finishes.every((event) => event.outcome === "threw" || event.outcome === "tool_error"));
  assert.equal(events.filter((event) => event.event === "mcp_http_early_response_finished").length, 3);
  const allowed = new Set(["ts", "level", "event", "runtimeGeneration", "requestId", "sessionCorrelation",
    "type", "method", "path", "status", "durationMs", "headersSent", "statusCode", "responsePhase",
    "tool", "toolCallId", "outcome", "errorClass"]);
  for (const event of events) assert.ok(Object.keys(event).every((key) => allowed.has(key)), String(event.event));
  const output = logs.lines.join("\n");
  for (const forbidden of [secret, fixture.accessToken, ready.sessionId, fixture.project]) {
    assert.equal(output.includes(forbidden), false);
  }
});

test("disconnect after dispatch does not erase the eventual tool terminal", {
  timeout: 10_000,
}, async (t) => {
  const logs = captureDiagnosticLogs(t);
  const fixture = await startFixture(4);
  t.after(() => fixture.close());
  const ready = await initializeReadySession(fixture.baseUrl, fixture.accessToken, fixture.project);
  logs.lines.length = 0;
  const controller = new AbortController();
  const request = fetch(`${fixture.baseUrl}/mcp`, {
    method: "POST", signal: controller.signal,
    headers: { Authorization: `Bearer ${fixture.accessToken}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "mcp-session-id": ready.sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: {
      name: "exec_command", arguments: { workspaceId: ready.workspaceId,
        cmd: `"${process.execPath}" -e "setTimeout(()=>process.exit(0),250)"`, yieldTimeMs: 1_000 },
    } }),
  }).then((response) => response.text()).catch(() => undefined);
  t.after(() => controller.abort());
  await waitForCondition(() => logs.events().some((event) => event.event === "mcp_tool_started"), 2_000);
  controller.abort();
  await request;
  await waitForCondition(() => logs.events().some((event) => event.event === "mcp_tool_finished"), 3_000);
  const events = logs.events();
  const start = events.find((event) => event.event === "mcp_tool_started")!;
  const finish = events.filter((event) => event.event === "mcp_tool_finished");
  assert.equal(finish.length, 1);
  assert.equal(finish[0]!.requestId, start.requestId);
  assert.equal(finish[0]!.toolCallId, start.toolCallId);
  assert.equal(finish[0]!.outcome, "process_exit_zero");
  const closed = events.find((event) => event.event === "mcp_http_response_closed_before_finish");
  assert.ok(closed);
  assert.equal(closed.requestId, start.requestId);
  if (closed.headersSent === false) assert.equal(closed.statusCode, undefined);
});
