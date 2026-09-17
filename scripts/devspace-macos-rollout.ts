import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runMacosLaunchdRollout,
  type RolloutOutcome,
  type RolloutRequest,
} from "../src/macos-launchd-rollout.js";
import {
  createDarwinRolloutAdapters,
  qualifyDarwinRolloutEnvironment,
  type DarwinQualificationResult,
} from "../src/macos-launchd-rollout-darwin.js";

export type ScriptCommand =
  | { mode: "qualify" }
  | { mode: "rollout"; request: RolloutRequest };

export interface RolloutScriptDependencies {
  qualify(): Promise<DarwinQualificationResult>;
  rollout(request: RolloutRequest): Promise<RolloutOutcome>;
  write(text: string): void;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function parseRolloutScriptArgs(argv: string[]): ScriptCommand {
  const [mode, ...rest] = argv;
  if (mode === "qualify") {
    if (rest.length !== 0) throw new Error("qualify accepts no label, port, or topology overrides");
    return { mode: "qualify" };
  }
  if (mode !== "rollout") throw usageError();

  const values = parseExactFlags(rest, new Set([
    "--expected-live-entrypoint",
    "--expected-live-plist-sha256",
    "--candidate-entrypoint",
    "--candidate-slot-manifest-sha256",
  ]));
  const expectedLiveEntrypoint = requireFlag(values, "--expected-live-entrypoint");
  const expectedLivePlistSha256 = requireFlag(values, "--expected-live-plist-sha256");
  const candidateEntrypoint = requireFlag(values, "--candidate-entrypoint");
  const candidateSlotManifestSha256 = requireFlag(values, "--candidate-slot-manifest-sha256");

  if (!isAbsolute(expectedLiveEntrypoint) || !isAbsolute(candidateEntrypoint)) {
    throw new Error("rollout entrypoints must be absolute paths");
  }
  if (!SHA256_RE.test(expectedLivePlistSha256) || !SHA256_RE.test(candidateSlotManifestSha256)) {
    throw new Error("rollout SHA-256 values must be lowercase 64-hex strings");
  }
  return {
    mode: "rollout",
    request: {
      expectedLiveEntrypoint,
      expectedLivePlistSha256,
      candidateEntrypoint,
      candidateSlotManifestSha256,
    },
  };
}

export function formatRolloutOutcome(outcome: RolloutOutcome): string {
  return `${JSON.stringify({
    code: outcome.code,
    transactionId: outcome.transactionId,
    transactionNonce: outcome.transactionNonce,
    committed: outcome.committed,
    controlledReload: outcome.controlledReload,
    persistenceStaticContract: outcome.persistenceStaticContract,
    rebootRecovery: outcome.rebootRecovery,
    evidence: outcome.evidence,
  })}\n`;
}

export async function executeRolloutScriptCommand(
  command: ScriptCommand,
  dependencies: RolloutScriptDependencies,
): Promise<number> {
  if (command.mode === "qualify") {
    const result = await dependencies.qualify();
    dependencies.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  const outcome = await dependencies.rollout(command.request);
  dependencies.write(formatRolloutOutcome(outcome));
  return outcome.code === "ROLLOUT_OK" ? 0 : 2;
}

function parseExactFlags(argv: string[], allowed: Set<string>): Map<string, string> {
  if (argv.length % 2 !== 0) throw usageError();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1]!;
    if (!allowed.has(flag)) throw new Error(`unknown rollout flag: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate rollout flag: ${flag}`);
    if (!value || value.startsWith("--")) throw usageError();
    values.set(flag, value);
  }
  return values;
}

function requireFlag(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw usageError();
  return value;
}

function usageError(): Error {
  return new Error(
    "usage: devspace-macos-rollout qualify | rollout --expected-live-entrypoint <absolute> --expected-live-plist-sha256 <sha256> --candidate-entrypoint <absolute> --candidate-slot-manifest-sha256 <sha256>",
  );
}

async function main(): Promise<void> {
  const command = parseRolloutScriptArgs(process.argv.slice(2));
  const exitCode = await executeRolloutScriptCommand(command, {
    qualify: qualifyDarwinRolloutEnvironment,
    rollout: (request) => runMacosLaunchdRollout(request, createDarwinRolloutAdapters()),
    write: (text) => process.stdout.write(text),
  });
  process.exitCode = exitCode;
}

function isDirectExecution(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  return pathToFileURL(script).href === import.meta.url;
}

if (isDirectExecution()) {
  void main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
