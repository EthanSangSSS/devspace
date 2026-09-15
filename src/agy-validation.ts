import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AgyDelegationError } from "./agy-delegation-types.js";

const execFileAsync = promisify(execFile);
const VALIDATION_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const NPM_SCRIPTS = new Set(["test", "build", "lint", "typecheck"]);

export interface ValidationCommandSpec {
  argv: string[];
}

export interface ValidatedCommand {
  argv: string[];
  executable: string;
}

export interface ValidationReceipt {
  index: number;
  argv: string[];
  executable: string;
  sandboxed: true;
  exitCode: number;
  durationMs: number;
  stdoutArtifact: string;
  stderrArtifact: string;
}

export interface ValidationContext {
  workspace: string;
  home: string;
  artifacts: string;
  timeoutMs: number;
}

export function validateValidationCommand(
  argv: readonly string[],
  workspace: string,
): ValidatedCommand {
  if (argv.length === 0 || argv.some((part) => part.includes("\0"))) {
    throw new AgyDelegationError("POLICY_DENIED", "Validation argv must be non-empty and contain no NUL bytes.");
  }

  const command = argv[0]!;
  if (command === "npm") {
    const valid = argv.length === 2 && argv[1] === "test"
      || argv.length === 3 && argv[1] === "run" && NPM_SCRIPTS.has(argv[2]!);
    if (!valid) deny(argv);
  } else if (command === "flutter") {
    if (!(argv.length === 2 && argv[1] === "test")) deny(argv);
  } else {
    deny(argv);
  }

  const executable = resolveExecutable(command);
  const resolvedWorkspace = resolve(workspace);
  if (!resolvedWorkspace) deny(argv);
  return { argv: [...argv], executable };
}

export async function writeValidationSandbox(input: {
  workspace: string;
  home: string;
  tmp: string;
  output: string;
}): Promise<void> {
  const workspace = sandboxLiteral(resolve(input.workspace));
  const home = sandboxLiteral(resolve(input.home));
  const tmp = sandboxLiteral(resolve(input.tmp));
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(deny network*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    "(allow file-read*)",
    '(deny file-read* (subpath "/Users"))',
    '(deny file-read* (subpath "/private/tmp"))',
    '(deny file-read* (subpath "/private/var/tmp"))',
    '(deny file-read* (subpath "/Volumes"))',
    `(allow file-read* (subpath "${workspace}"))`,
    `(allow file-read* (subpath "${home}"))`,
    `(allow file-read* (subpath "${tmp}"))`,
    '(allow file-read* (subpath "/opt/homebrew"))',
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/Library"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* (subpath "${workspace}"))`,
    `(allow file-write* (subpath "${home}"))`,
    `(allow file-write* (subpath "${tmp}"))`,
    "",
  ].join("\n");
  await writeFile(input.output, profile, { encoding: "utf8", mode: 0o600 });
}

export async function runValidationCommands(
  commands: readonly ValidationCommandSpec[],
  context: ValidationContext,
): Promise<ValidationReceipt[]> {
  if (process.platform !== "darwin") {
    throw new AgyDelegationError("NETWORK_POLICY_DENIED", "Authoritative V1 validation isolation requires macOS sandbox-exec.");
  }
  await access("/usr/bin/sandbox-exec", fsConstants.X_OK).catch(() => {
    throw new AgyDelegationError("NETWORK_POLICY_DENIED", "sandbox-exec is unavailable.");
  });

  const tmp = join(context.home, "tmp");
  await Promise.all([
    mkdir(context.home, { recursive: true, mode: 0o700 }),
    mkdir(tmp, { recursive: true, mode: 0o700 }),
    mkdir(context.artifacts, { recursive: true, mode: 0o700 }),
  ]);
  const env: NodeJS.ProcessEnv = {
    HOME: context.home,
    TMPDIR: tmp,
    PATH: VALIDATION_PATH,
    TERM: "dumb",
    LC_ALL: "C",
    CI: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    npm_config_update_notifier: "false",
    npm_config_cache: join(context.home, ".npm"),
  };

  const receipts: ValidationReceipt[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const validated = validateValidationCommand(commands[index]!.argv, context.workspace);
    const sandboxPath = join(context.artifacts, `validation-${index + 1}.sb`);
    const stdoutArtifact = `validation-${index + 1}.stdout`;
    const stderrArtifact = `validation-${index + 1}.stderr`;
    await writeValidationSandbox({ workspace: context.workspace, home: context.home, tmp, output: sandboxPath });

    const startedAt = performance.now();
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(
        "/usr/bin/sandbox-exec",
        ["-f", sandboxPath, validated.executable, ...validated.argv.slice(1)],
        {
          cwd: context.workspace,
          env,
          encoding: "utf8",
          timeout: context.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      exitCode = childExitCode(error) ?? 1;
      stdout = childOutput(error, "stdout");
      stderr = childOutput(error, "stderr");
    }
    await Promise.all([
      writeFile(join(context.artifacts, stdoutArtifact), stdout, { encoding: "utf8", mode: 0o600 }),
      writeFile(join(context.artifacts, stderrArtifact), stderr, { encoding: "utf8", mode: 0o600 }),
    ]);
    const receipt: ValidationReceipt = {
      index: index + 1,
      argv: [...validated.argv],
      executable: validated.executable,
      sandboxed: true,
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
      stdoutArtifact,
      stderrArtifact,
    };
    receipts.push(receipt);
    if (exitCode !== 0) {
      await writeReceipts(context.artifacts, receipts);
      throw new AgyDelegationError(
        "VALIDATION_FAILED",
        `Validation command ${index + 1} exited with code ${exitCode}.`,
      );
    }
  }

  await writeReceipts(context.artifacts, receipts);
  return receipts;
}

function resolveExecutable(command: string): string {
  if (isAbsolute(command)) return command;
  for (const directory of VALIDATION_PATH.split(delimiter)) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new AgyDelegationError("VALIDATION_FAILED", `Validation executable is unavailable: ${command}`);
}

function deny(argv: readonly string[]): never {
  throw new AgyDelegationError("POLICY_DENIED", `Validation command is outside the V1 allowlist: ${argv.join(" ")}`);
}

function sandboxLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function writeReceipts(artifacts: string, receipts: ValidationReceipt[]): Promise<void> {
  await writeFile(
    join(artifacts, "validation-receipts.json"),
    `${JSON.stringify(receipts, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function childExitCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function childOutput(error: unknown, key: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object" || !(key in error)) return "";
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
}
