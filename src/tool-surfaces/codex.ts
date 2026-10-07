import * as z from "zod/v4";
import { mcpRequestAbortSignal, observeToolOperation } from "../mcp-observability.js";
import { applyPatch } from "../apply-patch.js";
import type {
  ProcessSnapshot,
  RecoverableProcessSessionList,
} from "../process-sessions.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `After ${toolNames.openWorkspace} succeeds, use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. If a host turn is interrupted after a process was left running and its sessionId is no longer available, use ${toolNames.listProcessSessions} with the existing workspaceId before rerunning the command. Commands run with the local user's authority and are not sandboxed; workspace validation only selects their initial working directory. exec_command is not a substitute for opening or authorizing the target workspace. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
    : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(snapshot: ProcessSnapshot) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

function recoverableProcessToolResponse(list: RecoverableProcessSessionList) {
  const result = list.sessions.length === 0
    ? "No recoverable process sessions are available for this workspace in the current DevSpace runtime. The prior handle is expired-or-unavailable from this recovery surface; do not infer that rerunning the original command is safe."
    : [
        "Recoverable process sessions for this workspace:",
        ...list.sessions.map((session) => [
          `sessionId=${session.sessionId}`,
          `status=${session.status}`,
          `wallTimeMs=${session.wallTimeMs}`,
          `hasBufferedOutput=${session.hasBufferedOutput}`,
          session.exitCode !== undefined ? `exitCode=${session.exitCode}` : undefined,
          session.signal ? `signal=${session.signal}` : undefined,
        ].filter(Boolean).join(" ")),
        ...(list.truncated ? ["Additional older recoverable sessions were omitted."] : []),
      ].join("\n");
  return {
    content: [textBlock(result)],
    structuredContent: {
      result,
      sessions: list.sessions,
      truncated: list.truncated,
    },
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
      },
      outputSchema: resultOutputSchema({
        additions: z.number(),
        removals: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            previousPath: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, patch }, { requestId }) => observeToolOperation(config, "apply_patch", async () => {
      const startedAt = performance.now();
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = workspaces.getWorkspace(workspaceId);
          return applyPatch(workspace.canonicalRoot, patch);
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files,
        },
      };
    }, { rpcRequestId: requestId }),
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    toolNames.listProcessSessions,
    {
      title: "List process sessions",
      description:
        "List recoverable process session handles owned by one known workspaceId in the current DevSpace runtime without consuming process output. Use this after a host/turn interruption when a previous exec_command or write_stdin may have left a process running or recently completed but the sessionId is no longer available. A session can be running or completed; absence means expired-or-unavailable from this recovery surface and must not be treated as proof that rerunning the original command is safe. Do not infer that a returned handle is the interrupted task solely because it is the only handle or because of its ordering; reuse it only when the caller's context supports that identity. Returns only opaque lifecycle metadata and never command text, environment variables, stdin history, or process output. This tool does not merge process visibility across workspaceIds or recover processes across DevSpace runtime restarts.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        sessions: z.array(z.object({
          sessionId: z.number().int().positive().safe(),
          status: z.enum(["running", "completed"]),
          startedAt: z.number().int().nonnegative(),
          wallTimeMs: z.number().nonnegative(),
          hasBufferedOutput: z.boolean(),
          exitCode: z.number().int().optional(),
          signal: z.string().optional(),
        })),
        truncated: z.boolean(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId }, { requestId }) => observeToolOperation(
      config,
      toolNames.listProcessSessions,
      async () => {
        const startedAt = performance.now();
        const list = await runLoggedToolOperation(
          config,
          { tool: toolNames.listProcessSessions, workspaceId },
          startedAt,
          async () => {
            workspaces.getWorkspace(workspaceId);
            return processSessions.listRecoverable(workspaceId);
          },
        );
        return recoverableProcessToolResponse(list);
      },
      { rpcRequestId: requestId },
    ),
  );

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command with the local user's authority. Commands are not sandboxed; workspace validation only selects the initial working directory. Returns the result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Allocate a pseudo-terminal for interactive commands. Defaults to false.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY width. Defaults to 80."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 30000 to reduce follow-up polling calls.",
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspaceId,
      cmd,
      tty,
      columns,
      rows,
      workingDirectory,
      yieldTimeMs,
      maxOutputTokens,
    }, { requestId }) => observeToolOperation(config, "exec_command", async () => {
      const startedAt = performance.now();
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = workspaces.getWorkspace(workspaceId);
          const cwd = workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          return processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.canonicalRoot,
            tty,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
      );

      return processToolResponse(snapshot);
    }, { rpcRequestId: requestId }),
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pure polls wait for process completion or the wait deadline even when output is already buffered, reducing repeated MCP round-trips; pass yieldTimeMs=0 for an immediate snapshot. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier used to start the process."),
        sessionId: z
          .number()
          .int()
          .positive()
          .safe()
          .describe(
            "Opaque process session identifier returned by exec_command. Reuse only the exact value returned by the current DevSpace runtime; do not synthesize or reuse identifiers from an earlier runtime.",
          ),
        chars: z
          .string()
          .optional()
          .describe(
            "Characters to write. Omit or pass an empty string to poll.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this width."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe(
            "Milliseconds to wait for process completion. Pure polls default to 30000, including when output is already buffered; use 0 for an immediate snapshot. Interactive writes default to 250.",
          ),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspaceId,
      sessionId,
      chars,
      columns,
      rows,
      yieldTimeMs,
      maxOutputTokens,
    }, extra) => {
      const httpSignal = mcpRequestAbortSignal();
      const pollSignal = httpSignal && httpSignal !== extra.signal
        ? AbortSignal.any([extra.signal, httpSignal])
        : extra.signal;
      return observeToolOperation(config, "write_stdin", async () => {
      const startedAt = performance.now();
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          workspaces.getWorkspace(workspaceId);
          return processSessions.write(
            {
              workspaceId,
              sessionId,
              chars,
              columns,
              rows,
              yieldTimeMs,
              maxOutputTokens,
            },
            { signal: pollSignal },
          );
        },
      );

      return processToolResponse(snapshot);
      }, { rpcRequestId: extra.requestId });
    },
  );
}
