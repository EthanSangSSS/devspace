import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { runAgyHeadless } from "./agy-runner.js";
import {
  runValidationCommands,
  type ValidationCommandSpec,
  type ValidationReceipt,
} from "./agy-validation.js";
import {
  AgyGuiBroker,
  CuaDriverClient,
  type GuiIntent,
  type GuiTarget,
  type SanitizedGuiSnapshot,
} from "./agy-gui.js";

export interface AgyRepositoryDelegationRequest {
  profile: "repo-read" | "repo-validate";
  task: string;
  dryRun: boolean;
  repositoryRoot: string;
  expectedSourceHead: string;
  allowedReadPaths: string[];
  validationCommands?: ValidationCommandSpec[];
}

export interface AgyGuiDelegationRequest {
  profile: "gui-inspect";
  task: string;
  dryRun: boolean;
  target: GuiTarget;
}

export type AgyDelegationRequest = AgyRepositoryDelegationRequest | AgyGuiDelegationRequest;

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
  requestedModel: string;
  resolvedModel?: string;
  requestedEffort: string;
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

  async delegate(request: AgyDelegationRequest): Promise<AgyDelegationResult> {
    if (request.profile === "gui-inspect") return this.delegateGui(request);

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
      requestedModel: this.options.config.model,
      requestedEffort: this.options.config.effort,
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
        model: this.options.config.model,
        effort: this.options.config.effort,
        cwd: snapshot.root,
        taskRoot: snapshot.taskRoot,
        prompt: buildRepositoryPrompt(request, snapshot.root, validationReceipts),
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

  private async delegateGui(request: AgyGuiDelegationRequest): Promise<AgyDelegationResult> {
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
      requestedModel: this.options.config.model,
      requestedEffort: this.options.config.effort,
      effortSelectionVerified: false,
      changedPersistentPaths: [],
    };
    let taskRoot: string | undefined;
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

      const broker = new AgyGuiBroker(
        new CuaDriverClient(this.options.config.cuaDriverPath),
        { foregroundPolicy: this.options.config.guiForegroundPolicy },
      );
      let snapshot = await broker.observe(request.target);
      envelope.policyPreflightPassed = true;
      if (request.dryRun) return { ok: true, envelope };

      taskRoot = await mkdtemp(join(tmpdir(), "devspace-agy-gui-"));
      for (let actionCount = 0; actionCount <= 4; actionCount += 1) {
        workerAttempted = true;
        envelope.workerStarted = true;
        const run = await runAgyHeadless({
          agyPath: this.options.config.agyPath,
          model: this.options.config.model,
          effort: this.options.config.effort,
          cwd: taskRoot,
          taskRoot,
          prompt: buildGuiPrompt(request.task, snapshot),
          timeoutMs: 5 * 60_000,
          jsonSchema: GUI_RESPONSE_SCHEMA,
        });
        envelope.resolvedModel = run.resolvedModel;
        envelope.effortSelectionVerified = run.effortSelectionVerified;
        const response = parseGuiAgentResponse(run.response);
        if (response.kind === "final") {
          return { ok: true, envelope, response: response.answer };
        }
        if (actionCount === 4) {
          throw new AgyDelegationError("GUI_CAPABILITY_DENIED", "GUI action ceiling exceeded before a final answer.");
        }
        snapshot = await broker.execute(request.target, response.intent);
      }
      throw new AgyDelegationError("EVIDENCE_INCOMPLETE", "GUI delegation ended without a final answer.");
    } catch (error) {
      const typed = error instanceof AgyDelegationError
        ? error
        : new AgyDelegationError("EXECUTOR_FAILURE", error instanceof Error ? error.message : String(error));
      envelope.failureClass = typed.code;
      if (typed.code === "AGY_START_FAILED") envelope.workerStarted = false;
      else if (workerAttempted) envelope.workerStarted = true;
      return { ok: false, envelope };
    } finally {
      if (taskRoot) await rm(taskRoot, { recursive: true, force: true });
    }
  }
}

function buildRepositoryPrompt(
  request: AgyRepositoryDelegationRequest,
  workspaceRoot: string,
  validationReceipts?: ValidationReceipt[],
): string {
  const validation = validationReceipts?.length
    ? `\nValidation was executed by DevSpace under a network-denied sandbox. Read-only receipts are in .devspace-validation/validation-receipts.json. Do not execute commands yourself.`
    : "";
  return [
    "You are operating inside a disposable, bounded repository snapshot.",
    `Exact delegated workspace root: ${workspaceRoot}`,
    "Do not search or access parent or sibling paths. Resolve every repository read/search path inside that exact root.",
    "Use only read/search tools. Do not write files, run commands, browse the web, call MCP tools, or access paths outside this workspace.",
    `Task: ${request.task}`,
    validation,
  ].filter(Boolean).join("\n");
}

type GuiAgentResponse =
  | { kind: "final"; answer: string }
  | { kind: "intent"; intent: GuiIntent };

const GUI_RESPONSE_SCHEMA = JSON.stringify({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "answer"],
      properties: {
        kind: { const: "final" },
        answer: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "intent"],
      properties: {
        kind: { const: "intent" },
        intent: { type: "object" },
      },
    },
  ],
});

function buildGuiPrompt(task: string, snapshot: SanitizedGuiSnapshot): string {
  return [
    "You are inspecting one exact GUI window through a capability broker.",
    "You can only return a final answer or one semantic intent from: open_transient_menu, close_transient_menu, select_existing_tab, toggle_disclosure, scroll_within_approved_target.",
    "Do not request raw clicks, pixel coordinates, text entry, submit/save/send/delete/install/purchase/upload/download, settings changes, authentication changes, shell commands, browser navigation, or any other action.",
    `Task: ${task}`,
    `Sanitized AX snapshot: ${JSON.stringify(snapshot)}`,
  ].join("\n");
}

function parseGuiAgentResponse(raw: string): GuiAgentResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AgyDelegationError("EVIDENCE_INCOMPLETE", "Agy GUI response was not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgyDelegationError("EVIDENCE_INCOMPLETE", "Agy GUI response must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "final" && typeof record.answer === "string") {
    return { kind: "final", answer: record.answer };
  }
  if (record.kind !== "intent" || !record.intent || typeof record.intent !== "object" || Array.isArray(record.intent)) {
    throw new AgyDelegationError("GUI_ACTION_UNCLASSIFIED", "Agy GUI response did not contain a supported semantic intent.");
  }
  const intent = record.intent as Record<string, unknown>;
  switch (intent.type) {
    case "close_transient_menu":
      return { kind: "intent", intent: { type: "close_transient_menu" } };
    case "open_transient_menu":
    case "select_existing_tab":
    case "toggle_disclosure": {
      if (!Number.isInteger(intent.elementIndex)) {
        throw new AgyDelegationError("GUI_ACTION_UNCLASSIFIED", "Semantic GUI intent requires an integer elementIndex.");
      }
      return {
        kind: "intent",
        intent: { type: intent.type, elementIndex: intent.elementIndex as number },
      };
    }
    case "scroll_within_approved_target": {
      if (!Number.isInteger(intent.elementIndex)
        || !Number.isInteger(intent.amount)
        || !["up", "down", "left", "right"].includes(String(intent.direction))
        || !["line", "page"].includes(String(intent.by))) {
        throw new AgyDelegationError("GUI_ACTION_UNCLASSIFIED", "Scroll intent fields are invalid.");
      }
      return {
        kind: "intent",
        intent: {
          type: "scroll_within_approved_target",
          elementIndex: intent.elementIndex as number,
          direction: intent.direction as "up" | "down" | "left" | "right",
          amount: intent.amount as number,
          by: intent.by as "line" | "page",
        },
      };
    }
    default:
      throw new AgyDelegationError("GUI_ACTION_UNCLASSIFIED", "Agy requested an unsupported GUI intent.");
  }
}
