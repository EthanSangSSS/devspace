import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

const manager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
});

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

const foreground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);

const environment = await manager.start({
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/devspace-workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT].join(','))"`,
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a/);

const background = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "number");

await assert.rejects(
  manager.write({
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /does not belong to workspace/,
);

const completed = await manager.write({
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const interactive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "number");

const inputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
if (buffered.sessionId) manager.terminate("workspace-a", buffered.sessionId);

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.sessionId);

    const resizedPty = await manager.write({
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);
  }
} finally {
  manager.shutdown();
}

// Process session handles must not alias across DevSpace runtime generations.
// Use deterministic generators so this regression would reproduce the old
// sequential-ID bug without depending on randomness.
const oldRuntimeManager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
  sessionIdGenerator: () => 101,
});
const newRuntimeManager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
  sessionIdGenerator: () => 202,
});
try {
  const oldRuntimeProcess = await oldRuntimeManager.start({
    workspaceId: "workspace-generation",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  const newRuntimeProcess = await newRuntimeManager.start({
    workspaceId: "workspace-generation",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });

  assert.equal(oldRuntimeProcess.running, true);
  assert.equal(oldRuntimeProcess.sessionId, 101);
  assert.equal(newRuntimeProcess.running, true);
  assert.equal(newRuntimeProcess.sessionId, 202);

  await assert.rejects(
    newRuntimeManager.write({
      workspaceId: "workspace-generation",
      sessionId: oldRuntimeProcess.sessionId,
      chars: "stale-handle-must-not-be-delivered\n",
      yieldTimeMs: 1,
    }),
    /Unknown process session: 101/,
  );
} finally {
  oldRuntimeManager.shutdown();
  newRuntimeManager.shutdown();
}

// A runtime-local collision must be retried rather than replacing the process
// already stored under that opaque handle.
const generatedIds = [303, 303, 404];
const collisionManager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
  sessionIdGenerator: () => generatedIds.shift() ?? 505,
});
try {
  const firstCollisionProcess = await collisionManager.start({
    workspaceId: "workspace-collision",
    cwd: process.cwd(),
    command: `${node} -e "process.stdin.once('data', data => { console.log('first:' + data.toString().trim()); process.exit(0); })"`,
    yieldTimeMs: 5,
  });
  const secondCollisionProcess = await collisionManager.start({
    workspaceId: "workspace-collision",
    cwd: process.cwd(),
    command: `${node} -e "process.stdin.once('data', data => { console.log('second:' + data.toString().trim()); process.exit(0); })"`,
    yieldTimeMs: 5,
  });

  assert.equal(firstCollisionProcess.sessionId, 303);
  assert.equal(secondCollisionProcess.sessionId, 404);

  const firstCollisionResult = await collisionManager.write({
    workspaceId: "workspace-collision",
    sessionId: firstCollisionProcess.sessionId,
    chars: "alpha\n",
    yieldTimeMs: 2_000,
  });
  const secondCollisionResult = await collisionManager.write({
    workspaceId: "workspace-collision",
    sessionId: secondCollisionProcess.sessionId,
    chars: "beta\n",
    yieldTimeMs: 2_000,
  });
  assert.match(firstCollisionResult.output, /first:alpha/);
  assert.match(secondCollisionResult.output, /second:beta/);
} finally {
  collisionManager.shutdown();
}

// Invalid or throwing generators must fail before a child process is spawned.
const generatorFailureRoot = await mkdtemp(join(tmpdir(), "devspace-process-id-"));
try {
  for (const [label, sessionIdGenerator, expectedError] of [
    [
      "invalid",
      () => Number.MAX_SAFE_INTEGER + 1,
      /positive safe integer/,
    ],
    [
      "throwing",
      () => {
        throw new Error("synthetic generator failure");
      },
      /synthetic generator failure/,
    ],
  ] as const) {
    const marker = join(generatorFailureRoot, `${label}.spawned`);
    const failureManager = new ProcessSessionManager({ sessionIdGenerator });
    await assert.rejects(
      failureManager.start({
        workspaceId: `workspace-${label}`,
        cwd: process.cwd(),
        command: `${node} -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')"`,
        yieldTimeMs: 2_000,
      }),
      expectedError,
    );
    await assert.rejects(access(marker));
    failureManager.shutdown();
  }
} finally {
  await rm(generatorFailureRoot, { recursive: true, force: true });
}

// Exhausting all 16 collision retries must fail closed without replacing the
// original process already stored under the colliding handle.
let collisionAttempts = 0;
const exhaustedCollisionManager = new ProcessSessionManager({
  sessionIdGenerator: () => {
    collisionAttempts += 1;
    return 707;
  },
});
try {
  const originalCollisionProcess = await exhaustedCollisionManager.start({
    workspaceId: "workspace-collision-exhausted",
    cwd: process.cwd(),
    command: `${node} -e "process.stdin.once('data', data => { console.log('original:' + data.toString().trim()); process.exit(0); })"`,
    yieldTimeMs: 5,
  });
  assert.equal(originalCollisionProcess.sessionId, 707);

  await assert.rejects(
    exhaustedCollisionManager.start({
      workspaceId: "workspace-collision-exhausted",
      cwd: process.cwd(),
      command: `${node} -e "console.log('replacement-must-not-start')"`,
      yieldTimeMs: 2_000,
    }),
    /Unable to allocate a unique process session ID/,
  );
  assert.equal(collisionAttempts, 17);

  const originalAfterFailure = await exhaustedCollisionManager.write({
    workspaceId: "workspace-collision-exhausted",
    sessionId: originalCollisionProcess.sessionId,
    chars: "still-original\n",
    yieldTimeMs: 2_000,
  });
  assert.match(originalAfterFailure.output, /original:still-original/);
} finally {
  exhaustedCollisionManager.shutdown();
}

// The largest 48-bit handle must survive JavaScript/JSON round-tripping and
// still route input to the correct real child process.
const max48BitProcessSessionId = 2 ** 48 - 1;
const maxHandleManager = new ProcessSessionManager({
  sessionIdGenerator: () => max48BitProcessSessionId,
});
try {
  const maxHandleProcess = await maxHandleManager.start({
    workspaceId: "workspace-max-handle",
    cwd: process.cwd(),
    command: `${node} -e "process.stdin.once('data', data => { console.log('max:' + data.toString().trim()); process.exit(0); })"`,
    yieldTimeMs: 5,
  });
  assert.equal(maxHandleProcess.sessionId, max48BitProcessSessionId);

  const roundTrippedSessionId = JSON.parse(
    JSON.stringify({ sessionId: maxHandleProcess.sessionId }),
  ).sessionId as number;
  assert.equal(roundTrippedSessionId, max48BitProcessSessionId);
  assert.equal(Number.isSafeInteger(roundTrippedSessionId), true);

  const maxHandleResult = await maxHandleManager.write({
    workspaceId: "workspace-max-handle",
    sessionId: roundTrippedSessionId,
    chars: "roundtrip\n",
    yieldTimeMs: 2_000,
  });
  assert.match(maxHandleResult.output, /max:roundtrip/);
} finally {
  maxHandleManager.shutdown();
}
