import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

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

async function startFixture(
  maxSessions: number,
  mcpInitializeCommitBarrier?: (sessionId: string) => Promise<void>,
): Promise<HttpFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-mcp-http-test-"));
  const project = join(root, "projects", "fixture");
  await mkdir(project, { recursive: true });
  const port = await getFreeLoopbackPort();
  const ownerToken = "test-owner-token-that-is-long-enough";
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: String(port),
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_STATE_DIR: join(root, "state"),
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_ALLOWED_ROOTS: join(root, "projects"),
    DEVSPACE_ALLOWED_HOSTS: "localhost,127.0.0.1",
    DEVSPACE_PUBLIC_BASE_URL: baseUrl,
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_SKILLS: "0",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_MCP_MAX_SESSIONS: String(maxSessions),
  });
  const running = createServer(config, { mcpInitializeCommitBarrier });
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
