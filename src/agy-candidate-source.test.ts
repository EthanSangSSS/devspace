import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AGY_DARWIN_ARM64_MANIFEST_URL,
  AgyCandidateSourceError,
  officialAgyCandidateSource,
  parseOfficialAgyCandidateManifest,
} from "./agy-candidate-source.js";

const source = officialAgyCandidateSource("darwin", "arm64");
const validManifest = {
  version: "1.3.0",
  url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.0-6233328509124608/darwin-arm/cli_mac_arm64.tar.gz",
  sha512: "a".repeat(128),
};

test("official Agy source is explicit and limited to reviewed darwin arm64 manifest", () => {
  assert.deepEqual(source, {
    adapterId: "google-antigravity-platform-manifest",
    adapterRevision: 1,
    platform: "darwin",
    architecture: "arm64",
    manifestPlatform: "darwin_arm64",
    manifestUrl: AGY_DARWIN_ARM64_MANIFEST_URL,
  });
  assert.throws(
    () => officialAgyCandidateSource("linux", "x64"),
    (error: unknown) => error instanceof AgyCandidateSourceError
      && error.reason === "UNSUPPORTED_PLATFORM"
      && error.retryable === false,
  );
});

test("manifest parser returns exact candidate identity without claiming global latest", () => {
  const raw = `${JSON.stringify({ ...validManifest, ignoredFutureField: "ignored" }, null, 2)}\n`;
  const result = parseOfficialAgyCandidateManifest(raw, source);

  assert.equal(result.version, "1.3.0");
  assert.equal(result.artifactUrl, validManifest.url);
  assert.equal(result.artifactSha512, validManifest.sha512);
  assert.equal(
    result.metadataSha256,
    createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"),
  );
  assert.equal("channel" in result, false);
  assert.equal("latest" in result, false);
  assert.equal("stable" in result, false);
});

for (const [name, payload, reason] of [
  ["malformed json", "{", "METADATA_INVALID"],
  ["array root", "[]", "METADATA_INVALID"],
  ["missing url", JSON.stringify({ version: "1.3.0", sha512: "a".repeat(128) }), "METADATA_INVALID"],
  ["non-semver version", JSON.stringify({ ...validManifest, version: "latest" }), "VERSION_INVALID"],
  ["v-prefixed version", JSON.stringify({ ...validManifest, version: "v1.3.0" }), "VERSION_INVALID"],
  ["space-padded version", JSON.stringify({ ...validManifest, version: " 1.3.0 " }), "VERSION_INVALID"],
  ["uppercase digest", JSON.stringify({ ...validManifest, sha512: "A".repeat(128) }), "ARTIFACT_DIGEST_INVALID"],
  ["unreviewed channel", JSON.stringify({ ...validManifest, channel: "canary" }), "METADATA_INVALID"],
  ["unreviewed schema version", JSON.stringify({ ...validManifest, schemaVersion: 2 }), "METADATA_INVALID"],
] as const) {
  test(`manifest parser fails closed for ${name}`, () => {
    assert.throws(
      () => parseOfficialAgyCandidateManifest(payload, source),
      (error: unknown) => error instanceof AgyCandidateSourceError && error.reason === reason,
    );
  });
}

for (const version of [
  "1.3.0-alpha.1",
  "1.3.0+build.5",
  "1.3.0-alpha.1+build.5",
]) {
  test(`manifest parser accepts canonical SemVer ${version}`, () => {
    const url = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-release/darwin-arm/cli_mac_arm64.tar.gz`;
    const result = parseOfficialAgyCandidateManifest(
      JSON.stringify({ ...validManifest, version, url }),
      source,
    );
    assert.equal(result.version, version);
  });
}

for (const url of [
  "http://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.0-x/darwin-arm/cli_mac_arm64.tar.gz",
  "https://example.com/antigravity-public/antigravity-cli/1.3.0-x/darwin-arm/cli_mac_arm64.tar.gz",
  "https://storage.googleapis.com/other-bucket/1.3.0-x/darwin-arm/cli_mac_arm64.tar.gz",
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.17-x/darwin-arm/cli_mac_arm64.tar.gz",
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.0-x/darwin-arm/cli_mac_arm64.tar.gz?token=dynamic",
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.0-x/darwin-arm/cli_mac_arm64",
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.0-x/linux-x64/cli_linux_x64.tar.gz",
]) {
  test(`manifest parser rejects unreviewed artifact URL ${url}`, () => {
    assert.throws(
      () => parseOfficialAgyCandidateManifest(JSON.stringify({ ...validManifest, url }), source),
      (error: unknown) => error instanceof AgyCandidateSourceError
        && error.reason === "ARTIFACT_URL_INVALID",
    );
  });
}

test("manifest parser binds metadata digest to exact bytes", () => {
  const compact = JSON.stringify(validManifest);
  const pretty = JSON.stringify(validManifest, null, 2);
  const compactResult = parseOfficialAgyCandidateManifest(compact, source);
  const prettyResult = parseOfficialAgyCandidateManifest(pretty, source);

  assert.equal(compactResult.version, prettyResult.version);
  assert.notEqual(compactResult.metadataSha256, prettyResult.metadataSha256);
});

test("manifest parser rejects oversized metadata before JSON parsing", () => {
  assert.throws(
    () => parseOfficialAgyCandidateManifest(`{"padding":"${"x".repeat(70 * 1024)}"}`, source),
    (error: unknown) => error instanceof AgyCandidateSourceError
      && error.reason === "METADATA_TOO_LARGE",
  );
});
