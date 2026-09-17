import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { satisfies, valid, validRange } from "semver";
import {
  AgyDelegationError,
  type AgyDelegationConfig,
  type AgyRuntimePolicy,
} from "./agy-delegation-types.js";

const execFileAsync = promisify(execFile);
const REQUIRED_FLAGS = [
  "--model",
  "--effort",
  "--output-format",
  "--mode",
  "--sandbox",
  "--print",
] as const;
const FORBIDDEN_REAL_RUN_FLAGS = [
  "--continue",
  "-c",
  "--conversation",
  "--dangerously-skip-permissions",
] as const;

export interface AgyRuntimeInspection {
  runtimeStatus: "available";
  agyPath: string;
  agyVersion: string;
  agyExecutableSha256: string;
  requiredModel: string;
  requiredEffort: string;
  compatibleVersions: string;
  requiredFlagsSupported: boolean;
  resolvedModelTelemetry: "available";
  trustedCliAuthMode: "cached-auth-required";
  telemetryEnabled: boolean;
  telemetryDisableEnforcement: "available" | "unavailable";
  taskLocalSessionEnforcement: "available";
  hostSettingsMutationRequired: boolean;
  workerStarted: false;
}

export interface AgyStreamResult {
  resolvedModel: string;
  status: "SUCCESS";
  response: string;
}

export async function inspectAgyRuntime(
  config: AgyDelegationConfig,
): Promise<AgyRuntimeInspection> {
  await assertOwnedExecutable(config.agyPath);
  const executableBytes = await readFile(config.agyPath);
  const agyExecutableSha256 = createHash("sha256").update(executableBytes).digest("hex");

  const [{ stdout: versionOutput }, { stdout: helpStdout, stderr: helpStderr }] = await Promise.all([
    execFileAsync(config.agyPath, ["--version"], { encoding: "utf8", timeout: 5_000 }),
    execFileAsync(config.agyPath, ["--help"], { encoding: "utf8", timeout: 5_000 }),
  ]).catch((error: unknown) => {
    throw new AgyDelegationError(
      "AGY_UNAVAILABLE",
      `Unable to inspect configured Agy executable: ${errorMessage(error)}`,
    );
  });

  const helpOutput = `${helpStdout}\n${helpStderr}`;
  const agyVersion = versionOutput.trim();
  assertQualifiedAgyVersion(agyVersion, config.compatibleVersions);
  const requiredFlagsSupported = REQUIRED_FLAGS.every((flag) => helpOutput.includes(flag));
  const telemetryEnabled = await readTelemetryEnabled(config.settingsPath);

  return {
    runtimeStatus: "available",
    agyPath: config.agyPath,
    agyVersion,
    agyExecutableSha256,
    requiredModel: config.model,
    requiredEffort: config.effort,
    compatibleVersions: config.compatibleVersions,
    requiredFlagsSupported,
    resolvedModelTelemetry: "available",
    trustedCliAuthMode: "cached-auth-required",
    telemetryEnabled,
    telemetryDisableEnforcement: telemetryEnabled ? "unavailable" : "available",
    taskLocalSessionEnforcement: "available",
    hostSettingsMutationRequired: telemetryEnabled,
    workerStarted: false,
  };
}

export async function preflightAgyRealRun(
  config: AgyDelegationConfig,
): Promise<AgyRuntimePolicy> {
  const telemetryEnabled = await readTelemetryEnabled(config.settingsPath);
  if (telemetryEnabled) {
    throw new AgyDelegationError(
      "TELEMETRY_POLICY_UNENFORCEABLE",
      "Agy telemetry must already be disabled in persistent settings; DevSpace will not mutate host settings for a delegated run.",
    );
  }

  return {
    trustedCliAuthentication: "cached-auth-internal-only",
    sessionState: "task-local-no-resume",
    telemetryEnabled: false,
    settingsMutated: false,
  };
}

export function verifyAgyCommandArguments(
  args: readonly string[],
  policy: Pick<AgyDelegationConfig, "model" | "effort">,
): void {
  for (const flag of FORBIDDEN_REAL_RUN_FLAGS) {
    if (args.includes(flag)) {
      throw new AgyDelegationError(
        "RUNTIME_STATE_POLICY_UNENFORCEABLE",
        `Forbidden Agy session/permission flag present: ${flag}`,
      );
    }
  }

  requireExactOption(args, "--model", policy.model, "MODEL_MISMATCH");
  requireExactOption(args, "--effort", policy.effort, "EFFORT_MISMATCH");
  requireExactOption(args, "--output-format", "stream-json", "EVIDENCE_INCOMPLETE");
  if (!args.includes("--sandbox")) {
    throw new AgyDelegationError("POLICY_DENIED", "Agy real runs must enable --sandbox.");
  }
}

export function parseAgyStream(
  lines: readonly string[],
  expectedModel: string,
): AgyStreamResult {
  const events = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new AgyDelegationError("EVIDENCE_INCOMPLETE", "Agy stream contained malformed JSON.");
      }
    });

  const initEvents = events.filter((event) => event.event === "init");
  const resultEvents = events.filter((event) => event.event === "result");
  if (initEvents.length !== 1 || resultEvents.length !== 1) {
    throw new AgyDelegationError(
      "EVIDENCE_INCOMPLETE",
      "Agy stream must contain exactly one init event and one terminal result event.",
    );
  }

  const init = asRecord(initEvents[0]?.init);
  const resolvedModel = init?.model;
  if (typeof resolvedModel !== "string" || resolvedModel.length === 0) {
    throw new AgyDelegationError("MODEL_UNVERIFIED", "Agy init event did not report a model.");
  }
  if (resolvedModel !== expectedModel) {
    throw new AgyDelegationError(
      "MODEL_MISMATCH",
      `Agy resolved model ${resolvedModel} does not match required ${expectedModel}.`,
    );
  }

  const result = asRecord(resultEvents[0]?.result);
  if (!result || result.status !== "SUCCESS") {
    throw new AgyDelegationError(
      "EXECUTOR_FAILURE",
      `Agy terminal status was ${typeof result?.status === "string" ? result.status : "unverified"}.`,
    );
  }
  if (typeof result.response !== "string") {
    throw new AgyDelegationError("EVIDENCE_INCOMPLETE", "Agy result did not contain response text.");
  }

  return {
    resolvedModel,
    status: "SUCCESS",
    response: result.response,
  };
}

function assertQualifiedAgyVersion(version: string, compatibleVersions: string): void {
  const parsedVersion = valid(version);
  const parsedRange = validRange(compatibleVersions);
  if (!parsedVersion || !parsedRange || !satisfies(parsedVersion, parsedRange)) {
    throw new AgyDelegationError(
      "AGY_VERSION_UNQUALIFIED",
      `Agy version ${version || "unverified"} is not qualified by configured range ${compatibleVersions}.`,
    );
  }
}

async function assertOwnedExecutable(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
    await access(path, fsConstants.X_OK);
  } catch (error) {
    throw new AgyDelegationError(
      "AGY_UNAVAILABLE",
      `Configured Agy executable is unavailable: ${errorMessage(error)}`,
    );
  }
  if (!metadata.isFile()) {
    throw new AgyDelegationError("AGY_UNAVAILABLE", "Configured Agy path is not a regular file.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new AgyDelegationError("POLICY_DENIED", "Configured Agy executable is not owned by the current user.");
  }
}

async function readTelemetryEnabled(settingsPath: string): Promise<boolean> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.enableTelemetry !== false;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw new AgyDelegationError(
      "RUNTIME_STATE_POLICY_UNENFORCEABLE",
      `Unable to verify Agy telemetry setting: ${errorMessage(error)}`,
    );
  }
}

function requireExactOption(
  args: readonly string[],
  option: string,
  requiredValue: string,
  failure: "MODEL_MISMATCH" | "EFFORT_MISMATCH" | "EVIDENCE_INCOMPLETE",
): void {
  const positions = args.flatMap((value, index) => value === option ? [index] : []);
  if (positions.length !== 1 || args[(positions[0] ?? -1) + 1] !== requiredValue) {
    throw new AgyDelegationError(failure, `${option} must be set exactly once to ${requiredValue}.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
