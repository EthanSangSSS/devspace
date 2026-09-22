import assert from "node:assert/strict";
import test from "node:test";
import { logEvent, type LoggingConfig } from "./logger.js";
import { observeToolOperation, withMcpRequestContext } from "./mcp-observability.js";
import { logToolCall } from "./tool-surfaces/shared.js";
import type { ServerConfig } from "./config.js";

const logging: LoggingConfig = {
  level: "info", format: "json", requests: true, assets: false,
  toolCalls: true, shellCommands: true, trustProxy: false,
};

test("lifecycle terminals are exact, opaque and do not imply process completion", async (t) => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = console.warn = (line: unknown) => { lines.push(String(line)); };
  t.after(() => { console.log = originalLog; console.warn = originalWarn; });
  const secret = "SYNTHETIC_PRIVATE_CANARY";
  const execute = (tool: Parameters<typeof observeToolOperation>[1], value: unknown) =>
    observeToolOperation({ logging }, tool, async () => value);
  const cases = [
    ["read", { isError: true, content: [{ text: secret }] }, "tool_error"],
    ["delegate_to_agy", { structuredContent: { ok: false, result: secret } }, "tool_error"],
    ["exec_command", { structuredContent: { running: true, result: secret } }, "process_running"],
    ["write_stdin", { structuredContent: { running: false, exitCode: 2 } }, "process_exit_nonzero"],
    ["exec_command", { structuredContent: { running: false, exitCode: 0 } }, "process_exit_zero"],
    ["exec_command", { structuredContent: { running: false, signal: secret } }, "process_signaled"],
    ["exec_command", { structuredContent: { running: false } }, "process_state_unknown"],
  ] as const;
  for (const [tool, value, expected] of cases) {
    assert.equal(await execute(tool, value), value);
    assert.equal(JSON.parse(lines.at(-1)!).outcome, expected);
  }
  const failure = new Error(secret);
  await assert.rejects(observeToolOperation({ logging }, "open_workspace", async () => {
    throw failure;
  }), (error) => error === failure);
  assert.equal(JSON.parse(lines.at(-1)!).outcome, "threw");
  assert.equal(lines.length, (cases.length + 1) * 2);
  const keys = new Set(["ts", "level", "event", "toolCallId", "tool", "outcome", "durationMs"]);
  for (const line of lines) {
    const event = JSON.parse(line);
    assert.ok(Object.keys(event).every((key) => keys.has(key)));
  }
  assert.ok(!lines.join("\n").includes(secret));
});

test("nested legacy completion logs are suppressed and direct logs use a whitelist", async (t) => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => { lines.push(String(line)); };
  t.after(() => { console.log = original; });
  const config = { logging } as ServerConfig;
  const fields = {
    tool: "read", success: true, durationMs: 1,
    command: "CANARY_CMD", error: "CANARY_ERROR", path: "CANARY_PATH",
    workspaceId: "CANARY_WORKSPACE", workingDirectory: "CANARY_CWD",
  };
  await withMcpRequestContext({ runtimeGeneration: "runtime", requestId: "request", sessionCorrelation: "session" },
    () => observeToolOperation(config, "read", async () => {
      logToolCall(config, fields);
      return { content: [] };
    }));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const event = JSON.parse(line);
    assert.equal(event.requestId, "request");
    assert.equal(event.sessionCorrelation, "session");
  }
  logToolCall(config, fields);
  assert.equal(lines.length, 3);
  assert.ok(!lines.join("\n").includes("CANARY"));
});

test("failed logging sinks cannot fail or repeat an operation", async (t) => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = console.warn = () => { throw new Error("sink unavailable"); };
  t.after(() => { console.log = originalLog; console.warn = originalWarn; });
  let calls = 0;
  const result = { content: [] };
  assert.equal(await observeToolOperation({ logging }, "apply_patch", async () => {
    calls++;
    return result;
  }), result);
  const failure = new Error("operation failure");
  await assert.rejects(observeToolOperation({ logging }, "read", async () => {
    calls++;
    throw failure;
  }), (error) => error === failure);
  assert.equal(calls, 2);
  assert.doesNotThrow(() => logEvent(logging, "info", "test", { value: 1n }));
});
