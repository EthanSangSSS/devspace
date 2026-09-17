import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  installAgyReadOnlyHookPolicy,
  runAgyHeadless,
} from "./agy-runner.js";

const macTest = process.platform === "darwin" ? test : test.skip;

macTest("headless runner uses server policy model/effort, stateless flags, and ephemeral HOME", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-runner-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const taskRoot = join(root, "task");
  const argsLog = join(root, "args.txt");
  const homeLog = join(root, "home.txt");
  const agyPath = join(root, "agy");
  const hostKeychainPath = join(root, "login.keychain-db");
  await mkdir(workspace);
  await writeFile(hostKeychainPath, "fake-keychain");
  await writeFile(agyPath, [
    "#!/bin/sh",
    `printf '%s\\n' \"$@\" > ${JSON.stringify(argsLog)}`,
    `printf '%s' \"$HOME\" > ${JSON.stringify(homeLog)}`,
    "printf '%s\\n' '{\"event\":\"init\",\"init\":{\"model\":\"gemini-qualified-model\"}}'",
    "printf '%s\\n' '{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"first line\\n\"}}'",
    "",
  ].join("\n"));
  await chmod(agyPath, 0o700);

  const result = await runAgyHeadless({
    agyPath,
    model: "gemini-qualified-model",
    effort: "medium",
    cwd: workspace,
    taskRoot,
    prompt: "Read README.md",
    timeoutMs: 5_000,
    hostKeychainPath,
  });

  const args = (await readFile(argsLog, "utf8")).trim().split("\n");
  assert.deepEqual(option(args, "--model"), ["--model", "gemini-qualified-model"]);
  assert.deepEqual(option(args, "--effort"), ["--effort", "medium"]);
  assert.deepEqual(option(args, "--output-format"), ["--output-format", "stream-json"]);
  assert.deepEqual(option(args, "--mode"), ["--mode", "plan"]);
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(args.includes("--continue"), false);
  assert.equal(args.includes("--conversation"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  const ephemeralHome = await readFile(homeLog, "utf8");
  assert.equal(ephemeralHome.startsWith(taskRoot), true);
  const canonicalWorkspace = await realpath(workspace);
  const settings = JSON.parse(await readFile(join(ephemeralHome, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
  assert.deepEqual(settings, {
    enableTelemetry: false,
    permissions: {
      allow: [`read_file(${canonicalWorkspace})`],
      deny: [
        "write_file(*)",
        "command(*)",
        "unsandboxed(*)",
        "read_url(*)",
        "execute_url(*)",
        "mcp(*)",
      ],
      ask: [],
    },
  });
  assert.match(
    await readFile(join(ephemeralHome, ".gemini", "config", "hooks.json"), "utf8"),
    /"matcher": "\*"/,
  );
  assert.equal(
    await readlink(join(ephemeralHome, "Library", "Keychains", "login.keychain-db")),
    hostKeychainPath,
  );
  assert.equal(result.resolvedModel, "gemini-qualified-model");
  assert.equal(result.response, "first line\n");
});

macTest("headless runner retries once after an interrupted terminal stream", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-runner-retry-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const taskRoot = join(root, "task");
  const countPath = join(root, "count.txt");
  const agyPath = join(root, "agy");
  const hostKeychainPath = join(root, "login.keychain-db");
  await mkdir(workspace);
  await writeFile(hostKeychainPath, "fake-keychain");
  await writeFile(agyPath, [
    "#!/bin/sh",
    `count=0; [ -f ${JSON.stringify(countPath)} ] && count=$(cat ${JSON.stringify(countPath)})`,
    "count=$((count + 1))",
    `printf '%s' \"$count\" > ${JSON.stringify(countPath)}`,
    "printf '%s\\n' '{\"event\":\"init\",\"init\":{\"model\":\"gemini-3.8-flash-high\"}}'",
    "if [ \"$count\" -eq 1 ]; then",
    "  printf '%s\\n' '{\"event\":\"result\",\"result\":{\"status\":\"ERROR\",\"response\":\"partial\\n\",\"error\":\"The stream was interrupted. Please continue the task you were working on.\"}}'",
    "else",
    "  printf '%s\\n' '{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"retried\\n\"}}'",
    "fi",
    "",
  ].join("\n"));
  await chmod(agyPath, 0o700);

  const result = await runAgyHeadless({
    agyPath,
    model: "gemini-3.8-flash-high",
    effort: "high",
    cwd: workspace,
    taskRoot,
    prompt: "Read README.md",
    timeoutMs: 5_000,
    hostKeychainPath,
  });

  assert.equal(await readFile(countPath, "utf8"), "2");
  assert.equal(result.response, "retried\n");
});

macTest("headless runner does not retry ordinary terminal errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-runner-no-retry-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const taskRoot = join(root, "task");
  const countPath = join(root, "count.txt");
  const agyPath = join(root, "agy");
  const hostKeychainPath = join(root, "login.keychain-db");
  await mkdir(workspace);
  await writeFile(hostKeychainPath, "fake-keychain");
  await writeFile(agyPath, [
    "#!/bin/sh",
    `count=0; [ -f ${JSON.stringify(countPath)} ] && count=$(cat ${JSON.stringify(countPath)})`,
    "count=$((count + 1))",
    `printf '%s' \"$count\" > ${JSON.stringify(countPath)}`,
    "printf '%s\\n' '{\"event\":\"init\",\"init\":{\"model\":\"gemini-3.8-flash-high\"}}'",
    "printf '%s\\n' '{\"event\":\"result\",\"result\":{\"status\":\"ERROR\",\"response\":\"\",\"error\":\"permission denied\"}}'",
    "",
  ].join("\n"));
  await chmod(agyPath, 0o700);

  await assert.rejects(
    () => runAgyHeadless({
      agyPath,
      model: "gemini-3.8-flash-high",
      effort: "high",
      cwd: workspace,
      taskRoot,
      prompt: "Read README.md",
      timeoutMs: 5_000,
      hostKeychainPath,
    }),
    /terminal status was ERROR/i,
  );
  assert.equal(await readFile(countPath, "utf8"), "1");
});

test("read-only hook allows bounded reads and denies writes, commands, and out-of-workspace reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-hook-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const runtimeHome = join(root, "runtime-home");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "# Test\n");
  const policy = await installAgyReadOnlyHookPolicy(workspace, runtimeHome);

  assert.equal(policy.hooksPath, join(runtimeHome, ".gemini", "config", "hooks.json"));
  assert.match(await readFile(policy.hooksPath, "utf8"), /"matcher": "\*"/);
  assert.deepEqual(
    await invokeHook(policy.hookPath, {
      toolCall: { name: "view_file", args: { AbsolutePath: join(workspace, "README.md") } },
      workspacePaths: [],
    }),
    { decision: "allow", reason: "DevSpace V1 bounded read." },
  );
  assert.deepEqual(
    await invokeHook(policy.hookPath, {
      toolCall: { name: "list_dir", args: { DirectoryPath: workspace } },
      workspacePaths: [],
    }),
    { decision: "allow", reason: "DevSpace V1 bounded read." },
  );
  for (const input of [
    { toolCall: { name: "write_to_file", args: { TargetFile: join(workspace, "x") } }, workspacePaths: [] },
    { toolCall: { name: "run_command", args: { CommandLine: "pwd" } }, workspacePaths: [] },
    { toolCall: { name: "view_file", args: { AbsolutePath: "/etc/hosts" } }, workspacePaths: [] },
    { toolCall: { name: "find_by_name", args: { SearchDirectory: root, Pattern: "README.md" } }, workspacePaths: [] },
  ]) {
    const result = await invokeHook(policy.hookPath, input);
    assert.equal(result.decision, "deny");
  }
});

function option(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  return index < 0 ? [] : args.slice(index, index + 2);
}

async function invokeHook(path: string, input: unknown): Promise<{ decision: string; reason: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${stderr}`));
      resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}
