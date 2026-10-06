import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { AgyDelegationConfig, AgyProfile } from "./agy-delegation-types.js";
import {
  AGY_CANDIDATE_SOURCE_ADAPTER_ID,
  AGY_CANDIDATE_SOURCE_ADAPTER_REVISION,
  AGY_DARWIN_ARM64_MANIFEST_URL,
  assertOfficialAgyCandidateArtifactUrl,
  isCanonicalSemVer,
} from "./agy-candidate-source.js";

export const AGY_QUALIFICATION_RECEIPT_SCHEMA_VERSION = 1 as const;
export const AGY_QUALIFICATION_REVISION = 1 as const;

export type AgyQualificationStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "UNVERIFIED";
export type AgyQualificationEvidenceScope =
  | "NONE"
  | "CONFIGURED"
  | "OBSERVED"
  | "BEHAVIORALLY_VERIFIED";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const sha512Schema = z.string().regex(/^[0-9a-f]{128}$/);
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const profileSchema = z.enum(["repo-read", "repo-validate", "gui-inspect"]);
const gateNameSchema = z.enum([
  "artifact-integrity",
  "executable-identity",
  "platform-signature",
  "static-cli-contract",
  "auto-update-isolation",
  "runtime-policy",
  "stream-protocol",
  "profile:repo-read",
  "profile:repo-validate",
  "profile:gui-inspect",
]);
const statusSchema = z.enum(["PASS", "FAIL", "INCONCLUSIVE", "UNVERIFIED"]);
const evidenceScopeSchema = z.enum([
  "NONE",
  "CONFIGURED",
  "OBSERVED",
  "BEHAVIORALLY_VERIFIED",
]);
const behaviorallyVerifiedGateNames = new Set([
  "auto-update-isolation",
  "runtime-policy",
  "stream-protocol",
  "profile:repo-read",
  "profile:repo-validate",
  "profile:gui-inspect",
]);
const requiredPassGateNames = [
  "artifact-integrity",
  "executable-identity",
  "platform-signature",
  "static-cli-contract",
  "auto-update-isolation",
  "runtime-policy",
  "stream-protocol",
] as const;

const gateSchema = z.object({
  gate: gateNameSchema,
  status: statusSchema,
  evidenceScope: evidenceScopeSchema,
  evidenceDigestSha256: sha256Schema.optional(),
  detail: z.string().min(1).max(1_000).optional(),
}).strict().superRefine((gate, context) => {
  if (gate.status === "PASS" && gate.evidenceScope === "NONE") {
    context.addIssue({
      code: "custom",
      path: ["evidenceScope"],
      message: "PASS requires evidence beyond NONE",
    });
  }
  if (
    gate.status === "PASS"
    && behaviorallyVerifiedGateNames.has(gate.gate)
    && gate.evidenceScope !== "BEHAVIORALLY_VERIFIED"
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidenceScope"],
      message: `${gate.gate} PASS requires BEHAVIORALLY_VERIFIED evidence`,
    });
  }
  if (
    gate.status === "PASS"
    && !behaviorallyVerifiedGateNames.has(gate.gate)
    && (gate.evidenceScope === "NONE" || gate.evidenceScope === "CONFIGURED")
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidenceScope"],
      message: `${gate.gate} PASS requires observed or behavioral evidence`,
    });
  }
});

const receiptSchema = z.object({
  schemaVersion: z.literal(AGY_QUALIFICATION_RECEIPT_SCHEMA_VERSION),
  source: z.object({
    adapterId: z.literal(AGY_CANDIDATE_SOURCE_ADAPTER_ID),
    adapterRevision: z.literal(AGY_CANDIDATE_SOURCE_ADAPTER_REVISION),
    manifestUrl: z.literal(AGY_DARWIN_ARM64_MANIFEST_URL),
    metadataSha256: sha256Schema,
    discoveredAt: z.string().refine(isIsoTimestamp, "discoveredAt must be an ISO-8601 timestamp"),
  }).strict(),
  candidate: z.object({
    version: z.string().min(1).refine(isCanonicalSemVer, "candidate version must be canonical SemVer"),
    platform: z.literal("darwin"),
    architecture: z.literal("arm64"),
    manifestPlatform: z.literal("darwin_arm64"),
    artifactUrl: z.string().url(),
    upstreamPackageSha512: sha512Schema,
    executableSha256: sha256Schema,
  }).strict().superRefine((candidate, context) => {
    try {
      assertOfficialAgyCandidateArtifactUrl(candidate.artifactUrl, candidate.version);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["artifactUrl"],
        message: "candidate artifact URL does not match the reviewed source contract",
      });
    }
  }),
  qualification: z.object({
    revision: z.literal(AGY_QUALIFICATION_REVISION),
    devspaceSourceCommit: gitShaSchema,
    policyFingerprintSha256: sha256Schema,
    result: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    attemptedProfiles: z.array(profileSchema).min(1),
    qualifiedProfiles: z.array(profileSchema),
    gates: z.array(gateSchema).min(1),
    qualifiedAt: z.string().refine(isIsoTimestamp, "qualifiedAt must be an ISO-8601 timestamp"),
  }).strict(),
}).strict().superRefine((receipt, context) => {
  const profiles = receipt.qualification.qualifiedProfiles;
  if (new Set(profiles).size !== profiles.length) {
    context.addIssue({
      code: "custom",
      path: ["qualification", "qualifiedProfiles"],
      message: "qualifiedProfiles must be unique",
    });
  }

  const attemptedProfiles = receipt.qualification.attemptedProfiles;
  if (new Set(attemptedProfiles).size !== attemptedProfiles.length) {
    context.addIssue({
      code: "custom",
      path: ["qualification", "attemptedProfiles"],
      message: "attemptedProfiles must be unique",
    });
  }
  for (const profile of profiles) {
    if (!attemptedProfiles.includes(profile)) {
      context.addIssue({
        code: "custom",
        path: ["qualification", "qualifiedProfiles"],
        message: `qualified profile ${profile} was not attempted`,
      });
    }
  }

  const gates = receipt.qualification.gates;
  const gateNames = gates.map((gate) => gate.gate);
  if (new Set(gateNames).size !== gateNames.length) {
    context.addIssue({
      code: "custom",
      path: ["qualification", "gates"],
      message: "qualification gates must be unique",
    });
  }

  if (receipt.qualification.result === "PASS") {
    const nonPass = gates.find((gate) => gate.status !== "PASS");
    if (nonPass) {
      context.addIssue({
        code: "custom",
        path: ["qualification", "result"],
        message: `PASS receipt cannot contain non-PASS gate ${nonPass.gate}`,
      });
    }
    for (const requiredGate of requiredPassGateNames) {
      if (!gates.some((gate) => gate.gate === requiredGate && gate.status === "PASS")) {
        context.addIssue({
          code: "custom",
          path: ["qualification", "result"],
          message: `PASS receipt is missing required gate ${requiredGate}`,
        });
      }
    }
  }

  for (const profile of attemptedProfiles) {
    if (!gates.some((gate) => gate.gate === `profile:${profile}`)) {
      context.addIssue({
        code: "custom",
        path: ["qualification", "attemptedProfiles"],
        message: `attempted profile ${profile} requires a recorded profile gate`,
      });
    }
  }

  for (const gate of gates) {
    if (!gate.gate.startsWith("profile:")) continue;
    const profile = gate.gate.slice("profile:".length) as AgyProfile;
    if (!attemptedProfiles.includes(profile)) {
      context.addIssue({
        code: "custom",
        path: ["qualification", "gates"],
        message: `profile gate ${gate.gate} was not attempted`,
      });
    }
    if (
      gate.status === "PASS"
      && gate.evidenceScope === "BEHAVIORALLY_VERIFIED"
      && !profiles.includes(profile)
    ) {
      context.addIssue({
        code: "custom",
        path: ["qualification", "qualifiedProfiles"],
        message: `behaviorally verified profile ${profile} must be listed as qualified`,
      });
    }
  }

  for (const profile of profiles) {
    const gate = gates.find((candidate) => candidate.gate === `profile:${profile}`);
    if (!gate || gate.status !== "PASS" || gate.evidenceScope !== "BEHAVIORALLY_VERIFIED") {
      context.addIssue({
        code: "custom",
        path: ["qualification", "qualifiedProfiles"],
        message: `qualified profile ${profile} requires a behaviorally verified PASS gate`,
      });
    }
  }
});

export type AgyQualificationReceipt = z.output<typeof receiptSchema>;
export type AgyQualificationGate = AgyQualificationReceipt["qualification"]["gates"][number];

export function parseAgyQualificationReceipt(value: unknown): AgyQualificationReceipt {
  return receiptSchema.parse(value);
}

export function buildAgyQualificationPolicyFingerprint(
  policy: Pick<AgyDelegationConfig, "model" | "effort" | "compatibleVersions" | "guiForegroundPolicy">,
  attemptedProfiles: readonly AgyProfile[],
): string {
  const profiles = [...new Set(attemptedProfiles)].sort();
  const canonical = JSON.stringify({
    compatibleVersions: policy.compatibleVersions,
    effort: policy.effort,
    guiForegroundPolicy: policy.guiForegroundPolicy,
    model: policy.model,
    profiles,
    qualificationRevision: AGY_QUALIFICATION_REVISION,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}
