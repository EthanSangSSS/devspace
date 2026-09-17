import assert from "node:assert/strict";
import test from "node:test";
import type { RolloutOutcome } from "../src/macos-launchd-rollout.js";
import {
  executeRolloutScriptCommand,
  formatRolloutOutcome,
  parseRolloutScriptArgs,
} from "./devspace-macos-rollout.js";

test("operator parser accepts only the fixed qualify and rollout surfaces", () => {
  assert.deepEqual(parseRolloutScriptArgs(["qualify"]), { mode: "qualify" });

  const candidate = "/Users/ethan/candidate/node_modules/@waishnav/devspace/dist/cli.js";
  const live = "/Users/ethan/live/node_modules/@waishnav/devspace/dist/cli.js";
  const parsed = parseRolloutScriptArgs([
    "rollout",
    "--expected-live-entrypoint", live,
    "--expected-live-plist-sha256", "a".repeat(64),
    "--candidate-entrypoint", candidate,
    "--candidate-slot-manifest-sha256", "b".repeat(64),
  ]);
  assert.deepEqual(parsed, {
    mode: "rollout",
    request: {
      expectedLiveEntrypoint: live,
      expectedLivePlistSha256: "a".repeat(64),
      candidateEntrypoint: candidate,
      candidateSlotManifestSha256: "b".repeat(64),
    },
  });

  for (const argv of [
    ["qualify", "--label", "com.ethan.devspace"],
    ["qualify", "--port", "7676"],
    ["rollout", "--expected-live-entrypoint", "relative/cli.js"],
    [
      "rollout",
      "--expected-live-entrypoint", live,
      "--expected-live-plist-sha256", "not-a-sha",
      "--candidate-entrypoint", candidate,
      "--candidate-slot-manifest-sha256", "b".repeat(64),
    ],
    ["rollout", "--label", "other"],
    ["unknown"],
  ]) {
    assert.throws(() => parseRolloutScriptArgs(argv), /usage|unknown|absolute|sha-256|qualify/i, argv.join(" "));
  }
});

test("operator output is bounded to the public rollout outcome contract", () => {
  const outcome: RolloutOutcome = {
    code: "ROLLOUT_OK",
    transactionId: "tx-1",
    transactionNonce: "nonce-1",
    committed: true,
    controlledReload: "PASS",
    persistenceStaticContract: "PASS",
    rebootRecovery: "UNVERIFIED",
    evidence: {
      safe: "value",
      secretLikeExtra: undefined,
    },
  };
  const text = formatRolloutOutcome(outcome);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "code",
    "committed",
    "controlledReload",
    "evidence",
    "persistenceStaticContract",
    "rebootRecovery",
    "transactionId",
    "transactionNonce",
  ].sort());
  assert.equal(parsed.code, "ROLLOUT_OK");
});

test("thin wrapper delegates qualify and rollout commands without owning state-machine logic", async () => {
  const output: string[] = [];
  const calls: string[] = [];
  const qualification = {
    ok: true as const,
    macosVersion: "27.0",
    label: "com.ethan.devspace.rollout-qualification.test",
    port: 49123,
    lockf: "PASS" as const,
    durability: "PASS" as const,
    launchd: "PASS" as const,
    printDisabled: "PASS" as const,
    processIdentity: "PASS" as const,
    listener: "PASS" as const,
    health: "PASS" as const,
    stopBarrier: "PASS" as const,
    cleanup: "PASS" as const,
  };
  const rolloutOutcome: RolloutOutcome = {
    code: "ROLLOUT_OK",
    transactionId: "tx",
    transactionNonce: "nonce",
    committed: true,
    controlledReload: "PASS",
    persistenceStaticContract: "PASS",
    rebootRecovery: "UNVERIFIED",
    evidence: {},
  };
  const deps = {
    async qualify() { calls.push("qualify"); return qualification; },
    async rollout() { calls.push("rollout"); return rolloutOutcome; },
    write(text: string) { output.push(text); },
  };

  assert.equal(await executeRolloutScriptCommand({ mode: "qualify" }, deps), 0);
  assert.deepEqual(calls, ["qualify"]);
  assert.equal(JSON.parse(output.at(-1)!).label, qualification.label);

  const request = {
    expectedLiveEntrypoint: "/live/node_modules/@waishnav/devspace/dist/cli.js",
    expectedLivePlistSha256: "a".repeat(64),
    candidateEntrypoint: "/candidate/node_modules/@waishnav/devspace/dist/cli.js",
    candidateSlotManifestSha256: "b".repeat(64),
  };
  assert.equal(await executeRolloutScriptCommand({ mode: "rollout", request }, deps), 0);
  assert.deepEqual(calls, ["qualify", "rollout"]);
  assert.equal(JSON.parse(output.at(-1)!).code, "ROLLOUT_OK");
});
