import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  AGY_REQUIRED_EFFORT,
  AGY_REQUIRED_MODEL,
  AgyDelegationError,
} from "./agy-delegation-types.js";
import { parseAgyStream, verifyAgyCommandArguments } from "./agy-runtime.js";

const execFileAsync = promisify(execFile);
const AGY_PATH_ENV = "/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const RETRYABLE_STREAM_INTERRUPTION = "The stream was interrupted. Please continue the task you were working on.";

export interface AgyHeadlessRunInput {
  agyPath: string;
  cwd: string;
  taskRoot: string;
  prompt: string;
  timeoutMs: number;
  jsonSchema?: string;
  hostKeychainPath?: string;
}

export interface AgyHeadlessRunResult {
  resolvedModel: string;
  response: string;
  status: "SUCCESS";
  effortSelectionVerified: true;
  runtimeHome: string;
  logPath: string;
}

export interface InstalledAgyHookPolicy {
  hooksPath: string;
  hookPath: string;
}

export async function runAgyHeadless(input: AgyHeadlessRunInput): Promise<AgyHeadlessRunResult> {
  const runtimeHome = join(input.taskRoot, "agy-home");
  const runtimeTmp = join(input.taskRoot, "agy-tmp");
  const configDir = join(runtimeHome, ".gemini", "antigravity-cli");
  const logPath = join(input.taskRoot, "agy.log");
  const canonicalCwd = await realpath(input.cwd);
  await Promise.all([
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(runtimeTmp, { recursive: true, mode: 0o700 }),
  ]);
  const hostKeychainPath = input.hostKeychainPath ?? defaultHostKeychainPath();
  if (hostKeychainPath) {
    await projectHostLoginKeychain(runtimeHome, hostKeychainPath);
  }
  await installAgyReadOnlyHookPolicy(canonicalCwd, runtimeHome);
  await writeFile(
    join(configDir, "settings.json"),
    `${JSON.stringify({
      enableTelemetry: false,
      permissions: {
        allow: [`read_file(${canonicalCwd})`],
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
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const args = [
    "--print", input.prompt,
    "--model", AGY_REQUIRED_MODEL,
    "--effort", AGY_REQUIRED_EFFORT,
    "--output-format", "stream-json",
    "--mode", "plan",
    "--sandbox",
    "--disable-slash-commands",
    "--log-file", logPath,
    ...(input.jsonSchema ? ["--json-schema", input.jsonSchema] : []),
  ];
  const fixedPolicy = { model: AGY_REQUIRED_MODEL, effort: AGY_REQUIRED_EFFORT };
  verifyAgyCommandArguments(args, fixedPolicy);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let stdout: string;
    try {
      const result = await execFileAsync(input.agyPath, args, {
        cwd: input.cwd,
        env: buildAgyEnvironment(runtimeHome, runtimeTmp),
        encoding: "utf8",
        timeout: input.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      const captured = childText(error, "stdout");
      if (captured.trim()) {
        try {
          parseAgyStream(captured.split(/\r?\n/), AGY_REQUIRED_MODEL);
        } catch (parsedError) {
          if (parsedError instanceof AgyDelegationError
            && ["MODEL_MISMATCH", "MODEL_UNVERIFIED"].includes(parsedError.code)) {
            throw parsedError;
          }
        }
      }
      if (isTimeout(error)) {
        throw new AgyDelegationError("TIMEOUT", "Agy headless execution timed out.");
      }
      const code = childExitCode(error);
      throw new AgyDelegationError(
        code === undefined ? "AGY_START_FAILED" : "EXECUTOR_FAILURE",
        `Agy headless execution failed${code === undefined ? "" : ` with exit code ${code}`}.`,
      );
    }

    try {
      const parsed = parseAgyStream(stdout.split(/\r?\n/), AGY_REQUIRED_MODEL);
      return {
        resolvedModel: parsed.resolvedModel,
        response: parsed.response,
        status: parsed.status,
        effortSelectionVerified: true,
        runtimeHome,
        logPath,
      };
    } catch (error) {
      if (attempt === 0 && isRetryableStreamInterruption(stdout, error)) continue;
      throw error;
    }
  }

  throw new AgyDelegationError("EXECUTOR_FAILURE", "Agy headless execution exhausted its retry budget.");
}

function isRetryableStreamInterruption(stdout: string, error: unknown): boolean {
  if (!(error instanceof AgyDelegationError) || error.code !== "EXECUTOR_FAILURE") return false;
  const resultEvents = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.event === "result" ? [event] : [];
      } catch {
        return [];
      }
    });
  if (resultEvents.length !== 1) return false;
  const result = resultEvents[0]?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const terminal = result as Record<string, unknown>;
  return terminal.status === "ERROR" && terminal.error === RETRYABLE_STREAM_INTERRUPTION;
}

function defaultHostKeychainPath(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  return join(homedir(), "Library", "Keychains", "login.keychain-db");
}

async function projectHostLoginKeychain(runtimeHome: string, hostKeychainPath: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(hostKeychainPath);
  } catch {
    throw new AgyDelegationError(
      "RUNTIME_STATE_POLICY_UNENFORCEABLE",
      "Trusted cached-auth keychain is unavailable.",
    );
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!metadata.isFile() || metadata.isSymbolicLink() || (currentUid !== undefined && metadata.uid !== currentUid)) {
    throw new AgyDelegationError(
      "RUNTIME_STATE_POLICY_UNENFORCEABLE",
      "Trusted cached-auth keychain must be a user-owned regular file.",
    );
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new AgyDelegationError(
      "RUNTIME_STATE_POLICY_UNENFORCEABLE",
      "Trusted cached-auth keychain must not be group- or world-writable.",
    );
  }

  const keychainDir = join(runtimeHome, "Library", "Keychains");
  const projectedKeychainPath = join(keychainDir, "login.keychain-db");
  await mkdir(keychainDir, { recursive: true, mode: 0o700 });
  try {
    const projected = await lstat(projectedKeychainPath);
    if (projected.isSymbolicLink() && await readlink(projectedKeychainPath) === hostKeychainPath) return;
    throw new AgyDelegationError(
      "RUNTIME_STATE_POLICY_UNENFORCEABLE",
      "Task-local cached-auth keychain projection already exists with unexpected identity.",
    );
  } catch (error) {
    if (error instanceof AgyDelegationError) throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  await symlink(hostKeychainPath, projectedKeychainPath);
}

export async function installAgyReadOnlyHookPolicy(
  workspace: string,
  runtimeHome: string,
): Promise<InstalledAgyHookPolicy> {
  const canonicalWorkspace = await realpath(workspace);
  const hooksDir = join(runtimeHome, ".gemini", "config");
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const hookPath = join(hooksDir, "devspace-readonly-hook.mjs");
  const hooksPath = join(hooksDir, "hooks.json");
  await writeFile(hookPath, buildReadOnlyHookSource(canonicalWorkspace), { encoding: "utf8", mode: 0o700 });
  await chmod(hookPath, 0o700);
  await writeFile(
    hooksPath,
    `${JSON.stringify({
      "devspace-v1-readonly": {
        PreToolUse: [{
          matcher: "*",
          hooks: [{
            type: "command",
            command: `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`,
            timeout: 5,
          }],
        }],
      },
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { hooksPath, hookPath };
}

function buildAgyEnvironment(home: string, tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: tmp,
    PATH: AGY_PATH_ENV,
    TERM: "dumb",
    LC_ALL: "C",
    LANG: "C",
    ANTIGRAVITY_DISABLE_AUTO_UPDATE: "1",
    AGY_DISABLE_AUTO_UPDATE: "1",
    DISABLE_AUTO_UPDATER: "1",
  };
  for (const name of [
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
    "USER", "LOGNAME",
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function childExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function childText(error: unknown, key: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object" || !(key in error)) return "";
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function isTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (
    ("killed" in error && (error as { killed?: unknown }).killed === true)
    || ("signal" in error && (error as { signal?: unknown }).signal === "SIGTERM")
  ));
}

function buildReadOnlyHookSource(workspace: string): string {
  return String.raw`import fs from "node:fs";
import path from "node:path";

const ROOT = ${JSON.stringify(workspace)};

const ALLOWED = new Set([
  "view_file",
  "read_file",
  "list_dir",
  "list_directory",
  "grep_search",
  "find_by_name",
  "search_files",
  "codebase_search",
]);

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  console.log(JSON.stringify({ decision: "deny", reason: "DevSpace V1 hook input was invalid." }));
  process.exit(0);
}

const name = input?.toolCall?.name;
const args = input?.toolCall?.args ?? {};

if (!ALLOWED.has(name)) {
  console.log(JSON.stringify({ decision: "deny", reason: "DevSpace V1 denies non-read or unknown tools." }));
  process.exit(0);
}

const strings = [];
const collect = (value) => {
  if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) value.forEach(collect);
  else if (value && typeof value === "object") Object.values(value).forEach(collect);
};
collect(args);

for (const value of strings) {
  if (value.includes("\0") || /(^|[\\/])\.\.([\\/]|$)/.test(value)) {
    console.log(JSON.stringify({ decision: "deny", reason: "DevSpace V1 denies escaping read paths." }));
    process.exit(0);
  }
  if (path.isAbsolute(value)) {
    let target;
    try {
      target = fs.realpathSync.native(value);
    } catch {
      target = path.resolve(value);
    }
    const inside = target === ROOT || target.startsWith(ROOT + path.sep);
    if (!inside) {
      console.log(JSON.stringify({ decision: "deny", reason: "DevSpace V1 denies reads outside the delegated workspace." }));
      process.exit(0);
    }
  }
}

console.log(JSON.stringify({ decision: "allow", reason: "DevSpace V1 bounded read." }));
`;
}
