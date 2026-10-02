import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolResultWaitTimer,
  type ToolResultWaitScheduler,
} from "./tool-result-wait.js";

function fakeScheduler(): {
  scheduler: ToolResultWaitScheduler;
  pending(): number;
  fireNext(): void;
} {
  let nextId = 1;
  const pending = new Map<number, () => void>();

  return {
    scheduler: {
      schedule(callback) {
        const id = nextId++;
        pending.set(id, callback);
        return id;
      },
      cancel(handle) {
        pending.delete(handle as number);
      },
    },
    pending: () => pending.size,
    fireNext() {
      const next = pending.entries().next();
      if (next.done) throw new Error("No pending timer to fire.");
      const [id, callback] = next.value;
      pending.delete(id);
      callback();
    },
  };
}

test("tool-result wait timer warns after the configured delay", () => {
  let warnings = 0;
  const fake = fakeScheduler();
  const timer = new ToolResultWaitTimer(30_000, () => warnings++, fake.scheduler);

  timer.start();
  assert.equal(fake.pending(), 1);
  fake.fireNext();

  assert.equal(warnings, 1);
  assert.equal(fake.pending(), 0);
});

test("tool-result wait timer is cancelled by an early result or teardown", () => {
  let warnings = 0;
  const fake = fakeScheduler();
  const timer = new ToolResultWaitTimer(30_000, () => warnings++, fake.scheduler);

  timer.start();
  timer.clear();

  assert.equal(warnings, 0);
  assert.equal(fake.pending(), 0);
});

test("restarting the tool-result wait timer replaces the prior deadline", () => {
  let warnings = 0;
  const fake = fakeScheduler();
  const timer = new ToolResultWaitTimer(30_000, () => warnings++, fake.scheduler);

  timer.start();
  assert.equal(fake.pending(), 1);
  timer.start();
  assert.equal(fake.pending(), 1);
  assert.equal(warnings, 0);

  fake.fireNext();
  assert.equal(warnings, 1);
  assert.equal(fake.pending(), 0);
});
