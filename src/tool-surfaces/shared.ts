import * as z from "zod/v4";
import { logEvent } from "../logger.js";
import { toolLifecycleObserved } from "../mcp-observability.js";
import type { ServerConfig } from "../config.js";
import {
  WORKSPACE_APP_URI,
  type DiffStats,
  type ToolContent,
  type ToolLogFields,
  type ToolWidgetDescriptorMeta,
} from "./types.js";

export function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

export function workspaceAppDescriptorMeta(config: ServerConfig): ToolWidgetDescriptorMeta {
  if (!config.uiEnabled) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls || toolLifecycleObserved()) return;

  // Legacy surfaces keep a completion record, but never emit caller-controlled
  // paths, command text, error messages or arbitrary extra properties.
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    tool: ["open_workspace", "read", "apply_patch", "exec_command", "write_stdin",
      "show_changes", "get_agy_runtime", "delegate_to_agy", "write", "edit", "bash"]
      .includes(fields.tool) ? fields.tool : "other",
    success: fields.success === true,
    durationMs: Number.isFinite(fields.durationMs) ? fields.durationMs : undefined,
  });
}

export async function runLoggedToolOperation<T>(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  startedAt: number,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    logToolCall(config, {
      ...fields,
      success: true,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    logToolCall(config, {
      ...fields,
      success: false,
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}

export function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

export function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  _content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
  });
}

export function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}
