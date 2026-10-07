import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { logEvent, type LoggingConfig } from "./logger.js";

interface RequestContext {
  runtimeGeneration: string;
  requestId: string;
  sessionCorrelation?: string;
  clientCorrelation?: string;
  conversationCorrelation?: string;
  conversationCorrelationForRequest?: (requestId: string | number) => string | undefined;
  requestSignal?: AbortSignal;
  onToolTerminal?: (terminal: ToolTerminalObservation) => void;
}

interface ObservationContext extends Partial<RequestContext> {
  toolCallId?: string;
}

const context = new AsyncLocalStorage<ObservationContext>();

export function withMcpRequestContext<T>(fields: RequestContext, action: () => T): T {
  return context.run({
    runtimeGeneration: fields.runtimeGeneration,
    requestId: fields.requestId,
    sessionCorrelation: fields.sessionCorrelation,
    clientCorrelation: fields.clientCorrelation,
    conversationCorrelation: fields.conversationCorrelation,
    conversationCorrelationForRequest: fields.conversationCorrelationForRequest,
    requestSignal: fields.requestSignal,
    onToolTerminal: fields.onToolTerminal,
  }, action);
}

export function mcpRequestAbortSignal(): AbortSignal | undefined {
  return context.getStore()?.requestSignal;
}

export function toolLifecycleObserved(): boolean {
  return context.getStore()?.toolCallId !== undefined;
}

// Mirror Express's existing non-strict, case-insensitive /mcp route. This is
// observation only: it must not narrow or widen the application's routing.
export function isMcpPath(path: string): boolean {
  return /^\/mcp\/?$/i.test(path);
}

export function httpMethodLabel(method: string): string {
  return ["GET", "POST", "DELETE", "OPTIONS", "HEAD", "PUT", "PATCH"].includes(method)
    ? method : "OTHER";
}

export type ObservedTool = "open_workspace" | "read" | "apply_patch" | "exec_command"
  | "write_stdin" | "show_changes" | "get_agy_runtime" | "delegate_to_agy";

export interface ToolTerminalObservation {
  toolCallId: string;
  tool: ObservedTool;
  outcome: string;
  durationMs: number;
  conversationCorrelation?: string;
}

interface ToolObservationOptions {
  rpcRequestId?: string | number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown> : undefined;
}

function outcome(tool: ObservedTool, result: unknown): string {
  const response = record(result);
  if (response?.isError === true) return "tool_error";
  if (tool === "delegate_to_agy" && record(response?.structuredContent)?.ok === false) {
    return "tool_error";
  }
  if (tool === "exec_command" || tool === "write_stdin") {
    const process = record(response?.structuredContent);
    if (process?.running === true) return "process_running";
    if (process?.running === false) {
      if (process.signal) return "process_signaled";
      if (typeof process.exitCode === "number") {
        return process.exitCode === 0 ? "process_exit_zero" : "process_exit_nonzero";
      }
    }
    return "process_state_unknown";
  }
  // Handler return is not a claim that a user's overall task succeeded.
  return "returned";
}

export async function observeToolOperation<T>(
  config: { logging: LoggingConfig },
  tool: ObservedTool,
  operation: () => Promise<T>,
  options: ToolObservationOptions = {},
): Promise<T> {
  const parent = context.getStore();
  const scopedConversationCorrelation = options.rpcRequestId !== undefined
    ? parent?.conversationCorrelationForRequest?.(options.rpcRequestId)
      ?? parent?.conversationCorrelation
    : parent?.conversationCorrelation;
  const fields = {
    runtimeGeneration: parent?.runtimeGeneration,
    requestId: parent?.requestId,
    sessionCorrelation: parent?.sessionCorrelation,
    clientCorrelation: parent?.clientCorrelation,
    conversationCorrelation: scopedConversationCorrelation,
    toolCallId: randomUUID(),
    tool,
  };
  return context.run({
    ...fields,
    requestSignal: parent?.requestSignal,
    onToolTerminal: parent?.onToolTerminal,
    conversationCorrelationForRequest: parent?.conversationCorrelationForRequest,
  }, async () => {
    const startedAt = performance.now();
    const emit = (phase: "started" | "finished", result?: string, durationMs?: number): void => {
      if (!config.logging.toolCalls) return;
      // Lifecycle terminals are correlation evidence first. Keep both successful
      // and failed terminals in the canonical info stream so a single-log scan
      // cannot mistake a tool error for an in-flight request merely because
      // warn output was routed to stderr.
      logEvent(config.logging, "info", `mcp_tool_${phase}`, {
          ...fields,
          ...(phase === "finished" ? {
            outcome: result,
            durationMs,
          } : {}),
        });
    };
    const finish = (terminalOutcome: string): void => {
      const durationMs = Math.round(performance.now() - startedAt);
      emit("finished", terminalOutcome, durationMs);
      try {
        parent?.onToolTerminal?.({
          toolCallId: fields.toolCallId,
          tool,
          outcome: terminalOutcome,
          durationMs,
          conversationCorrelation: scopedConversationCorrelation,
        });
      } catch {
        // Diagnostics must never change an already completed tool operation.
      }
    };
    emit("started");
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      finish("threw");
      throw error;
    }
    // Never let diagnostics turn an already completed operation into a failure.
    let terminal = "unclassified";
    try { terminal = outcome(tool, result); } catch { /* Uninspectable result. */ }
    finish(terminal);
    return result;
  });
}
