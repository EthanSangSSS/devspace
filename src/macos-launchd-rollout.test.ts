import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRollbackRefusal,
  type ObservedState,
  type RollbackClassificationInput,
} from "./macos-launchd-rollout.js";

const known = <T>(value: T): ObservedState<T> => ({ kind: "known", value });
const unproven = <T>(reason: string): ObservedState<T> => ({ kind: "unproven", reason });

function rollbackState(
  overrides: Partial<RollbackClassificationInput> = {},
): RollbackClassificationInput {
  return {
    canonical: known("expected"),
    runtime: known("expected"),
    listener: known("expected"),
    lock: known("owned"),
    ownerRecord: known("ours"),
    ...overrides,
  };
}

test("rollback refusal taxonomy is deterministic and drift-first", async () => {
  const cases = [
    {
      name: "canonical hash drift is concrete drift",
      input: rollbackState({ canonical: known("drift") }),
      expected: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "valid owner nonce mismatch is concrete drift",
      input: rollbackState({ ownerRecord: known("drift") }),
      expected: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "unreadable owner record is unproven",
      input: rollbackState({ ownerRecord: unproven("read failed") }),
      expected: "ROLLBACK_REFUSED_UNPROVEN_STATE",
    },
    {
      name: "positive concrete drift outranks another unproven observation",
      input: rollbackState({
        canonical: known("drift"),
        ownerRecord: unproven("read failed"),
      }),
      expected: "ROLLBACK_REFUSED_CONCURRENT_DRIFT",
    },
    {
      name: "confirmed candidate absence is not a refusal",
      input: rollbackState({ runtime: known("absent"), listener: known("unowned") }),
      expected: undefined,
    },
  ] as const;

  for (const entry of cases) {
    assert.equal(classifyRollbackRefusal(entry.input), entry.expected, entry.name);
  }
});
