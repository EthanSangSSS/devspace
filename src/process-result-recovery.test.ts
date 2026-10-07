import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { registerCodexTools } from "./tool-surfaces/codex.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";

const logging = {
  level: "silent", format: "json", requests: false, assets: false,
  toolCalls: false, shellCommands: false, trustProxy: false,
} as const;

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

async function fixture(t: TestContext) {
  const processSessions = new ProcessSessionManager();
  const server = new McpServer({ name: "process-result-recovery-test", version: "1" });
  registerCodexTools({
    server,
    processSessions,
    config: { logging } as ToolRegistrationContext["config"],
    workspaces: {
      getWorkspace: () => ({ canonicalRoot: process.cwd() }),
      resolveWorkingDirectory: () => process.cwd(),
    } as unknown as ToolRegistrationContext["workspaces"],
  });
  const client = new Client({ name: "process-result-recovery-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await processSessions.shutdown();
  });
  return { client, processSessions };
}

test("cancelled pure MCP poll preserves buffered output and the process handle", async (t) => {
  const { client, processSessions } = await fixture(t);
  const marker = `cancel-recovery-${randomUUID()}`;
  const started = await processSessions.start({
    workspaceId: "owner",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('early-${marker}'), 20); setTimeout(() => console.log('done-${marker}'), 1_200)"`,
    yieldTimeMs: 0,
  });
  assert.ok(started.sessionId);

  let timeoutError: unknown;
  try {
    await client.callTool({
      name: "write_stdin",
      arguments: { workspaceId: "owner", sessionId: started.sessionId, yieldTimeMs: 400 },
    }, undefined, { timeout: 100 });
  } catch (error) {
    timeoutError = error;
  }
  assert.equal((timeoutError as { name?: string })?.name, "McpError");
  assert.equal((timeoutError as { code?: number })?.code, -32001);

  // Wait beyond the abandoned poll's original 400 ms deadline while the
  // child is still running. If MCP cancellation is not propagated, that old
  // waiter will wake and destructively drain the buffered "early" output.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const runningRecovery = await processSessions.write({
    workspaceId: "owner",
    sessionId: started.sessionId,
    yieldTimeMs: 0,
  });
  assert.equal(runningRecovery.running, true);
  assert.match(runningRecovery.output, new RegExp(`early-${marker}`));

  const terminalRecovery = await processSessions.write({
    workspaceId: "owner",
    sessionId: started.sessionId,
    yieldTimeMs: 2_000,
  });
  assert.equal(terminalRecovery.running, false);
  assert.equal(terminalRecovery.exitCode, 0);
  assert.match(terminalRecovery.output, new RegExp(`done-${marker}`));
});

test("already-aborted pure poll does not consume a completed session", async (t) => {
  const manager = new ProcessSessionManager();
  t.after(async () => manager.shutdown());
  const marker = `aborted-terminal-${randomUUID()}`;
  const started = await manager.start({
    workspaceId: "owner",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('${marker}'), 50)"`,
    yieldTimeMs: 0,
  });
  assert.ok(started.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    manager.write(
      { workspaceId: "owner", sessionId: started.sessionId, yieldTimeMs: 0 },
      { signal: controller.signal },
    ),
    (error: unknown) => (error as { name?: string })?.name === "AbortError",
  );

  const recovered = await manager.write({
    workspaceId: "owner",
    sessionId: started.sessionId,
    yieldTimeMs: 0,
  });
  assert.equal(recovered.running, false);
  assert.equal(recovered.exitCode, 0);
  assert.match(recovered.output, new RegExp(marker));
});

test("completed write_stdin result is replayable only by the owning workspace", async (t) => {
  const { client, processSessions } = await fixture(t);
  const marker = `terminal-replay-${randomUUID()}`;
  const started = await processSessions.start({
    workspaceId: "owner",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('${marker}'), 80)"`,
    yieldTimeMs: 0,
  });
  assert.ok(started.sessionId);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await client.callTool({
      name: "write_stdin",
      arguments: { workspaceId: "owner", sessionId: started.sessionId, yieldTimeMs: attempt === 0 ? 1_000 : 0 },
    });
    assert.notEqual(result.isError, true);
    const content = result.structuredContent as Record<string, unknown>;
    assert.equal(content.running, false);
    assert.equal(content.exitCode, 0);
    assert.match(String(content.result), new RegExp(marker));
  }

  const foreign = await client.callTool({
    name: "write_stdin",
    arguments: { workspaceId: "foreign", sessionId: started.sessionId, yieldTimeMs: 0 },
  });
  assert.equal(foreign.isError, true);
});

test("terminal replay expires at the existing completed-session TTL", async (t) => {
  const manager = new ProcessSessionManager({ completedSessionTtlMs: 250 });
  t.after(async () => manager.shutdown());
  const marker = `terminal-ttl-${randomUUID()}`;
  const started = await manager.start({
    workspaceId: "owner",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('${marker}'), 40)"`,
    yieldTimeMs: 0,
  });
  assert.ok(started.sessionId);
  const terminal = await manager.write({
    workspaceId: "owner",
    sessionId: started.sessionId,
    yieldTimeMs: 1_000,
  });
  assert.equal(terminal.running, false);
  assert.match(terminal.output, new RegExp(marker));

  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(
    manager.write({ workspaceId: "owner", sessionId: started.sessionId, yieldTimeMs: 0 }),
    /Unknown process session:/,
  );
});

test("interactive writes ignore poll cancellation semantics", async (t) => {
  const manager = new ProcessSessionManager();
  t.after(async () => manager.shutdown());
  const started = await manager.start({
    workspaceId: "owner",
    cwd: process.cwd(),
    command: `${node} -e "process.stdin.once('data', data => { console.log('interactive:' + data.toString().trim()); process.exit(0); })"`,
    yieldTimeMs: 0,
  });
  assert.ok(started.sessionId);
  const controller = new AbortController();
  controller.abort();

  const result = await manager.write(
    {
      workspaceId: "owner",
      sessionId: started.sessionId,
      chars: "hello\n",
      yieldTimeMs: 2_000,
    },
    { signal: controller.signal },
  );
  assert.equal(result.running, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /interactive:hello/);
});

test("list_process_sessions rediscovers an owned handle without consuming output or leaking command text", async (t) => {
  const { client, processSessions } = await fixture(t);
  const marker = `recoverable-output-${randomUUID()}`;
  const commandOnlyMarker = `command-only-${randomUUID()}`;
  const started = await processSessions.start({
    workspaceId: "owner",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('${marker}'), 20); setTimeout(() => {}, 1_000)" # ${commandOnlyMarker}`,
    yieldTimeMs: 0,
  });
  assert.ok(started.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const listed = await client.callTool({
    name: "list_process_sessions",
    arguments: { workspaceId: "owner" },
  });
  assert.notEqual(listed.isError, true);
  const content = listed.structuredContent as {
    result: string;
    sessions: Array<{
      sessionId: number;
      status: "running" | "completed";
      hasBufferedOutput: boolean;
    }>;
    truncated: boolean;
  };
  assert.equal(content.sessions.length, 1);
  assert.equal(content.sessions[0]?.sessionId, started.sessionId);
  assert.equal(content.sessions[0]?.status, "running");
  assert.equal(content.sessions[0]?.hasBufferedOutput, true);
  assert.equal(content.truncated, false);
  assert.doesNotMatch(content.result, new RegExp(marker));
  assert.doesNotMatch(content.result, new RegExp(commandOnlyMarker));

  const foreign = await client.callTool({
    name: "list_process_sessions",
    arguments: { workspaceId: "foreign" },
  });
  assert.notEqual(foreign.isError, true);
  assert.deepEqual(
    (foreign.structuredContent as { sessions: unknown[] }).sessions,
    [],
  );
  assert.match(
    String((foreign.structuredContent as { result?: unknown }).result),
    /expired-or-unavailable/,
  );
  assert.match(
    String((foreign.structuredContent as { result?: unknown }).result),
    /rerunning the original command is safe/,
  );

  const recovered = await processSessions.write({
    workspaceId: "owner",
    sessionId: started.sessionId,
    yieldTimeMs: 0,
  });
  assert.equal(recovered.running, true);
  assert.match(recovered.output, new RegExp(marker));
  processSessions.terminate("owner", started.sessionId);
});

test("recoverable process discovery is deterministic, workspace-scoped, and bounded", async (t) => {
  const generatedIds = [901, 902, 903];
  const manager = new ProcessSessionManager({
    sessionIdGenerator: () => generatedIds.shift() ?? 999,
  });
  t.after(async () => manager.shutdown());

  const startedIds: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const started = await manager.start({
      workspaceId: "owner",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => {}, 2_000)"`,
      yieldTimeMs: 0,
    });
    assert.ok(started.sessionId);
    startedIds.push(started.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  const limited = manager.listRecoverable("owner", 2);
  assert.deepEqual(limited.sessions.map((session) => session.sessionId), [903, 902]);
  assert.equal(limited.truncated, true);
  assert.deepEqual(manager.listRecoverable("foreign").sessions, []);
  assert.deepEqual(startedIds, [901, 902, 903]);
});

test("a listed running process remains discoverable after exit until completed-session TTL cleanup", async (t) => {
  const manager = new ProcessSessionManager({
    completedSessionTtlMs: 250,
    sessionIdGenerator: () => 1001,
  });
  t.after(async () => manager.shutdown());
  const marker = `list-terminal-race-${randomUUID()}`;
  const started = await manager.start({
    workspaceId: "owner",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('${marker}'), 40)"`,
    yieldTimeMs: 0,
  });
  assert.equal(started.sessionId, 1001);
  assert.equal(manager.listRecoverable("owner").sessions[0]?.status, "running");

  await new Promise((resolve) => setTimeout(resolve, 120));
  const completed = manager.listRecoverable("owner");
  assert.equal(completed.sessions.length, 1);
  assert.equal(completed.sessions[0]?.sessionId, 1001);
  assert.equal(completed.sessions[0]?.status, "completed");

  const replay = await manager.write({
    workspaceId: "owner",
    sessionId: 1001,
    yieldTimeMs: 0,
  });
  assert.equal(replay.running, false);
  assert.match(replay.output, new RegExp(marker));

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(manager.listRecoverable("owner").sessions, []);
});
