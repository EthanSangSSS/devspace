import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgyGuiBroker,
  CuaDriverClient,
  sanitizeGuiSnapshot,
  type GuiBackend,
  type GuiTarget,
  type RawGuiSnapshot,
} from "./agy-gui.js";
import { AgyDelegationError } from "./agy-delegation-types.js";

const target: GuiTarget = { pid: 42, applicationIdentity: "ChatGPT", windowId: 100 };
const macTest = process.platform === "darwin" ? test : test.skip;

test("GUI sanitization exposes bounded interactive chrome but not document text or editable values", () => {
  const sanitized = sanitizeGuiSnapshot({
    snapshotId: "s12345678",
    elements: [
      { elementIndex: 1, role: "AXStaticText", label: "private conversation body", value: "secret message" },
      { elementIndex: 2, role: "AXTextField", label: "Search", value: "private query" },
      { elementIndex: 3, role: "AXButton", label: "Pinned chats" },
      { elementIndex: 4, role: "AXTab", label: "Home" },
      { elementIndex: 5, role: "AXScrollArea", label: "Sidebar" },
    ],
  }, { windowTitle: "ChatGPT" });

  assert.equal(JSON.stringify(sanitized).includes("private conversation body"), false);
  assert.equal(JSON.stringify(sanitized).includes("private query"), false);
  assert.deepEqual(sanitized.elements.map((element) => element.label), ["Pinned chats", "Home", "Sidebar"]);
});

test("GUI sanitization fails closed on secure/auth surfaces", () => {
  for (const snapshot of [
    { snapshotId: "s12345678", elements: [{ elementIndex: 1, role: "AXSecureTextField", label: "Password" }] },
    { snapshotId: "s12345678", elements: [{ elementIndex: 1, role: "AXButton", label: "Enter verification code" }] },
  ]) {
    assert.throws(
      () => sanitizeGuiSnapshot(snapshot, { windowTitle: "Account" }),
      isCode("GUI_SENSITIVE_VIEW_DENIED"),
    );
  }
  assert.throws(
    () => sanitizeGuiSnapshot(
      { snapshotId: "s12345678", elements: [{ elementIndex: 1, role: "AXButton", label: "Continue" }] },
      { windowTitle: "Sign in to account" },
    ),
    isCode("GUI_SENSITIVE_VIEW_DENIED"),
  );
});

test("GUI broker verifies exact pid/app/window and permits only role-classified semantic intents", async () => {
  const backend = new FakeBackend();
  const broker = new AgyGuiBroker(backend, { foregroundPolicy: "deny" });
  const observed = await broker.observe(target);
  assert.equal(observed.snapshotId, "s12345678");

  await broker.execute(target, { type: "open_transient_menu", elementIndex: 10 });
  await broker.execute(target, { type: "select_existing_tab", elementIndex: 11 });
  await broker.execute(target, { type: "toggle_disclosure", elementIndex: 12 });
  await broker.execute(target, {
    type: "scroll_within_approved_target",
    elementIndex: 13,
    direction: "down",
    amount: 2,
    by: "line",
  });
  assert.deepEqual(backend.actions.map((action) => action.kind), ["click", "click", "click", "scroll"]);
  assert.deepEqual(
    backend.actions.map((action) => action.input.delivery_mode),
    ["background", "background", "background", "background"],
  );

  await assert.rejects(
    () => broker.execute(target, { type: "select_existing_tab", elementIndex: 10 }),
    isCode("GUI_ACTION_UNCLASSIFIED"),
  );
  await assert.rejects(
    () => broker.observe({ ...target, applicationIdentity: "Safari" }),
    isCode("GUI_CAPABILITY_DENIED"),
  );
});

test("GUI broker deny policy refuses to mutate the user's frontmost app", async () => {
  const backend = new FakeBackend();
  backend.foregroundStates = [{ pid: target.pid, windowId: target.windowId }];
  const broker = new AgyGuiBroker(backend, { foregroundPolicy: "deny" });

  await assert.rejects(
    () => broker.execute(target, { type: "open_transient_menu", elementIndex: 10 }),
    isCode("GUI_FOREGROUND_POLICY_DENIED"),
  );
  assert.equal(backend.actions.length, 0);
  assert.equal(backend.restores.length, 0);
});

test("GUI broker deny policy stops when a background action changes frontmost state", async () => {
  const backend = new FakeBackend();
  backend.foregroundStates = [
    { pid: 777, windowId: 701 },
    { pid: target.pid, windowId: target.windowId },
  ];
  const broker = new AgyGuiBroker(backend, { foregroundPolicy: "deny" });

  await assert.rejects(
    () => broker.execute(target, { type: "open_transient_menu", elementIndex: 10 }),
    isCode("GUI_FOREGROUND_CHANGED"),
  );
  assert.equal(backend.actions.length, 1);
  assert.equal(backend.actions[0]?.input.delivery_mode, "background");
  assert.equal(backend.restores.length, 0);
});

test("GUI broker allow-restore policy restores and verifies the exact prior frontmost window", async () => {
  const backend = new FakeBackend();
  backend.foregroundStates = [
    { pid: 777, windowId: 701 },
    { pid: target.pid, windowId: target.windowId },
    { pid: 777, windowId: 701 },
  ];
  const broker = new AgyGuiBroker(backend, { foregroundPolicy: "allow-restore" });

  await broker.execute(target, { type: "open_transient_menu", elementIndex: 10 });

  assert.deepEqual(backend.restores, [{ pid: 777, windowId: 701 }]);
  assert.equal(backend.actions[0]?.input.delivery_mode, "background");
});

test("GUI broker reports a typed restore failure when foreground restoration cannot be performed", async () => {
  const backend = new FakeBackend();
  backend.foregroundStates = [
    { pid: 777, windowId: 701 },
    { pid: target.pid, windowId: target.windowId },
  ];
  backend.restoreError = new Error("restore unavailable");
  const broker = new AgyGuiBroker(backend, { foregroundPolicy: "allow-restore" });

  await assert.rejects(
    () => broker.execute(target, { type: "open_transient_menu", elementIndex: 10 }),
    isCode("GUI_FOREGROUND_RESTORE_FAILED"),
  );
});

macTest("CuaDriver client requests exact window AX state with screenshots disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-cua-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, "calls.txt");
  const cuaPath = join(root, "cua-driver");
  await writeFile(cuaPath, [
    "#!/bin/sh",
    `printf '%s|%s\\n' \"$1\" \"$2\" >> ${JSON.stringify(logPath)}`,
    "if [ \"$1\" = \"list_windows\" ]; then printf '%s\\n' '{\"windows\":[{\"window_id\":100,\"pid\":42,\"app_name\":\"ChatGPT\",\"title\":\"ChatGPT\",\"z_index\":4,\"is_on_screen\":true,\"layer\":0},{\"window_id\":101,\"pid\":42,\"app_name\":\"ChatGPT\",\"title\":\"Front\",\"z_index\":9,\"is_on_screen\":true,\"layer\":0}]}'; exit 0; fi",
    "if [ \"$1\" = \"get_window_state\" ]; then printf '%s\\n' '{\"snapshot_id\":\"s12345678\",\"elements\":[{\"element_index\":3,\"role\":\"AXButton\",\"label\":\"Pinned chats\"}]}'; exit 0; fi",
    "if [ \"$1\" = \"bring_to_front\" ]; then printf '%s\\n' '{}'; exit 0; fi",
    "exit 2",
    "",
  ].join("\n"));
  await chmod(cuaPath, 0o700);

  const client = new CuaDriverClient(cuaPath);
  const broker = new AgyGuiBroker(client, { foregroundPolicy: "deny" });
  const result = await broker.observe(target);
  assert.equal(result.elements[0]?.label, "Pinned chats");
  assert.deepEqual(await client.getForegroundState(), { pid: 42, windowId: 101 });
  const calls = await readFile(logPath, "utf8");
  assert.match(calls, /list_windows\|/);
  assert.match(calls, /get_window_state\|.*"pid":42.*"window_id":100.*"include_screenshot":false/);
});

class FakeBackend implements GuiBackend {
  readonly actions: Array<{ kind: string; input: Record<string, unknown> }> = [];
  readonly restores: Array<{ pid: number; windowId?: number }> = [];
  foregroundStates: Array<{ pid: number; windowId: number }> = [];
  foregroundState = { pid: 777, windowId: 701 };
  restoreError?: Error;
  private readonly snapshot: RawGuiSnapshot = {
    snapshotId: "s12345678",
    elements: [
      { elementIndex: 10, role: "AXPopUpButton", label: "More" },
      { elementIndex: 11, role: "AXTab", label: "Home" },
      { elementIndex: 12, role: "AXDisclosureTriangle", label: "Details" },
      { elementIndex: 13, role: "AXScrollArea", label: "Sidebar" },
    ],
  };

  async listWindows() {
    return [{ windowId: 100, pid: 42, appName: "ChatGPT", title: "ChatGPT" }];
  }

  async getWindowState() {
    return this.snapshot;
  }

  async click(input: Record<string, unknown>) {
    this.actions.push({ kind: "click", input });
  }

  async pressKey(input: Record<string, unknown>) {
    this.actions.push({ kind: "press_key", input });
  }

  async scroll(input: Record<string, unknown>) {
    this.actions.push({ kind: "scroll", input });
  }

  async getForegroundState() {
    return this.foregroundStates.shift() ?? this.foregroundState;
  }

  async restoreForeground(state: { pid: number; windowId: number }) {
    if (this.restoreError) throw this.restoreError;
    this.restores.push(state);
  }
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof AgyDelegationError && error.code === code;
}
