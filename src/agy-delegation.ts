import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AGY_REQUIRED_EFFORT,
  AGY_REQUIRED_MODEL,
  AgyDelegationError,
  type AgyDelegationConfig,
  type AgyFailureClass,
  type AgyProfile,
} from "./agy-delegation-types.js";
import {
  disposeAgyRepositorySnapshot,
  fingerprintRepository,
  prepareAgyRepositorySnapshot,
  verifySourceUnchanged,
  type AgyRepositorySnapshot,
} from "./agy-repository.js";
import { inspectAgyRuntime, preflightAgyRealRun } from "./agy-runtime.js";
import { installAgyReadOnlyHookPolicy, runAgyHeadless } from "./agy-runner.js";
import {
  runValidationCommands,
  type ValidationCommandSpec,
  type ValidationReceipt,
} from "./agy-validation.js";

export interface AgyRepositoryDelegationRequest {
  profile: "repo-read" | "repo-validate";
  task: string;
  dryRun: boolean;
  repositoryRoot: string;
  expectedSourceHead: string;
  allowedReadPaths: string[];
  validationCommands?: ValidationCommandSpec[];
}

export interface AgyDelegationEnvelope {
  schemaVersion: 1;
  executionId: string;
  profile: AgyProfile;
  dryRun: boolean;
  toolSurfaceRegistered: true;
  toolCallAccepted: true;
  requestReachedDevspace: true;
  policyPreflightPassed: boolean;
  workerStarted: boolean;
  requestedModel: typeof AGY_REQUIRED_MODEL;
  resolvedModel?: string;
  requestedEffort: typeof AGY_REQUIRED_EFFORT;
  effortSelectionVerified: boolean;
  expectedSourceHead?: string;
  sourceHead?: string;
  sourceFingerprintBefore?: string;
  sourceFingerprintAfter?: string;
  changedPersistentPaths: string[];
  runtimeTelemetryEnabled?: boolean;
  runtimeSessionState?: "task-local-no-resume";
  failureClass?: AgyFailureClass;
}

export type AgyDelegationResult =
  | {
      ok: true;
      envelope: AgyDelegationEnvelope;
      response?: string;
      validationReceipts?: ValidationReceipt[];
    }
  | {
      ok: false;
      envelope: AgyDelegationEnvelope;
    };

export interface AgyDelegationServiceOptions {
  config: AgyDelegationConfig;
  gitleaksPath: string;
}

export class AgyDelegationService {
  constructor(private readonly options: AgyDelegationServiceOptions) {}

  async inspectRuntime() {
    if (!this.options.config.enabled) {
      throw new AgyDelegationError("POLICY_DENIED", "Declarative Agy delegation is disabled.");
    }
    return inspectAgyRuntime(this.options.config);
  }

  async delegate(request: AgyRepositoryDelegationRequest): Promise<AgyDelegationResult> {
    const envelope: AgyDelegationEnvelope = {
      schemaVersion: 1,
      executionId: randomUUID(),
      profile: request.profile,
      dryRun: request.dryRun,
      toolSurfaceRegistered: true,
      toolCallAccepted: true,
      requestReachedDevspace: true,
      policyPreflightPassed: false,
      workerStarted: false,
      requestedModel: AGY_REQUIRED_MODEL,
      requestedEffort: AGY_REQUIRED_EFFORT,
      effortSelectionVerified: false,
      expectedSourceHead: request.expectedSourceHead,
      changedPersistentPaths: [],
    };
    let snapshot: AgyRepositorySnapshot | undefined;
    let workerAttempted = false;

    try {
      if (!this.options.config.enabled) {
        throw new AgyDelegationError("POLICY_DENIED", "Declarative Agy delegation is disabled.");
      }
      const runtime = await inspectAgyRuntime(this.options.config);
      if (!runtime.requiredFlagsSupported) {
        throw new AgyDelegationError("AGY_UNAVAILABLE", "Configured Agy runtime lacks required V1 flags.");
      }
      const runtimePolicy = await preflightAgyRealRun(this.options.config);
      envelope.runtimeTelemetryEnabled = runtimePolicy.telemetryEnabled;
      envelope.runtimeSessionState = runtimePolicy.sessionState;

      snapshot = await prepareAgyRepositorySnapshot({
        repositoryRoot: request.repositoryRoot,
        expectedSourceHead: request.expectedSourceHead,
        allowedReadPaths: request.allowedReadPaths,
        gitleaksPath: this.options.gitleaksPath,
      });
      envelope.sourceHead = snapshot.sourceHead;
      envelope.sourceFingerprintBefore = snapshot.sourceFingerprintBefore;

      if (request.profile === "repo-validate" && (request.validationCommands?.length ?? 0) === 0) {
        throw new AgyDelegationError("POLICY_DENIED", "repo-validate requires at least one declared validation command.");
      }

      envelope.policyPreflightPassed = true;
      if (request.dryRun) {
        envelope.sourceFingerprintAfter = await fingerprintRepository(snapshot.repositoryRoot);
        return { ok: true, envelope };
      }

      await installAgyReadOnlyHookPolicy(snapshot.root);
      let validationReceipts: ValidationReceipt[] | undefined;
      if (request.profile === "repo-validate") {
        const artifacts = join(snapshot.root, ".devspace-validation");
        const home = join(snapshot.taskRoot, "validation-home");
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        validationReceipts = await runValidationCommands(
          request.validationCommands!,
          { workspace: snapshot.root, home, artifacts, timeoutMs: 120_000 },
        );
      }

      workerAttempted = true;
      envelope.workerStarted = true;
      const run = await runAgyHeadless({
        agyPath: this.options.config.agyPath,
        cwd: snapshot.root,
        taskRoot: snapshot.taskRoot,
        prompt: buildRepositoryPrompt(request, validationReceipts),
        timeoutMs: 5 * 60_000,
      });
      envelope.resolvedModel = run.resolvedModel;
      envelope.effortSelectionVerified = run.effortSelectionVerified;
      await verifySourceUnchanged(snapshot);
      envelope.sourceFingerprintAfter = await fingerprintRepository(snapshot.repositoryRoot);
      return {
        ok: true,
        envelope,
        response: run.response,
        validationReceipts,
      };
    } catch (error) {
      const typed = error instanceof AgyDelegationError
        ? error
        : new AgyDelegationError("EXECUTOR_FAILURE", error instanceof Error ? error.message : String(error));
      envelope.failureClass = typed.code;
      if (typed.code === "AGY_START_FAILED") envelope.workerStarted = false;
      else if (workerAttempted) envelope.workerStarted = true;
      if (snapshot) {
        try {
          envelope.sourceFingerprintAfter = await fingerprintRepository(snapshot.repositoryRoot);
        } catch {
          // Preserve the primary typed failure. Missing after-evidence remains visible by omission.
        }
      }
      return { ok: false, envelope };
    } finally {
      if (snapshot) await disposeAgyRepositorySnapshot(snapshot);
    }
  }
}

function buildRepositoryPrompt(
  request: AgyRepositoryDelegationRequest,
  validationReceipts?: ValidationReceipt[],
): string {
  const validation = validationReceipts?.length
    ? `\nValidation was executed by DevSpace under a network-denied sandbox. Read-only receipts are in .devspace-validation/validation-receipts.json. Do not execute commands yourself.`
    : "";
  return [
    "You are operating inside a disposable, bounded repository snapshot.",
    "Use only read/search tools. Do not write files, run commands, browse the web, call MCP tools, or access paths outside this workspace.",
    `Task: ${request.task}`,
    validation,
  ].filter(Boolean).join("\n");
}
