export const AGY_REQUIRED_MODEL = "gemini-3.8-flash-high" as const;
export const AGY_REQUIRED_EFFORT = "high" as const;

export type AgyProfile = "repo-read" | "repo-validate" | "gui-inspect";

export type AgyFailureClass =
  | "POLICY_DENIED"
  | "AGY_UNAVAILABLE"
  | "AGY_START_FAILED"
  | "MODEL_MISMATCH"
  | "MODEL_UNVERIFIED"
  | "EFFORT_MISMATCH"
  | "SOURCE_HEAD_MISMATCH"
  | "RUNTIME_STATE_POLICY_UNENFORCEABLE"
  | "TELEMETRY_POLICY_UNENFORCEABLE"
  | "TIMEOUT"
  | "EXECUTOR_FAILURE"
  | "SCOPE_VIOLATION"
  | "VALIDATION_FAILED"
  | "NETWORK_POLICY_DENIED"
  | "GUI_ACTION_UNCLASSIFIED"
  | "GUI_CAPABILITY_DENIED"
  | "GUI_SENSITIVE_VIEW_DENIED"
  | "EVIDENCE_INCOMPLETE";

export interface AgyDelegationConfig {
  enabled: boolean;
  agyPath: string;
  cuaDriverPath: string;
  settingsPath: string;
}

export interface AgyPlatformStages {
  toolSurfaceRegistered: boolean;
  toolCallAccepted: boolean;
  requestReachedDevspace: boolean;
  policyPreflightPassed: boolean;
  workerStarted: boolean;
}

export interface AgyRuntimePolicy {
  trustedCliAuthentication: "cached-auth-internal-only";
  sessionState: "task-local-no-resume";
  telemetryEnabled: false;
  settingsMutated: false;
}

export interface AgyExecutionEnvelope extends AgyPlatformStages {
  schemaVersion: 1;
  executionId: string;
  profile: AgyProfile;
  dryRun: boolean;
  requestedModel: typeof AGY_REQUIRED_MODEL;
  resolvedModel?: string;
  requestedEffort: typeof AGY_REQUIRED_EFFORT;
  effortSelectionVerified: boolean;
  workerStarted: boolean;
  failureClass?: AgyFailureClass;
}

export class AgyDelegationError extends Error {
  constructor(
    readonly code: AgyFailureClass,
    message: string,
  ) {
    super(message);
    this.name = "AgyDelegationError";
  }
}
