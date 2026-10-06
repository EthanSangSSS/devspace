import { createHash } from "node:crypto";
import { parse } from "semver";

export const AGY_CANDIDATE_SOURCE_ADAPTER_ID = "google-antigravity-platform-manifest" as const;
export const AGY_CANDIDATE_SOURCE_ADAPTER_REVISION = 1 as const;
export const AGY_DARWIN_ARM64_MANIFEST_URL =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json" as const;

const OFFICIAL_ARTIFACT_HOST = "storage.googleapis.com";
const OFFICIAL_ARTIFACT_PATH_PREFIX = "/antigravity-public/antigravity-cli/";
const MAX_MANIFEST_BYTES = 64 * 1024;
const SHA512_RE = /^[0-9a-f]{128}$/;

export type AgyCandidateSourceFailureReason =
  | "UNSUPPORTED_PLATFORM"
  | "METADATA_TOO_LARGE"
  | "METADATA_INVALID"
  | "VERSION_INVALID"
  | "ARTIFACT_URL_INVALID"
  | "ARTIFACT_DIGEST_INVALID";

export class AgyCandidateSourceError extends Error {
  readonly stage = "discovery" as const;

  constructor(
    readonly reason: AgyCandidateSourceFailureReason,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AgyCandidateSourceError";
  }
}

export interface AgyCandidateSourceDescriptor {
  adapterId: typeof AGY_CANDIDATE_SOURCE_ADAPTER_ID;
  adapterRevision: typeof AGY_CANDIDATE_SOURCE_ADAPTER_REVISION;
  platform: "darwin";
  architecture: "arm64";
  manifestPlatform: "darwin_arm64";
  manifestUrl: typeof AGY_DARWIN_ARM64_MANIFEST_URL;
}

export interface AgyDiscoveredCandidate {
  source: AgyCandidateSourceDescriptor;
  metadataSha256: string;
  version: string;
  artifactUrl: string;
  artifactSha512: string;
}

export function isCanonicalSemVer(value: string): boolean {
  const parsed = parse(value);
  if (!parsed) return false;
  const prerelease = parsed.prerelease.length > 0
    ? `-${parsed.prerelease.join(".")}`
    : "";
  const build = parsed.build.length > 0
    ? `+${parsed.build.join(".")}`
    : "";
  const canonical = `${parsed.major}.${parsed.minor}.${parsed.patch}${prerelease}${build}`;
  return value === canonical;
}

export function assertOfficialAgyCandidateArtifactUrl(value: string, version: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidArtifactUrl();
  }
  const versionPrefix = `${OFFICIAL_ARTIFACT_PATH_PREFIX}${version}-`;
  if (
    url.protocol !== "https:"
    || url.hostname !== OFFICIAL_ARTIFACT_HOST
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !url.pathname.startsWith(versionPrefix)
    || !url.pathname.endsWith("/darwin-arm/cli_mac_arm64.tar.gz")
  ) {
    throw invalidArtifactUrl();
  }
}

export function officialAgyCandidateSource(
  platform: NodeJS.Platform,
  architecture: string,
): AgyCandidateSourceDescriptor {
  if (platform !== "darwin" || architecture !== "arm64") {
    throw new AgyCandidateSourceError(
      "UNSUPPORTED_PLATFORM",
      `Agy candidate discovery is not qualified for ${platform}/${architecture}.`,
      false,
    );
  }
  return {
    adapterId: AGY_CANDIDATE_SOURCE_ADAPTER_ID,
    adapterRevision: AGY_CANDIDATE_SOURCE_ADAPTER_REVISION,
    platform: "darwin",
    architecture: "arm64",
    manifestPlatform: "darwin_arm64",
    manifestUrl: AGY_DARWIN_ARM64_MANIFEST_URL,
  };
}

export function parseOfficialAgyCandidateManifest(
  raw: string | Buffer,
  source: AgyCandidateSourceDescriptor,
): AgyDiscoveredCandidate {
  assertKnownSource(source);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new AgyCandidateSourceError(
      "METADATA_TOO_LARGE",
      `Agy release manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`,
      false,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AgyCandidateSourceError(
      "METADATA_INVALID",
      "Agy release manifest is not valid JSON.",
      false,
    );
  }
  if (!isRecord(parsed)) {
    throw new AgyCandidateSourceError(
      "METADATA_INVALID",
      "Agy release manifest must be a JSON object.",
      false,
    );
  }

  for (const reviewRequiredField of ["schema", "schemaVersion", "channel"] as const) {
    if (reviewRequiredField in parsed) {
      throw new AgyCandidateSourceError(
        "METADATA_INVALID",
        `Agy release manifest field ${reviewRequiredField} requires an adapter review before use.`,
        false,
      );
    }
  }

  const version = requireManifestString(parsed, "version");
  const artifactUrl = requireManifestString(parsed, "url");
  const artifactSha512 = requireManifestString(parsed, "sha512");

  if (!isCanonicalSemVer(version)) {
    throw new AgyCandidateSourceError(
      "VERSION_INVALID",
      `Agy release manifest version is not canonical SemVer: ${version || "<empty>"}.`,
      false,
    );
  }
  assertOfficialAgyCandidateArtifactUrl(artifactUrl, version);
  if (!SHA512_RE.test(artifactSha512)) {
    throw new AgyCandidateSourceError(
      "ARTIFACT_DIGEST_INVALID",
      "Agy release manifest sha512 must be lowercase 128-hex.",
      false,
    );
  }

  return {
    source,
    metadataSha256: createHash("sha256").update(bytes).digest("hex"),
    version,
    artifactUrl,
    artifactSha512,
  };
}

function assertKnownSource(source: AgyCandidateSourceDescriptor): void {
  if (
    source.adapterId !== AGY_CANDIDATE_SOURCE_ADAPTER_ID
    || source.adapterRevision !== AGY_CANDIDATE_SOURCE_ADAPTER_REVISION
    || source.platform !== "darwin"
    || source.architecture !== "arm64"
    || source.manifestPlatform !== "darwin_arm64"
    || source.manifestUrl !== AGY_DARWIN_ARM64_MANIFEST_URL
  ) {
    throw new AgyCandidateSourceError(
      "METADATA_INVALID",
      "Agy candidate source descriptor does not match the reviewed adapter contract.",
      false,
    );
  }
}

function invalidArtifactUrl(): AgyCandidateSourceError {
  return new AgyCandidateSourceError(
    "ARTIFACT_URL_INVALID",
    "Agy release manifest artifact URL is outside the reviewed HTTPS release path.",
    false,
  );
}

function requireManifestString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AgyCandidateSourceError(
      "METADATA_INVALID",
      `Agy release manifest is missing string field ${key}.`,
      false,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
