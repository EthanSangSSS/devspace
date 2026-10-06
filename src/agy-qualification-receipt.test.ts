import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgyQualificationPolicyFingerprint,
  parseAgyQualificationReceipt,
} from "./agy-qualification-receipt.js";

const basePolicy = {
  model: "gemini-3.8-flash-high",
  effort: "high",
  compatibleVersions: ">=1.1.22 <1.2.0",
  guiForegroundPolicy: "deny" as const,
};

const validReceipt = {
  schemaVersion: 1,
  source: {
    adapterId: "google-antigravity-platform-manifest",
    adapterRevision: 1,
    manifestUrl: "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json",
    metadataSha256: "1".repeat(64),
    discoveredAt: "2026-10-06T05:55:00.000Z",
  },
  candidate: {
    version: "1.3.0",
    platform: "darwin",
    architecture: "arm64",
    manifestPlatform: "darwin_arm64",
    artifactUrl: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.0-6233328509124608/darwin-arm/cli_mac_arm64.tar.gz",
    upstreamPackageSha512: "a".repeat(128),
    executableSha256: "2".repeat(64),
  },
  qualification: {
    revision: 1,
    devspaceSourceCommit: "3".repeat(40),
    policyFingerprintSha256: buildAgyQualificationPolicyFingerprint(basePolicy, ["repo-read"]),
    result: "PASS",
    attemptedProfiles: ["repo-read"],
    qualifiedProfiles: ["repo-read"],
    gates: [
      { gate: "artifact-integrity", status: "PASS", evidenceScope: "OBSERVED" },
      { gate: "executable-identity", status: "PASS", evidenceScope: "OBSERVED" },
      { gate: "platform-signature", status: "PASS", evidenceScope: "OBSERVED" },
      { gate: "static-cli-contract", status: "PASS", evidenceScope: "OBSERVED" },
      { gate: "auto-update-isolation", status: "PASS", evidenceScope: "BEHAVIORALLY_VERIFIED" },
      { gate: "runtime-policy", status: "PASS", evidenceScope: "BEHAVIORALLY_VERIFIED" },
      { gate: "stream-protocol", status: "PASS", evidenceScope: "BEHAVIORALLY_VERIFIED" },
      { gate: "profile:repo-read", status: "PASS", evidenceScope: "BEHAVIORALLY_VERIFIED" },
    ],
    qualifiedAt: "2026-10-06T06:00:00.000Z",
  },
};

test("qualification receipt preserves exact artifact identity and evidence scope", () => {
  const receipt = parseAgyQualificationReceipt(validReceipt);

  assert.equal(receipt.candidate.version, "1.3.0");
  assert.equal(receipt.candidate.upstreamPackageSha512, "a".repeat(128));
  assert.equal(receipt.candidate.executableSha256, "2".repeat(64));
  assert.deepEqual(receipt.qualification.qualifiedProfiles, ["repo-read"]);
  assert.equal(
    receipt.qualification.gates.find((gate) => gate.gate === "auto-update-isolation")?.evidenceScope,
    "BEHAVIORALLY_VERIFIED",
  );
});

test("policy fingerprint is deterministic across profile ordering but changes with policy", () => {
  const first = buildAgyQualificationPolicyFingerprint(basePolicy, ["repo-validate", "repo-read"]);
  const reordered = buildAgyQualificationPolicyFingerprint(basePolicy, ["repo-read", "repo-validate"]);
  const duplicate = buildAgyQualificationPolicyFingerprint(basePolicy, ["repo-read", "repo-validate", "repo-read"]);
  const changedModel = buildAgyQualificationPolicyFingerprint(
    { ...basePolicy, model: "another-model" },
    ["repo-read", "repo-validate"],
  );

  assert.equal(first, reordered);
  assert.equal(first, duplicate);
  assert.notEqual(first, changedModel);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("qualified profile requires a behaviorally verified matching gate", () => {
  const weak = structuredClone(validReceipt);
  const profileGate = weak.qualification.gates.find((gate) => gate.gate === "profile:repo-read");
  assert.ok(profileGate);
  profileGate.evidenceScope = "OBSERVED";

  assert.throws(
    () => parseAgyQualificationReceipt(weak),
    /qualified profile repo-read requires a behaviorally verified PASS gate/,
  );
});

test("attempted profiles are explicit and every attempt requires a recorded gate", () => {
  const missingGate = structuredClone(validReceipt);
  missingGate.qualification.attemptedProfiles.push("repo-validate");
  assert.throws(
    () => parseAgyQualificationReceipt(missingGate),
    /attempted profile repo-validate requires a recorded profile gate/,
  );

  const unattemptedQualified = structuredClone(validReceipt);
  unattemptedQualified.qualification.qualifiedProfiles = ["repo-validate"];
  assert.throws(
    () => parseAgyQualificationReceipt(unattemptedQualified),
    /qualified profile repo-validate was not attempted/,
  );
});

test("profile gates cannot exist for profiles that were not attempted", () => {
  for (const [status, evidenceScope, result] of [
    ["PASS", "BEHAVIORALLY_VERIFIED", "PASS"],
    ["FAIL", "NONE", "INCONCLUSIVE"],
    ["UNVERIFIED", "NONE", "INCONCLUSIVE"],
  ] as const) {
    const invalid = structuredClone(validReceipt);
    invalid.qualification.result = result;
    invalid.qualification.gates.push({
      gate: "profile:gui-inspect",
      status,
      evidenceScope,
    });
    assert.throws(
      () => parseAgyQualificationReceipt(invalid),
      /profile gate profile:gui-inspect was not attempted/,
    );
  }
});

test("behaviorally verified profile gates and qualifiedProfiles cannot disagree", () => {
  const underclaimed = structuredClone(validReceipt);
  underclaimed.qualification.qualifiedProfiles = [];
  assert.throws(
    () => parseAgyQualificationReceipt(underclaimed),
    /behaviorally verified profile repo-read must be listed as qualified/,
  );
});

test("PASS receipt cannot contain failed, inconclusive, or unverified gates", () => {
  for (const status of ["FAIL", "INCONCLUSIVE", "UNVERIFIED"] as const) {
    const invalid = structuredClone(validReceipt);
    invalid.qualification.gates[0]!.status = status;
    assert.throws(
      () => parseAgyQualificationReceipt(invalid),
      /PASS receipt cannot contain non-PASS gate artifact-integrity/,
    );
  }
});

test("PASS receipt requires the complete reviewed core gate set", () => {
  for (const gateName of [
    "artifact-integrity",
    "executable-identity",
    "platform-signature",
    "static-cli-contract",
    "auto-update-isolation",
    "runtime-policy",
    "stream-protocol",
  ] as const) {
    const invalid = structuredClone(validReceipt);
    invalid.qualification.gates = invalid.qualification.gates.filter((gate) => gate.gate !== gateName);
    assert.throws(
      () => parseAgyQualificationReceipt(invalid),
      new RegExp(`PASS receipt is missing required gate ${gateName}`),
    );
  }
});

test("PASS gate cannot claim evidence when evidence scope is NONE", () => {
  const invalid = structuredClone(validReceipt);
  invalid.qualification.gates[0]!.evidenceScope = "NONE";
  assert.throws(
    () => parseAgyQualificationReceipt(invalid),
    /PASS requires evidence beyond NONE/,
  );
});

test("behavioral gates cannot be promoted from configured or observed evidence", () => {
  for (const gateName of [
    "auto-update-isolation",
    "runtime-policy",
    "stream-protocol",
    "profile:repo-read",
  ] as const) {
    for (const evidenceScope of ["CONFIGURED", "OBSERVED"] as const) {
      const invalid = structuredClone(validReceipt);
      const gate = invalid.qualification.gates.find((candidate) => candidate.gate === gateName);
      assert.ok(gate);
      gate.evidenceScope = evidenceScope;
      assert.throws(
        () => parseAgyQualificationReceipt(invalid),
        new RegExp(`${gateName} PASS requires BEHAVIORALLY_VERIFIED evidence`),
      );
    }
  }
});

test("receipt rejects duplicate profile and gate claims", () => {
  const duplicateAttempt = structuredClone(validReceipt);
  duplicateAttempt.qualification.attemptedProfiles.push("repo-read");
  assert.throws(() => parseAgyQualificationReceipt(duplicateAttempt), /attemptedProfiles must be unique/);

  const duplicateProfile = structuredClone(validReceipt);
  duplicateProfile.qualification.qualifiedProfiles.push("repo-read");
  assert.throws(() => parseAgyQualificationReceipt(duplicateProfile), /qualifiedProfiles must be unique/);

  const duplicateGate = structuredClone(validReceipt);
  duplicateGate.qualification.gates.push({ ...duplicateGate.qualification.gates[0]! });
  assert.throws(() => parseAgyQualificationReceipt(duplicateGate), /qualification gates must be unique/);
});

test("receipt is strict about identity and unknown top-level fields", () => {
  const badExecutable = structuredClone(validReceipt);
  badExecutable.candidate.executableSha256 = "not-a-digest";
  assert.throws(() => parseAgyQualificationReceipt(badExecutable));

  const extra = { ...validReceipt, productionEligible: true };
  assert.throws(() => parseAgyQualificationReceipt(extra));
});

test("receipt rejects non-canonical SemVer but preserves valid prerelease and build metadata", () => {
  for (const version of ["v1.3.0", " 1.3.0 "]) {
    const invalid = structuredClone(validReceipt);
    invalid.candidate.version = version;
    assert.throws(
      () => parseAgyQualificationReceipt(invalid),
      /candidate version must be canonical SemVer/,
    );
  }

  for (const version of [
    "1.3.0-alpha.1",
    "1.3.0+build.5",
    "1.3.0-alpha.1+build.5",
  ]) {
    const receipt = structuredClone(validReceipt);
    receipt.candidate.version = version;
    receipt.candidate.artifactUrl = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-release/darwin-arm/cli_mac_arm64.tar.gz`;
    assert.equal(parseAgyQualificationReceipt(receipt).candidate.version, version);
  }
});

test("receipt timestamps require an explicit timezone", () => {
  const localTime = structuredClone(validReceipt);
  localTime.source.discoveredAt = "2026-10-06T05:55:00";
  assert.throws(() => parseAgyQualificationReceipt(localTime), /discoveredAt must be an ISO-8601 timestamp/);
});
