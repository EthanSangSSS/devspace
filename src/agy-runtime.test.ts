import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectAgyRuntime,
  parseAgyStream,
  preflightAgyRealRun,
  verifyAgyCommandArguments,
} from "./agy-runtime.js";
import { AgyDelegationError } from "./agy-delegation-types.js";

const requiredHelp = [
  "--model",
  "--effort",
  "--output-format",
  "--mode",
  "--sandbox",
  "--print",
].join("\n");

test("runtime introspection probes only local version/help and reports telemetry state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agyPath = join(root, "agy");
  const settingsPath = join(root, "settings.json");
  const callsPath = join(root, "calls.txt");
  await writeFile(agyPath, [
    "#!/bin/sh",
    `printf '%s\\n' \"$1\" >> ${JSON.stringify(callsPath)}`,
    "if [ \"$1\" = \"--version\" ]; then echo 1.1.22; exit 0; fi",
    `if [ \"$1\" = \"--help\" ]; then printf '%s\\n' ${requiredHelp.split("\n").map((value) => JSON.stringify(value)).join(" ")}; exit 0; fi`,
    "exit 2",
    "",
  ].join("\n"));
  await chmod(agyPath, 0o700);
  await writeFile(settingsPath, JSON.stringify({ enableTelemetry: false, unrelatedSecret: "do-not-return" }));

  const result = await inspectAgyRuntime({
    enabled: true,
    agyPath,
    cuaDriverPath: join(root, "cua-driver"),
    settingsPath,
  });

  assert.equal(result.agyVersion, "1.1.22");
  assert.equal(result.requiredFlagsSupported, true);
  assert.equal(result.telemetryEnabled, false);
  assert.equal(result.taskLocalSessionEnforcement, "available");
  assert.equal(result.hostSettingsMutationRequired, false);
  assert.equal(result.workerStarted, false);
  assert.match(result.agyExecutableSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    (await readFile(callsPath, "utf8")).trim().split("\n").sort(),
    ["--help", "--version"],
  );
  assert.equal(JSON.stringify(result).includes("do-not-return"), false);
});

test("real-run preflight rejects telemetry enabled without mutating settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ enableTelemetry: true }));

  await assert.rejects(
    () => preflightAgyRealRun({
      enabled: true,
      agyPath: join(root, "agy"),
      cuaDriverPath: join(root, "cua-driver"),
      settingsPath,
    }),
    (error: unknown) => error instanceof AgyDelegationError && error.code === "TELEMETRY_POLICY_UNENFORCEABLE",
  );
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { enableTelemetry: true });
});

test("stream-json parser verifies exact init model and terminal success", () => {
  const result = parseAgyStream([
    JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-high" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "ok" } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok\n" } }),
  ]);

  assert.equal(result.resolvedModel, "gemini-3.8-flash-high");
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.response, "ok\n");
});

test("stream-json parser fails closed on missing or mismatched model telemetry", () => {
  assert.throws(
    () => parseAgyStream([
      JSON.stringify({ event: "init", init: {} }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }),
    ]),
    (error: unknown) => error instanceof AgyDelegationError && error.code === "MODEL_UNVERIFIED",
  );

  assert.throws(
    () => parseAgyStream([
      JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-low" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }),
    ]),
    (error: unknown) => error instanceof AgyDelegationError && error.code === "MODEL_MISMATCH",
  );
});

test("command verification requires exact high effort and forbids resume or auto-approval flags", () => {
  const valid = [
    "--print", "read",
    "--model", "gemini-3.8-flash-high",
    "--effort", "high",
    "--output-format", "stream-json",
    "--mode", "plan",
    "--sandbox",
  ];
  assert.doesNotThrow(() => verifyAgyCommandArguments(valid));

  assert.throws(
    () => verifyAgyCommandArguments(valid.map((value) => value === "high" ? "medium" : value)),
    (error: unknown) => error instanceof AgyDelegationError && error.code === "EFFORT_MISMATCH",
  );
  for (const flag of ["--continue", "--conversation", "--dangerously-skip-permissions"]) {
    assert.throws(
      () => verifyAgyCommandArguments([...valid, flag]),
      (error: unknown) => error instanceof AgyDelegationError && error.code === "RUNTIME_STATE_POLICY_UNENFORCEABLE",
    );
  }
});
