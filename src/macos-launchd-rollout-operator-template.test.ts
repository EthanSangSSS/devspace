import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const templateUrl = new URL("../examples/macos-rollout-operator.plist", import.meta.url);
const template = readFileSync(templateUrl, "utf8");
const checkoutRoot = fileURLToPath(new URL("../", import.meta.url));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertStringValue(text: string, key: string, expected: string): void {
  const pattern = new RegExp(
    `<key>${escapeRegExp(key)}</key>\\s*<string>${escapeRegExp(expected)}</string>`,
  );
  assert.match(text, pattern, `${key} should equal ${expected}`);
}

function assertBooleanValue(text: string, key: string, expected: boolean): void {
  const marker = expected ? "true" : "false";
  assert.match(
    text,
    new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<${marker}\\s*/>`),
    `${key} should equal ${expected}`,
  );
}

function programArguments(text: string): string[] {
  const match = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  assert.ok(match, "ProgramArguments array should exist");
  return Array.from(match[1]!.matchAll(/<string>([^<]*)<\/string>/g), (entry) => entry[1]!);
}

function lintWithPlutilIfAvailable(text: string): void {
  if (process.platform !== "darwin") return;
  execFileSync("/usr/bin/plutil", ["-lint", "-"], {
    input: text,
    stdio: "pipe",
    timeout: 10_000,
  });
}

test("rollout operator template pins the one-shot interactive execution contract", () => {
  lintWithPlutilIfAvailable(template);

  assertStringValue(template, "Label", "com.ethan.devspace.rollout-operator.REPLACE_UNIQUE_NONCE");
  assertStringValue(template, "ProcessType", "Interactive");
  assertBooleanValue(template, "RunAtLoad", true);
  assertBooleanValue(template, "KeepAlive", false);
  assertBooleanValue(template, "LaunchOnlyOnce", true);
  assertStringValue(template, "WorkingDirectory", "REPLACE_ABSOLUTE_CHECKOUT");
  assertStringValue(
    template,
    "StandardOutPath",
    "REPLACE_EXISTING_PRIVATE_DIRECTORY/result.log",
  );
  assertStringValue(
    template,
    "StandardErrorPath",
    "REPLACE_EXISTING_PRIVATE_DIRECTORY/error.log",
  );
  assertStringValue(template, "LANG", "C");
  assertStringValue(template, "LC_ALL", "C");

  assert.deepEqual(programArguments(template), [
    "REPLACE_ABSOLUTE_NODE_PATH",
    "REPLACE_ABSOLUTE_CHECKOUT/node_modules/tsx/dist/cli.mjs",
    "REPLACE_ABSOLUTE_CHECKOUT/scripts/devspace-macos-rollout.ts",
    "rollout",
    "--expected-live-entrypoint",
    "REPLACE_EXPECTED_LIVE_ENTRYPOINT",
    "--expected-live-plist-sha256",
    "REPLACE_EXPECTED_LIVE_PLIST_SHA256",
    "--candidate-entrypoint",
    "REPLACE_CANDIDATE_ENTRYPOINT",
    "--candidate-slot-manifest-sha256",
    "REPLACE_CANDIDATE_SLOT_MANIFEST_SHA256",
  ]);

  assert.doesNotMatch(template, /<string>--import<\/string>/);
  assert.doesNotMatch(template, /<string>tsx<\/string>/);
  assert.doesNotMatch(template, /<string>\/REPLACE_/);
  for (const forbiddenKey of [
    "StartInterval",
    "StartCalendarInterval",
    "QueueDirectories",
    "WatchPaths",
  ]) {
    assert.doesNotMatch(template, new RegExp(`<key>${forbiddenKey}</key>`));
  }
});

test("rollout operator placeholders resolve to a lintable definition without ambiguous paths", () => {
  const replacements: Record<string, string> = {
    REPLACE_UNIQUE_NONCE: "regression-20261003",
    REPLACE_ABSOLUTE_NODE_PATH: "/opt/homebrew/opt/node@24/bin/node",
    REPLACE_ABSOLUTE_CHECKOUT: "/Users/test/devspace-checkout",
    REPLACE_EXPECTED_LIVE_ENTRYPOINT: "/Users/test/devspace-old/node_modules/@waishnav/devspace/dist/cli.js",
    REPLACE_EXPECTED_LIVE_PLIST_SHA256: "a".repeat(64),
    REPLACE_CANDIDATE_ENTRYPOINT: "/Users/test/devspace-new/node_modules/@waishnav/devspace/dist/cli.js",
    REPLACE_CANDIDATE_SLOT_MANIFEST_SHA256: "b".repeat(64),
    REPLACE_EXISTING_PRIVATE_DIRECTORY: "/Users/test/.devspace/rollout/operator-regression-20261003",
  };

  let resolved = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    resolved = resolved.replaceAll(placeholder, value);
  }

  assert.doesNotMatch(resolved, /REPLACE_[A-Z0-9_]+/);
  assert.doesNotMatch(resolved, /<string>\/\//);
  assert.deepEqual(programArguments(resolved).slice(0, 4), [
    "/opt/homebrew/opt/node@24/bin/node",
    "/Users/test/devspace-checkout/node_modules/tsx/dist/cli.mjs",
    "/Users/test/devspace-checkout/scripts/devspace-macos-rollout.ts",
    "rollout",
  ]);

  lintWithPlutilIfAvailable(resolved);
});

test("absolute tsx CLI loads the rollout helper from a minimal launchd-style environment", {
  skip: process.platform !== "darwin",
  timeout: 20_000,
}, () => {
  const tsxCli = join(checkoutRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const helper = join(checkoutRoot, "scripts", "devspace-macos-rollout.ts");
  const helperUrl = pathToFileURL(helper).href;
  const inlineScript = [
    `import { parseRolloutScriptArgs } from ${JSON.stringify(helperUrl)};`,
    'const a = "a".repeat(64);',
    'const b = "b".repeat(64);',
    'const parsed = parseRolloutScriptArgs([',
    '  "rollout",',
    '  "--expected-live-entrypoint", "/tmp/old/dist/cli.js",',
    '  "--expected-live-plist-sha256", a,',
    '  "--candidate-entrypoint", "/tmp/new/dist/cli.js",',
    '  "--candidate-slot-manifest-sha256", b,',
    ']);',
    'if (parsed.mode !== "rollout") process.exit(2);',
    'process.stdout.write("HELPER_ARG_PARSE=PASS\\n");',
  ].join("\n");

  const output = execFileSync(process.execPath, [tsxCli, "-e", inlineScript], {
    cwd: "/",
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(output.trim(), "HELPER_ARG_PARSE=PASS");
});
