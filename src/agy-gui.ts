import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgyDelegationError } from "./agy-delegation-types.js";

const execFileAsync = promisify(execFile);

export interface GuiTarget {
  pid: number;
  applicationIdentity: string;
  windowId: number;
}

export interface GuiWindow {
  windowId: number;
  pid: number;
  appName: string;
  title: string;
}

export interface RawGuiElement {
  elementIndex: number;
  elementToken?: string;
  role: string;
  label?: string;
  value?: unknown;
}

export interface RawGuiSnapshot {
  snapshotId: string;
  elements: RawGuiElement[];
}

export interface SanitizedGuiElement {
  elementIndex: number;
  elementToken?: string;
  role: string;
  label?: string;
}

export interface SanitizedGuiSnapshot {
  snapshotId: string;
  elements: SanitizedGuiElement[];
}

export type GuiIntent =
  | { type: "open_transient_menu"; elementIndex: number }
  | { type: "close_transient_menu" }
  | { type: "select_existing_tab"; elementIndex: number }
  | { type: "toggle_disclosure"; elementIndex: number }
  | {
      type: "scroll_within_approved_target";
      elementIndex: number;
      direction: "up" | "down" | "left" | "right";
      amount: number;
      by: "line" | "page";
    };

export interface GuiBackend {
  listWindows(pid: number): Promise<GuiWindow[]>;
  getWindowState(pid: number, windowId: number): Promise<RawGuiSnapshot>;
  click(input: Record<string, unknown>): Promise<void>;
  pressKey(input: Record<string, unknown>): Promise<void>;
  scroll(input: Record<string, unknown>): Promise<void>;
}

export class CuaDriverClient implements GuiBackend {
  constructor(private readonly executable: string) {}

  async listWindows(pid: number): Promise<GuiWindow[]> {
    const raw = await this.call("list_windows", { pid });
    const windows = Array.isArray(raw.windows) ? raw.windows : [];
    return windows.flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) return [];
      const windowId = numberField(record, "window_id");
      const ownerPid = numberField(record, "pid");
      const appName = stringField(record, "app_name");
      if (windowId === undefined || ownerPid === undefined || appName === undefined) return [];
      return [{
        windowId,
        pid: ownerPid,
        appName,
        title: stringField(record, "title") ?? "",
      }];
    });
  }

  async getWindowState(pid: number, windowId: number): Promise<RawGuiSnapshot> {
    const rawResponse = await this.call("get_window_state", {
      pid,
      window_id: windowId,
      include_screenshot: false,
    });
    const raw = asRecord(rawResponse.structuredContent) ?? rawResponse;
    const snapshotId = stringField(raw, "snapshot_id");
    if (!snapshotId) {
      throw new AgyDelegationError("GUI_CAPABILITY_DENIED", "CuaDriver did not return a snapshot_id.");
    }
    const elements = Array.isArray(raw.elements) ? raw.elements : [];
    return {
      snapshotId,
      elements: elements.flatMap((entry) => {
        const record = asRecord(entry);
        if (!record) return [];
        const elementIndex = numberField(record, "element_index");
        const role = stringField(record, "role");
        if (elementIndex === undefined || role === undefined) return [];
        return [{
          elementIndex,
          elementToken: stringField(record, "element_token"),
          role,
          label: stringField(record, "label"),
          value: record.value,
        }];
      }),
    };
  }

  async click(input: Record<string, unknown>): Promise<void> {
    await this.call("click", input);
  }

  async pressKey(input: Record<string, unknown>): Promise<void> {
    await this.call("press_key", input);
  }

  async scroll(input: Record<string, unknown>): Promise<void> {
    await this.call("scroll", input);
  }

  private async call(tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const { stdout } = await execFileAsync(
        this.executable,
        [tool, JSON.stringify(input)],
        { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout) as unknown;
      const record = asRecord(parsed);
      if (!record) throw new Error("CuaDriver response is not a JSON object.");
      return record;
    } catch (error) {
      if (error instanceof AgyDelegationError) throw error;
      throw new AgyDelegationError(
        "GUI_CAPABILITY_DENIED",
        `CuaDriver ${tool} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export class AgyGuiBroker {
  constructor(private readonly backend: GuiBackend) {}

  async observe(target: GuiTarget): Promise<SanitizedGuiSnapshot> {
    const window = await this.verifyTarget(target);
    const snapshot = await this.backend.getWindowState(target.pid, target.windowId);
    return sanitizeGuiSnapshot(snapshot, { windowTitle: window.title });
  }

  async execute(target: GuiTarget, intent: GuiIntent): Promise<SanitizedGuiSnapshot> {
    const window = await this.verifyTarget(target);
    const before = await this.backend.getWindowState(target.pid, target.windowId);
    sanitizeGuiSnapshot(before, { windowTitle: window.title });
    const common = {
      pid: target.pid,
      window_id: target.windowId,
      delivery_mode: "background",
    };

    if (intent.type === "close_transient_menu") {
      if (!before.elements.some((element) => /menu/i.test(element.role))) {
        throw new AgyDelegationError("GUI_ACTION_UNCLASSIFIED", "No transient menu is present in the fresh snapshot.");
      }
      await this.backend.pressKey({ ...common, key: "escape" });
    } else {
      const element = before.elements.find((candidate) => candidate.elementIndex === intent.elementIndex);
      if (!element) {
        throw new AgyDelegationError("GUI_ACTION_UNCLASSIFIED", "Semantic intent referenced an element absent from the fresh snapshot.");
      }
      const elementTarget = {
        ...common,
        element_index: element.elementIndex,
        snapshot_id: before.snapshotId,
      };
      switch (intent.type) {
        case "open_transient_menu":
          requireRole(element, /^(AX)?(PopUpButton|MenuButton)$/i, intent.type);
          await this.backend.click({ ...elementTarget, action: "show_menu" });
          break;
        case "select_existing_tab":
          requireRole(element, /^(AX)?Tab$/i, intent.type);
          await this.backend.click({ ...elementTarget, action: "press" });
          break;
        case "toggle_disclosure":
          requireRole(element, /^(AX)?Disclosure(Triangle|Button)$/i, intent.type);
          await this.backend.click({ ...elementTarget, action: "press" });
          break;
        case "scroll_within_approved_target":
          requireRole(element, /^(AX)?ScrollArea$/i, intent.type);
          if (!Number.isInteger(intent.amount) || intent.amount < 1 || intent.amount > 3) {
            throw new AgyDelegationError("GUI_ACTION_UNCLASSIFIED", "Scroll amount must be between 1 and 3.");
          }
          await this.backend.scroll({
            ...elementTarget,
            direction: intent.direction,
            amount: intent.amount,
            by: intent.by,
          });
          break;
      }
    }

    return this.observe(target);
  }

  private async verifyTarget(target: GuiTarget): Promise<GuiWindow> {
    const windows = await this.backend.listWindows(target.pid);
    const window = windows.find((candidate) => candidate.windowId === target.windowId);
    if (!window || window.pid !== target.pid || window.appName !== target.applicationIdentity) {
      throw new AgyDelegationError(
        "GUI_CAPABILITY_DENIED",
        "GUI target PID, application identity, and window ownership must all match exactly.",
      );
    }
    return window;
  }
}

export function sanitizeGuiSnapshot(
  snapshot: RawGuiSnapshot,
  context: { windowTitle: string },
): SanitizedGuiSnapshot {
  if (isSensitiveText(context.windowTitle)) {
    throw new AgyDelegationError("GUI_SENSITIVE_VIEW_DENIED", "Target window appears to contain authentication or credential UI.");
  }
  for (const element of snapshot.elements) {
    if (/secure|password/i.test(element.role)
      || isSensitiveText(element.label)
      || isSensitiveText(typeof element.value === "string" ? element.value : undefined)) {
      throw new AgyDelegationError("GUI_SENSITIVE_VIEW_DENIED", "Sensitive GUI surface denied before model exposure.");
    }
  }

  const elements = snapshot.elements
    .filter((element) => isExposableRole(element.role))
    .map((element) => ({
      elementIndex: element.elementIndex,
      ...(element.elementToken ? { elementToken: element.elementToken } : {}),
      role: element.role,
      ...(element.label ? { label: redactLabel(element.label) } : {}),
    }));
  return { snapshotId: snapshot.snapshotId, elements };
}

function requireRole(element: RawGuiElement, pattern: RegExp, intent: GuiIntent["type"]): void {
  if (!pattern.test(element.role)) {
    throw new AgyDelegationError(
      "GUI_ACTION_UNCLASSIFIED",
      `Fresh AX role ${element.role} does not authorize semantic intent ${intent}.`,
    );
  }
}

function isExposableRole(role: string): boolean {
  return /^(AX)?(Button|PopUpButton|MenuButton|Menu|MenuItem|Tab|DisclosureTriangle|DisclosureButton|ScrollArea)$/i.test(role);
}

function isSensitiveText(value: string | undefined): boolean {
  if (!value) return false;
  return /password|passcode|verification[ -]?code|one[ -]?time|\botp\b|api[ -]?key|access[ -]?token|secret[ -]?key|sign[ -]?in|log[ -]?in|two[ -]?factor|2fa/i.test(value);
}

function redactLabel(value: string): string {
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) return "[REDACTED]";
  if (/[A-Za-z0-9_-]{32,}/.test(value)) return "[REDACTED]";
  return value.slice(0, 200);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" ? record[key] : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}
