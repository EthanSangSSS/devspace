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
const macTest = process.platform === "darwin" ? test : test.skip;
const currentAgyPolicy = {
  model: "gemini-3.8-flash-high",
  effort: "high",
  compatibleVersions: ">=1.1.22 <1.2.0",
};

const customAgyPolicy = {
  model: "gemini-qualified-model",
  effort: "medium",
  compatibleVersions: ">=1.1.22 <1.2.0",
};

macTest("runtime introspection probes only local version/help and reports telemetry state", async (t) => {
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
    ...customAgyPolicy,
  });

  assert.equal(result.agyVersion, "1.1.22");
  assert.equal(result.requiredModel, "gemini-qualified-model");
  assert.equal(result.requiredEffort, "medium");
  assert.equal(result.compatibleVersions, ">=1.1.22 <1.2.0");
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

macTest("runtime introspection accepts Agy help emitted on stderr", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agyPath = join(root, "agy");
  const settingsPath = join(root, "settings.json");
  await writeFile(agyPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 1.1.22; exit 0; fi",
    `if [ \"$1\" = \"--help\" ]; then printf '%s\\n' ${requiredHelp.split("\n").map((value) => JSON.stringify(value)).join(" ")} >&2; exit 0; fi`,
    "exit 2",
    "",
  ].join("\n"));
  await chmod(agyPath, 0o700);
  await writeFile(settingsPath, JSON.stringify({ enableTelemetry: false }));

  const result = await inspectAgyRuntime({
    enabled: true,
    agyPath,
    cuaDriverPath: join(root, "cua-driver"),
    settingsPath,
    ...currentAgyPolicy,
  });

  assert.equal(result.requiredFlagsSupported, true);
});

macTest("runtime introspection reports missing required Agy flags without starting a worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-runtime-flags-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agyPath = join(root, "agy");
  const settingsPath = join(root, "settings.json");
  const helpWithoutSandbox = requiredHelp
    .split("\n")
    .filter((flag) => flag !== "--sandbox")
    .join("\n");
  await writeFile(agyPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 1.1.22; exit 0; fi",
    `if [ \"$1\" = \"--help\" ]; then printf '%s\\n' ${helpWithoutSandbox.split("\n").map((value) => JSON.stringify(value)).join(" ")}; exit 0; fi`,
    "exit 2",
    "",
  ].join("\n"));
  await chmod(agyPath, 0o700);
  await writeFile(settingsPath, JSON.stringify({ enableTelemetry: false }));

  const result = await inspectAgyRuntime({
    enabled: true,
    agyPath,
    cuaDriverPath: join(root, "cua-driver"),
    settingsPath,
    ...currentAgyPolicy,
  });

  assert.equal(result.agyVersion, "1.1.22");
  assert.equal(result.requiredFlagsSupported, false);
  assert.equal(result.workerStarted, false);
});

for (const version of ["1.2.0", "not-semver"]) {
  macTest(`runtime introspection fails closed for unqualified Agy version ${version}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devspace-agy-runtime-version-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const agyPath = join(root, "agy");
    const settingsPath = join(root, "settings.json");
    await writeFile(agyPath, [
      "#!/bin/sh",
      `if [ \"$1\" = \"--version\" ]; then echo ${JSON.stringify(version)}; exit 0; fi`,
      `if [ \"$1\" = \"--help\" ]; then printf '%s\\n' ${requiredHelp.split("\n").map((value) => JSON.stringify(value)).join(" ")}; exit 0; fi`,
      "exit 2",
      "",
    ].join("\n"));
    await chmod(agyPath, 0o700);
    await writeFile(settingsPath, JSON.stringify({ enableTelemetry: false }));

    await assert.rejects(
      () => inspectAgyRuntime({
        enabled: true,
        agyPath,
        cuaDriverPath: join(root, "cua-driver"),
        settingsPath,
        ...currentAgyPolicy,
      }),
      (error: unknown) => error instanceof AgyDelegationError && error.code === "AGY_VERSION_UNQUALIFIED",
    );
  });
}

macTest("runtime introspection rejects an invalid configured compatibility range", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-runtime-range-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agyPath = join(root, "agy");
  const settingsPath = join(root, "settings.json");
  await writeFile(agyPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 1.1.22; exit 0; fi",
    `if [ \"$1\" = \"--help\" ]; then printf '%s\\n' ${requiredHelp.split("\n").map((value) => JSON.stringify(value)).join(" ")}; exit 0; fi`,
    "exit 2",
    "",
  ].join("\n"));
  await chmod(agyPath, 0o700);
  await writeFile(settingsPath, JSON.stringify({ enableTelemetry: false }));

  await assert.rejects(
    () => inspectAgyRuntime({
      enabled: true,
      agyPath,
      cuaDriverPath: join(root, "cua-driver"),
      settingsPath,
      ...currentAgyPolicy,
      compatibleVersions: "definitely-not-a-range",
    }),
    (error: unknown) => error instanceof AgyDelegationError && error.code === "AGY_VERSION_UNQUALIFIED",
  );
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
      ...currentAgyPolicy,
    }),
    (error: unknown) => error instanceof AgyDelegationError && error.code === "TELEMETRY_POLICY_UNENFORCEABLE",
  );
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { enableTelemetry: true });
});

test("stream-json parser verifies exact init model and terminal success", () => {
  const result = parseAgyStream([
    JSON.stringify({ event: "init", init: { model: "gemini-qualified-model" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "ok" } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok\n" } }),
  ], "gemini-qualified-model");

  assert.equal(result.resolvedModel, "gemini-qualified-model");
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.response, "ok\n");
});

test("stream-json parser fails closed on missing or mismatched model telemetry", () => {
  assert.throws(
    () => parseAgyStream([
      JSON.stringify({ event: "init", init: {} }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }),
    ], "gemini-qualified-model"),
    (error: unknown) => error instanceof AgyDelegationError && error.code === "MODEL_UNVERIFIED",
  );

  assert.throws(
    () => parseAgyStream([
      JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-low" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }),
    ], "gemini-qualified-model"),
    (error: unknown) => error instanceof AgyDelegationError && error.code === "MODEL_MISMATCH",
  );
});

test("command verification requires exact configured model/effort and forbids resume or auto-approval flags", () => {
  const valid = [
    "--print", "read",
    "--model", "gemini-qualified-model",
    "--effort", "medium",
    "--output-format", "stream-json",
    "--mode", "plan",
    "--sandbox",
  ];
  const policy = { model: "gemini-qualified-model", effort: "medium" };
  assert.doesNotThrow(() => verifyAgyCommandArguments(valid, policy));

  assert.throws(
    () => verifyAgyCommandArguments(valid.map((value) => value === "medium" ? "high" : value), policy),
    (error: unknown) => error instanceof AgyDelegationError && error.code === "EFFORT_MISMATCH",
  );
  for (const flag of ["--continue", "--conversation", "--dangerously-skip-permissions"]) {
    assert.throws(
      () => verifyAgyCommandArguments([...valid, flag], policy),
      (error: unknown) => error instanceof AgyDelegationError && error.code === "RUNTIME_STATE_POLICY_UNENFORCEABLE",
    );
  }
});
