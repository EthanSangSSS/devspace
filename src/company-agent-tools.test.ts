import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  COMPANY_AGENT_TOOL_NAMES,
  invokeCompanyAgentProductTool,
  registerCompanyAgentTools,
  resolveCompanyAgentRuntime,
} from "./company-agent-tools.js";
import { loadConfig } from "./config.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const DEFAULT_FIXTURE_SOURCE = [
  'let body = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => body += chunk);',
  'process.stdin.on("end", () => {',
  '  const tool = process.argv[process.argv.indexOf("--tool") + 1];',
  '  const payload = JSON.parse(body || "{}");',
  '  process.stdout.write(JSON.stringify({ ok: true, result: { tool, payload } }));',
  '});',
].join("\n");

async function fixture(
  root: string,
  source = DEFAULT_FIXTURE_SOURCE,
): Promise<string> {
  const scripts = join(root, "scripts");
  await mkdir(scripts, { recursive: true });
  const path = join(scripts, "run_company_agent_product_tool.py");
  await writeFile(path, source);
  await chmod(path, 0o700);
  return path;
}

test("Company Agent tools are disabled by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-company-agent-disabled-"));
  try {
    const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
      workspaces: { allowedRoots: [root] },
    }));
    assert.equal(config.companyAgent.enabled, false);
    assert.equal(config.companyAgent.workspacePath, null);
    const server = new McpServer({ name: "test", version: "1" });
    server.registerTool(
      "noop",
      { inputSchema: {}, outputSchema: { ok: z.boolean() } },
      async () => ({ content: [], structuredContent: { ok: true } }),
    );
    registerCompanyAgentTools(server, config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "client", version: "1" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const listed = await client.listTools();
    for (const name of COMPANY_AGENT_TOOL_NAMES) {
      assert.equal(listed.tools.some((tool) => tool.name === name), false);
    }
    await client.close();
    await server.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enabled Company Agent tools use one fixed configured workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-company-agent-enabled-"));
  try {
    await fixture(root);
    const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
      workspaces: { allowedRoots: [root] },
      companyAgent: {
        enabled: true,
        workspacePath: root,
        pythonPath: process.execPath,
        timeoutMs: 2_000,
      },
    }));
    const runtime = resolveCompanyAgentRuntime(config);
    assert.equal(await realpath(runtime.workspacePath), await realpath(root));

    const server = new McpServer({ name: "test", version: "1" });
    registerCompanyAgentTools(server, config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "client", version: "1" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    for (const name of COMPANY_AGENT_TOOL_NAMES) assert.ok(tools.has(name));
    assert.equal(tools.get("company_agent_get_analysis_packet")?.annotations?.readOnlyHint, true);
    assert.equal(tools.get("company_agent_refresh_analysis")?.annotations?.readOnlyHint, false);
    assert.equal(tools.get("company_agent_refresh_analysis")?.annotations?.openWorldHint, true);
    assert.equal(tools.get("company_agent_record_judgment")?.annotations?.idempotentHint, true);
    assert.equal(tools.get("company_agent_update_owner_context")?.annotations?.openWorldHint, false);
    const recordJudgmentSchema = tools.get("company_agent_record_judgment")
      ?.inputSchema as any;
    const judgmentProperties = recordJudgmentSchema
      ?.properties?.judgment?.properties;
    assert.equal(judgmentProperties?.assessment?.minLength, 1);
    assert.equal(judgmentProperties?.assessment?.maxLength, 600);
    assert.equal(judgmentProperties?.goal_ids?.maxItems, 3);
    assert.equal(judgmentProperties?.evidence_refs?.maxItems, 12);
    assert.equal(judgmentProperties?.recommended_next_step?.minLength, 1);
    assert.equal(judgmentProperties?.recommended_next_step?.maxLength, 500);
    assert.equal(judgmentProperties?.supporting_steps?.maxItems, 2);
    assert.equal(judgmentProperties?.supporting_steps?.items?.minLength, 1);
    assert.equal(judgmentProperties?.supporting_steps?.items?.maxLength, 400);
    assert.equal(judgmentProperties?.uncertainties?.maxItems, 5);
    assert.equal(judgmentProperties?.uncertainties?.items?.minLength, 1);
    assert.equal(judgmentProperties?.uncertainties?.items?.maxLength, 400);

    const get = await client.callTool({
      name: "company_agent_get_analysis_packet",
      arguments: {},
    });
    assert.deepEqual(
      (get.structuredContent as { result: unknown }).result,
      { tool: "company_agent_get_analysis_packet", payload: {} },
    );

    const update = await client.callTool({
      name: "company_agent_update_owner_context",
      arguments: {
        context: {
          goals: [{
            goal_id: "goal-1",
            priority: 1,
            statement: "Ship v2b",
            success_criteria: "Web can save a bounded judgment",
          }],
          preferences: [],
          constraints: [],
          project_brief: { stage: "v2b", summary: "manual MVP", key_decisions: [] },
          selected_memory_ids: [],
        },
        expected_context_version: 0,
      },
    });
    const updateResult = (update.structuredContent as { result: any }).result;
    assert.equal(updateResult.tool, "company_agent_update_owner_context");
    assert.equal(updateResult.payload.expected_context_version, 0);

    await client.close();
    await server.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Company Agent judgment text limits count Unicode code points like Python", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-company-agent-unicode-"));
  try {
    await fixture(root);
    const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
      workspaces: { allowedRoots: [root] },
      companyAgent: {
        enabled: true,
        workspacePath: root,
        pythonPath: process.execPath,
        timeoutMs: 2_000,
      },
    }));
    const server = new McpServer({ name: "test", version: "1" });
    registerCompanyAgentTools(server, config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "client", version: "1" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const baseJudgment = {
      disposition: "NO_ACTION" as const,
      assessment: "ok",
      goal_ids: ["goal-1"],
      evidence_refs: ["fact-1"],
      recommended_next_step: "none",
      supporting_steps: ["none"],
      uncertainties: ["none"],
    };
    const sourcePacketDigest = `sha256:${"a".repeat(64)}`;
    const cases = [
      {
        name: "assessment",
        limit: 600,
        build: (value: string) => ({ ...baseJudgment, assessment: value }),
      },
      {
        name: "recommended_next_step",
        limit: 500,
        build: (value: string) => ({ ...baseJudgment, recommended_next_step: value }),
      },
      {
        name: "supporting_steps item",
        limit: 400,
        build: (value: string) => ({ ...baseJudgment, supporting_steps: [value] }),
      },
      {
        name: "uncertainties item",
        limit: 400,
        build: (value: string) => ({ ...baseJudgment, uncertainties: [value] }),
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const atLimit = "a".repeat(testCase.limit - 1) + "😀";
      const overLimit = "a".repeat(testCase.limit) + "😀";
      assert.equal(Array.from(atLimit).length, testCase.limit);
      assert.equal(Array.from(overLimit).length, testCase.limit + 1);

      const accepted = await client.callTool({
        name: "company_agent_record_judgment",
        arguments: {
          request_id: `unicode-limit-${index}-accepted`,
          source_packet_digest: sourcePacketDigest,
          judgment: testCase.build(atLimit),
        },
      });
      assert.notEqual(accepted.isError, true, `${testCase.name} should accept the limit`);
      assert.deepEqual(
        (accepted.structuredContent as { result: any }).result.payload.judgment,
        testCase.build(atLimit),
      );

      const rejected = await client.callTool({
        name: "company_agent_record_judgment",
        arguments: {
          request_id: `unicode-limit-${index}-rejected`,
          source_packet_digest: sourcePacketDigest,
          judgment: testCase.build(overLimit),
        },
      });
      assert.equal(
        rejected.isError,
        true,
        `${testCase.name} should reject values over the Unicode code-point limit`,
      );
      const rejectedContent = rejected.content as Array<{
        type: string;
        text?: string;
      }>;
      assert.match(
        rejectedContent
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text ?? "")
          .join("\n"),
        /-32602|Invalid arguments/,
      );
    }

    await client.close();
    await server.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Company Agent configured workspace must stay inside allowed roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-company-agent-root-"));
  const outside = await mkdtemp(join(tmpdir(), "devspace-company-agent-outside-"));
  try {
    await fixture(outside);
    const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
      workspaces: { allowedRoots: [root] },
      companyAgent: {
        enabled: true,
        workspacePath: outside,
        pythonPath: process.execPath,
      },
    }));
    assert.throws(
      () => resolveCompanyAgentRuntime(config),
      /outside allowed roots/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Company Agent subprocess is deadline bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-company-agent-timeout-"));
  try {
    await fixture(root, "setTimeout(() => {}, 60_000);");
    const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
      workspaces: { allowedRoots: [root] },
      companyAgent: {
        enabled: true,
        workspacePath: root,
        pythonPath: process.execPath,
        timeoutMs: 50,
      },
    }));
    await assert.rejects(
      invokeCompanyAgentProductTool(
        resolveCompanyAgentRuntime(config),
        "company_agent_get_analysis_packet",
        {},
      ),
      /timed out/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Company Agent subprocess stops when the MCP request is aborted", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-company-agent-abort-"));
  try {
    await fixture(root, "setTimeout(() => {}, 60_000);");
    const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
      workspaces: { allowedRoots: [root] },
      companyAgent: {
        enabled: true,
        workspacePath: root,
        pythonPath: process.execPath,
        timeoutMs: 5_000,
      },
    }));
    const controller = new AbortController();
    const started = performance.now();
    const pending = invokeCompanyAgentProductTool(
      resolveCompanyAgentRuntime(config),
      "company_agent_get_analysis_packet",
      {},
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, /aborted/i);
    assert.ok(performance.now() - started < 1_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Company Agent subprocess rejects oversized output", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-company-agent-output-"));
  try {
    await fixture(root, 'process.stdout.write("x".repeat(1024 * 1024 + 10));');
    const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
      workspaces: { allowedRoots: [root] },
      companyAgent: {
        enabled: true,
        workspacePath: root,
        pythonPath: process.execPath,
        timeoutMs: 2_000,
      },
    }));
    await assert.rejects(
      invokeCompanyAgentProductTool(
        resolveCompanyAgentRuntime(config),
        "company_agent_get_analysis_packet",
        {},
      ),
      /stdout limit/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
