import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import { mcpRequestAbortSignal, observeToolOperation } from "./mcp-observability.js";
import { terminateProcessTree } from "./process-platform.js";
import { assertAllowedPath } from "./roots.js";

const COMPANY_AGENT_SCRIPT = join("scripts", "run_company_agent_product_tool.py");
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;

export const COMPANY_AGENT_TOOL_NAMES = [
  "company_agent_get_analysis_packet",
  "company_agent_refresh_analysis",
  "company_agent_record_judgment",
  "company_agent_get_judgment",
  "company_agent_update_owner_context",
] as const;

type CompanyAgentToolName = (typeof COMPANY_AGENT_TOOL_NAMES)[number];

interface CompanyAgentToolRuntime {
  workspacePath: string;
  scriptPath: string;
  pythonPath: string;
  timeoutMs: number;
}

interface ProductCliEnvelope {
  ok: boolean;
  result?: unknown;
  error_code?: string;
}

const goalSchema = z.object({
  goal_id: z.string(),
  priority: z.number().int(),
  statement: z.string(),
  success_criteria: z.string(),
}).strict();

const preferenceSchema = z.object({
  preference_id: z.string(),
  statement: z.string(),
}).strict();

const constraintSchema = z.object({
  constraint_id: z.string(),
  statement: z.string(),
}).strict();

const keyDecisionSchema = z.object({
  decision_id: z.string(),
  statement: z.string(),
  source: z.string(),
  updated_at: z.string(),
}).strict();

const ownerContextSchema = z.object({
  goals: z.array(goalSchema),
  preferences: z.array(preferenceSchema),
  constraints: z.array(constraintSchema),
  project_brief: z.object({
    stage: z.string(),
    summary: z.string(),
    key_decisions: z.array(keyDecisionSchema),
  }).strict(),
  selected_memory_ids: z.array(z.string()),
}).strict();

const judgmentSchema = z.object({
  disposition: z.enum(["NO_ACTION", "REVIEW_RECOMMENDED", "NEEDS_CONTEXT"]),
  assessment: z.string(),
  goal_ids: z.array(z.string()),
  evidence_refs: z.array(z.string()),
  recommended_next_step: z.string(),
  supporting_steps: z.array(z.string()),
  uncertainties: z.array(z.string()),
}).strict();

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function toolResponse(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: { result },
  };
}

export function resolveCompanyAgentRuntime(config: ServerConfig): CompanyAgentToolRuntime {
  const requested = config.companyAgent.workspacePath;
  if (!config.companyAgent.enabled || requested === null) {
    throw new Error("Company Agent product tools are not enabled.");
  }
  const workspacePath = realpathSync(assertAllowedPath(requested, config.allowedRoots));
  const scriptPath = realpathSync(assertAllowedPath(
    join(workspacePath, COMPANY_AGENT_SCRIPT),
    [workspacePath],
  ));
  if (!lstatSync(scriptPath).isFile()) {
    throw new Error("Company Agent product entrypoint must be a regular file.");
  }
  return {
    workspacePath,
    scriptPath,
    pythonPath: config.companyAgent.pythonPath,
    timeoutMs: config.companyAgent.timeoutMs,
  };
}

export async function invokeCompanyAgentProductTool(
  runtime: CompanyAgentToolRuntime,
  tool: CompanyAgentToolName,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const input = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(runtime.pythonPath, [runtime.scriptPath, "--tool", tool], {
      cwd: runtime.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failure: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      terminateProcessTree(child, "SIGTERM", detached);
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL", detached);
      }, TERMINATION_GRACE_MS);
      forceKillTimer.unref();
    };
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      terminate();
    };
    const timer = setTimeout(() => {
      fail(new Error("Company Agent product tool timed out."));
    }, runtime.timeoutMs);
    const onAbort = () => fail(new Error("Company Agent product tool was aborted."));
    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail(new Error("Company Agent product tool exceeded its stdout limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        fail(new Error("Company Agent product tool exceeded its stderr limit."));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure ?? new Error(
        "Company Agent product tool could not start: " + error.message
      ));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) {
        reject(failure);
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      let envelope: ProductCliEnvelope;
      try {
        envelope = JSON.parse(output) as ProductCliEnvelope;
      } catch {
        reject(new Error("Company Agent product tool returned invalid JSON."));
        return;
      }
      if (typeof envelope !== "object" || envelope === null || typeof envelope.ok !== "boolean") {
        reject(new Error("Company Agent product tool returned an invalid envelope."));
        return;
      }
      if (exitCode !== 0 || !envelope.ok) {
        const errorCode = typeof envelope.error_code === "string"
          ? envelope.error_code
          : "OPERATION_FAILED";
        reject(new Error("Company Agent product tool failed: " + errorCode));
        return;
      }
      resolve(envelope.result);
    });
    child.stdin?.on("error", () => {});
    if (!signal?.aborted) child.stdin?.end(input);
  });
}

export function registerCompanyAgentTools(server: McpServer, config: ServerConfig): void {
  if (!config.companyAgent.enabled) return;
  const runtime = resolveCompanyAgentRuntime(config);
  const invoke = (
    tool: CompanyAgentToolName,
    payload: unknown,
    rpcRequestId: string | number,
  ) => observeToolOperation(config, tool, async () => toolResponse(
    await invokeCompanyAgentProductTool(
      runtime,
      tool,
      payload,
      mcpRequestAbortSignal(),
    ),
  ), { rpcRequestId });

  server.registerTool(
    "company_agent_get_analysis_packet",
    {
      title: "Get Company Agent analysis packet",
      description: "Read the fixed Company Agent instance's current canonical facts and explicit owner context without refreshing GitHub or mutating local state.",
      inputSchema: {},
      outputSchema: { result: z.unknown() },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (_payload, { requestId }) => invoke(
      "company_agent_get_analysis_packet",
      {},
      requestId,
    ),
  );

  server.registerTool(
    "company_agent_refresh_analysis",
    {
      title: "Refresh Company Agent analysis",
      description: "Run the fixed Company Agent instance's existing read-only GitHub observation flow, persist its bounded local observation state, and return the resulting canonical analysis packet. No GitHub write or executor path exists.",
      inputSchema: {},
      outputSchema: { result: z.unknown() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (_payload, { requestId }) => invoke(
      "company_agent_refresh_analysis",
      {},
      requestId,
    ),
  );

  server.registerTool(
    "company_agent_record_judgment",
    {
      title: "Record Company Agent judgment",
      description: "Validate and save one Web-generated judgment against an exact canonical analysis packet. This writes only the local Company Agent product database and never grants execution authority.",
      inputSchema: {
        request_id: z.string().min(1).max(128),
        source_packet_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        judgment: judgmentSchema,
      },
      outputSchema: { result: z.unknown() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (payload, { requestId }) => invoke(
      "company_agent_record_judgment",
      payload,
      requestId,
    ),
  );

  server.registerTool(
    "company_agent_get_judgment",
    {
      title: "Get Company Agent judgment",
      description: "Read one saved Company Agent judgment by judgment ID or request ID and report whether its bound packet is still current.",
      inputSchema: {
        judgment_id: z.string().min(1).optional(),
        request_id: z.string().min(1).max(128).optional(),
      },
      outputSchema: { result: z.unknown() },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (payload, { requestId }) => invoke(
      "company_agent_get_judgment",
      payload,
      requestId,
    ),
  );

  server.registerTool(
    "company_agent_update_owner_context",
    {
      title: "Update Company Agent owner context",
      description: "Save explicit user-confirmed goals, preferences, constraints and project context as a new version in the fixed Company Agent product instance.",
      inputSchema: {
        context: ownerContextSchema,
        expected_context_version: z.number().int().nonnegative(),
      },
      outputSchema: { result: z.unknown() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (payload, { requestId }) => invoke(
      "company_agent_update_owner_context",
      payload,
      requestId,
    ),
  );
}
