import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  readlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

const CANDIDATE_ENTRYPOINT_SUFFIX = posix.join(
  "node_modules",
  "@waishnav",
  "devspace",
  "dist",
  "cli.js",
);

export interface CandidateSlotManifest {
  bytes: Buffer;
  sha256: string;
}

export function resolveCandidateSlotRoot(candidateEntrypoint: string): string {
  if (!posix.isAbsolute(candidateEntrypoint)) {
    throw new Error("candidate entrypoint must be an absolute path");
  }
  const normalized = posix.normalize(candidateEntrypoint);
  const suffix = `/${CANDIDATE_ENTRYPOINT_SUFFIX}`;
  if (!normalized.endsWith(suffix)) {
    throw new Error(`candidate entrypoint must end with ${CANDIDATE_ENTRYPOINT_SUFFIX}`);
  }
  return normalized.slice(0, -suffix.length) || "/";
}

export async function buildCandidateSlotManifest(slotRoot: string): Promise<CandidateSlotManifest> {
  const root = resolve(slotRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("candidate slot root must be a non-symlink directory");
  }

  const lines: string[] = [];
  await appendDirectory(root, root, "", lines);
  const bytes = Buffer.from(lines.join(""), "utf8");
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function verifyCandidateSlotManifest(
  slotRoot: string,
  expectedSha256: string,
): Promise<CandidateSlotManifest> {
  const manifest = await buildCandidateSlotManifest(slotRoot);
  if (manifest.sha256 !== expectedSha256) {
    throw new Error(
      `candidate slot manifest SHA-256 mismatch: expected ${expectedSha256}, got ${manifest.sha256}`,
    );
  }
  return manifest;
}

async function appendDirectory(
  root: string,
  directory: string,
  relativeDirectory: string,
  lines: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
    assertManifestField(relativePath, "path");
    const absolutePath = join(directory, entry.name);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      assertManifestField(target, "symlink target");
      assertSymlinkInsideRoot(root, absolutePath, target);
      lines.push(`L\t${target}\t${relativePath}\n`);
      continue;
    }
    if (stat.isDirectory()) {
      lines.push(`D\t${formatMode(stat.mode)}\t${relativePath}\n`);
      await appendDirectory(root, absolutePath, relativePath, lines);
      continue;
    }
    if (stat.isFile()) {
      const digest = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
      lines.push(`F\t${formatMode(stat.mode)}\t${digest}\t${relativePath}\n`);
      continue;
    }
    throw new Error(`unsupported candidate slot entry type: ${relativePath}`);
  }
}

function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8);
}

function assertManifestField(value: string, field: "path" | "symlink target"): void {
  if (/[\0\t\r\n]/.test(value)) {
    throw new Error(`unsupported manifest ${field}: ${JSON.stringify(value)}`);
  }
}

function assertSymlinkInsideRoot(root: string, symlinkPath: string, target: string): void {
  if (isAbsolute(target)) {
    throw new Error(`symlink escapes candidate slot: ${symlinkPath} -> ${target}`);
  }
  const destination = resolve(dirname(symlinkPath), target);
  const relationship = relative(root, destination);
  if (
    relationship === ".."
    || relationship.startsWith(`..${sep}`)
    || isAbsolute(relationship)
  ) {
    throw new Error(`symlink escapes candidate slot: ${symlinkPath} -> ${target}`);
  }
}
