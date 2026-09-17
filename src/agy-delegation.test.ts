import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { AgyDelegationService } from "./agy-delegation.js";

const execFileAsync = promisify(execFile);
const macTest = process.platform === "darwin" ? test : test.skip;
const currentAgyPolicy = {
  model: "gemini-3.8-flash-high",
  effort: "high",
  compatibleVersions: ">=1.1.22 <1.2.0",
};

macTest("repo-read returns verified claims and leaves source unchanged", async (t) => {
  const fixture = await delegationFixture(t, "gemini-3.8-flash-high");
  const service = new AgyDelegationService({
    config: fixture.config,
    gitleaksPath: fixture.gitleaksPath,
  });

  const result = await service.delegate({
    profile: "repo-read",
    task: "Read README.md and return the first line.",
    dryRun: false,
    repositoryRoot: fixture.repo,
    expectedSourceHead: fixture.head,
    allowedReadPaths: ["README.md"],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.envelope.workerStarted, true);
  assert.equal(result.envelope.resolvedModel, "gemini-3.8-flash-high");
  assert.equal(result.envelope.expectedSourceHead, fixture.head);
  assert.equal(result.envelope.sourceHead, fixture.head);
  assert.equal(result.envelope.changedPersistentPaths.length, 0);
  assert.equal(result.response, "hello\n");
});

macTest("repo-read prompt binds the worker to the exact disposable snapshot root", async (t) => {
  const fixture = await delegationFixture(t, "gemini-3.8-flash-high");
  const service = new AgyDelegationService({
    config: fixture.config,
    gitleaksPath: fixture.gitleaksPath,
  });

  const result = await service.delegate({
    profile: "repo-read",
    task: "Read README.md.",
    dryRun: false,
    repositoryRoot: fixture.repo,
    expectedSourceHead: fixture.head,
    allowedReadPaths: ["README.md"],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const prompts = await fixture.prompts();
  assert.match(prompts, /Exact delegated workspace root: .*devspace-agy-repo-.*\/snapshot/);
  assert.match(prompts, /Do not search or access parent or sibling paths/);
});

macTest("model mismatch returns a typed failure and never invokes a fallback executor", async (t) => {
  const fixture = await delegationFixture(t, "gemini-3.8-flash-low");
  const service = new AgyDelegationService({
    config: fixture.config,
    gitleaksPath: fixture.gitleaksPath,
  });
  const result = await service.delegate({
    profile: "repo-read",
    task: "Read README.md.",
    dryRun: false,
    repositoryRoot: fixture.repo,
    expectedSourceHead: fixture.head,
    allowedReadPaths: ["README.md"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.envelope.failureClass, "MODEL_MISMATCH");
  assert.equal(result.envelope.workerStarted, true);
  assert.equal(await fixture.invocations(), 1);
});

macTest("repo-validate runs declared validation in the disposable snapshot before read-only analysis", async (t) => {
  const fixture = await delegationFixture(t, "gemini-3.8-flash-high");
  const service = new AgyDelegationService({
    config: fixture.config,
    gitleaksPath: fixture.gitleaksPath,
  });
  const result = await service.delegate({
    profile: "repo-validate",
    task: "Report whether the declared validation passed.",
    dryRun: false,
    repositoryRoot: fixture.repo,
    expectedSourceHead: fixture.head,
    allowedReadPaths: ["README.md", "package.json"],
    validationCommands: [{ argv: ["npm", "test"] }],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.validationReceipts?.length, 1);
  assert.equal(result.validationReceipts?.[0]?.exitCode, 0);
  assert.equal(result.validationReceipts?.[0]?.sandboxed, true);
  assert.equal(result.envelope.changedPersistentPaths.length, 0);
});

macTest("gui-inspect redacts sensitive AX content and brokers one semantic action before returning a final answer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-gui-delegation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const promptsPath = join(root, "prompts.txt");
  const invocationsPath = join(root, "invocations.txt");
  const actionPath = join(root, "actions.txt");
  const agyPath = join(root, "agy");
  await writeFile(agyPath, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  --version) echo 1.1.22; exit 0;;",
    "  --help) printf '%s\\n' --model --effort --output-format --mode --sandbox --print; exit 0;;",
    "esac",
    `printf '%s\\n' \"$2\" >> ${JSON.stringify(promptsPath)}`,
    `printf '%s\\n' invoked >> ${JSON.stringify(invocationsPath)}`,
    `count=$(wc -l < ${JSON.stringify(invocationsPath)} | tr -d ' ')`,
    "printf '%s\\n' '{\"event\":\"init\",\"init\":{\"model\":\"gemini-3.8-flash-high\"}}'",
    "if [ \"$count\" = \"1\" ]; then",
    "  printf '%s\\n' '{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"{\\\"kind\\\":\\\"intent\\\",\\\"intent\\\":{\\\"type\\\":\\\"select_existing_tab\\\",\\\"elementIndex\\\":11}}\"}}'",
    "else",
    "  printf '%s\\n' '{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"{\\\"kind\\\":\\\"final\\\",\\\"answer\\\":\\\"pins inspected\\\"}\"}}'",
    "fi",
    "",
  ].join("\n"));
  await chmod(agyPath, 0o700);

  const cuaPath = join(root, "cua-driver");
  await writeFile(cuaPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"list_windows\" ]; then printf '%s\\n' '{\"windows\":[{\"window_id\":100,\"pid\":42,\"app_name\":\"ChatGPT\",\"title\":\"ChatGPT\"}]}'; exit 0; fi",
    "if [ \"$1\" = \"get_window_state\" ]; then printf '%s\\n' '{\"snapshot_id\":\"s12345678\",\"elements\":[{\"element_index\":1,\"role\":\"AXStaticText\",\"label\":\"SECRET_BODY\",\"value\":\"SECRET_VALUE\"},{\"element_index\":11,\"role\":\"AXTab\",\"label\":\"Pinned\"}]}'; exit 0; fi",
    `if [ \"$1\" = \"click\" ]; then printf '%s\\n' \"$2\" >> ${JSON.stringify(actionPath)}; printf '%s\\n' '{}'; exit 0; fi`,
    "exit 2",
    "",
  ].join("\n"));
  await chmod(cuaPath, 0o700);

  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ enableTelemetry: false }));
  const service = new AgyDelegationService({
    config: {
      enabled: true,
      agyPath,
      cuaDriverPath: cuaPath,
      settingsPath,
      ...currentAgyPolicy,
    },
    gitleaksPath: "/usr/bin/true",
  });

  const result = await service.delegate({
    profile: "gui-inspect",
    task: "Inspect the pinned chats area without exposing conversation content.",
    dryRun: false,
    target: { pid: 42, applicationIdentity: "ChatGPT", windowId: 100 },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.response, "pins inspected");
  assert.equal(result.envelope.workerStarted, true);
  const prompts = await readFile(promptsPath, "utf8");
  assert.equal(prompts.includes("SECRET_BODY"), false);
  assert.equal(prompts.includes("SECRET_VALUE"), false);
  assert.match(prompts, /Pinned/);
  assert.equal((await readFile(invocationsPath, "utf8")).trim().split("\n").length, 2);
  assert.match(await readFile(actionPath, "utf8"), /"element_index":11/);
});

async function delegationFixture(t: TestContext, model: string): Promise<{
  repo: string;
  head: string;
  config: {
    enabled: boolean;
    agyPath: string;
    cuaDriverPath: string;
    settingsPath: string;
    model: string;
    effort: string;
    compatibleVersions: string;
  };
  gitleaksPath: string;
  invocations: () => Promise<number>;
  prompts: () => Promise<string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-delegation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "hello\n");
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "printf validation-ok" } }));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "devspace@example.com"]);
  await git(repo, ["config", "user.name", "DevSpace Test"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })).stdout.trim();

  const invocationsPath = join(root, "invocations.txt");
  const promptsPath = join(root, "prompts.txt");
  const agyPath = join(root, "agy");
  await writeFile(agyPath, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  --version) echo 1.1.22; exit 0;;",
    "  --help) printf '%s\\n' --model --effort --output-format --mode --sandbox --print; exit 0;;",
    "esac",
    `printf '%s\\n' invoked >> ${JSON.stringify(invocationsPath)}`,
    `printf '%s\\n' "$2" >> ${JSON.stringify(promptsPath)}`,
    `printf '%s\\n' '{\"event\":\"init\",\"init\":{\"model\":\"${model}\"}}'`,
    "printf '%s\\n' '{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"hello\\n\"}}'",
    "",
  ].join("\n"));
  await chmod(agyPath, 0o700);

  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ enableTelemetry: false }));
  const gitleaksPath = join(root, "gitleaks");
  await writeFile(gitleaksPath, "#!/bin/sh\nexit 0\n");
  await chmod(gitleaksPath, 0o700);

  return {
    repo,
    head,
    config: {
      enabled: true,
      agyPath,
      cuaDriverPath: join(root, "cua-driver"),
      settingsPath,
      ...currentAgyPolicy,
    },
    gitleaksPath,
    invocations: async () => {
      try {
        return (await readFile(invocationsPath, "utf8")).trim().split("\n").filter(Boolean).length;
      } catch (error) {
        return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
          ? 0
          : Promise.reject(error);
      }
    },
    prompts: async () => readFile(promptsPath, "utf8"),
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
