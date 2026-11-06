import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { platform } from "node:os";
import type {
  WorkspaceConversationBinding,
  WorkspaceMode,
  WorkspaceStore,
} from "./workspace-store.js";
import { mkdir, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { createManagedWorktree, verifyManagedWorktreeVolumeSync } from "./git-worktrees.js";
import {
  AccessDeniedError,
  assertAllowedPath,
  isPathInsideRoot,
  resolveAllowedPath,
  resolvePhysicalPath,
} from "./roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";
import {
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  canonicalRoot: string;
  rootDevice: number;
  rootInode: number;
  protectedCheckoutVolumeUuid?: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  agentProfiles: LocalAgentProfile[];
  activatedSkillDirs: Set<string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  workspaceReused: boolean;
  includeBootstrapContext: boolean;
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

export interface OpenWorkspaceOptions {
  conversationScopeId?: string;
}

type PathStats = Stats;
type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pendingCheckoutOpens = new Map<string, Promise<WorkspaceContext>>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(
    input: string | OpenWorkspaceInput,
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceContext> {
    const workspaceInput = typeof input === "string" ? { path: input } : input;
    const conversationScopeId = openOptions.conversationScopeId;
    if (!conversationScopeId || !this.store) {
      return this.openNewWorkspace(workspaceInput);
    }

    const projectKey = await this.conversationProjectKey(workspaceInput);
    const mode = workspaceInput.mode ?? "checkout";
    if (mode === "worktree") {
      const context = await this.openWorktreeWorkspace(workspaceInput.path, workspaceInput.baseRef);
      return {
        ...context,
        // A new worktree always has its own workspace-specific context.
        includeBootstrapContext: true,
      };
    }

    const targetKey = this.conversationCheckoutTargetKey(projectKey);
    const operationKey = JSON.stringify([conversationScopeId, targetKey]);
    const pending = this.pendingCheckoutOpens.get(operationKey);
    if (pending) {
      const context = await pending;
      return {
        ...context,
        workspaceReused: true,
        includeBootstrapContext: false,
      };
    }

    const open = this.openConversationCheckout(
      workspaceInput,
      conversationScopeId,
      targetKey,
    );
    this.pendingCheckoutOpens.set(operationKey, open);

    try {
      return await open;
    } finally {
      if (this.pendingCheckoutOpens.get(operationKey) === open) {
        this.pendingCheckoutOpens.delete(operationKey);
      }
    }
  }

  private async openNewWorkspace(options: OpenWorkspaceInput): Promise<WorkspaceContext> {
    const mode = options.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openWorktreeWorkspace(options.path, options.baseRef);
    }

    return this.openCheckoutWorkspace(options.path);
  }

  private async openConversationCheckout(
    input: OpenWorkspaceInput,
    conversationScopeId: string,
    targetKey: string,
  ): Promise<WorkspaceContext> {
    const binding = this.store?.getConversationBinding(conversationScopeId, targetKey);
    if (binding) {
      const reusableWorkspace = await this.findReusableCheckoutWorkspace(binding);

      if (reusableWorkspace) {
        const context = await this.reusedWorkspaceContext(reusableWorkspace);
        this.store?.touchConversationBinding(conversationScopeId, targetKey);
        return {
          ...context,
          includeBootstrapContext: false,
        };
      }

      this.workspaces.delete(binding.workspaceSessionId);
      this.store?.deleteConversationBinding(conversationScopeId, targetKey);
    }

    const context = await this.openCheckoutWorkspace(input.path);
    this.store?.setConversationBinding({
      conversationScopeId,
      targetKey,
      workspaceSessionId: context.workspace.id,
    });
    return {
      ...context,
      includeBootstrapContext: true,
    };
  }

  private async findReusableCheckoutWorkspace(
    binding: WorkspaceConversationBinding,
  ): Promise<Workspace | undefined> {
    const session = this.store?.getSession(binding.workspaceSessionId);
    if (!session || session.status !== "active" || session.mode !== "checkout") {
      return undefined;
    }

    let root: string;
    try {
      root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
      const rootStats = await stat(root);
      if (!rootStats.isDirectory()) return undefined;
    } catch (error) {
      if (
        error instanceof AccessDeniedError ||
        (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      ) {
        return undefined;
      }

      throw error;
    }

    const workspace = this.getWorkspace(binding.workspaceSessionId);
    if (workspace.mode !== "checkout" || workspace.root !== root) return undefined;
    return workspace;
  }

  private async conversationProjectKey(input: OpenWorkspaceInput): Promise<string> {
    const path = assertAllowedPath(input.path, this.config.allowedRoots);
    return canonicalPath(path);
  }

  private conversationCheckoutTargetKey(projectKey: string): string {
    return JSON.stringify(["checkout", projectKey, null]);
  }

  private async reusedWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    workspace.agentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: true,
      includeBootstrapContext: true,
    };
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      // A cached ID is not a permanent filesystem authorization. Recheck the
      // configured roots before using a checkout that may have been replaced.
      this.assertWorkspaceRootAllowed(workspace.root, workspace.mode, workspace.sourceRoot);
      if (workspace.mode === "checkout") {
        this.verifyCheckoutVolumeIdentity(workspace.root, workspace.protectedCheckoutVolumeUuid);
      }
      // The same device/inode can be observed again after a volume is
      // remounted. For opt-in SSD-managed worktrees, revalidate the actual
      // encrypted APFS UUID on every cache hit, not just at session restore.
      // Legacy roots retain their separate Git-backlink recovery policy.
      if (workspace.mode === "worktree" && workspace.worktree?.managed
          && isPathInsideRoot(workspace.root, this.config.worktreeRoot)
          && (this.config.managedWorktreeMountPoint || this.config.managedWorktreeVolumeUuid)) {
        verifyManagedWorktreeVolumeSync(this.config);
      }
      this.assertWorkspaceRootUnchanged(workspace);
      // An unchanged directory inode does not guarantee its .git metadata
      // still belongs to the original managed source repository.
      if (workspace.mode === "worktree" && workspace.worktree?.managed) {
        assertManagedGitWorktreeBacklink(workspace.root, workspace.sourceRoot);
      }
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(
        `Unknown workspaceId: ${workspaceId}. Open the target project or worktree again and continue with the new workspaceId.`,
      );
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const protectedCheckoutVolumeUuid = session.mode === "checkout"
      ? this.verifyCheckoutVolumeIdentity(root, session.rootVolumeUuid)
      : undefined;
    const canonicalRoot = this.resolveCanonicalWorkspaceRoot(
      root,
      session.mode,
      session.sourceRoot,
    );
    this.assertRestoredWorkspaceIdentity(session, root, canonicalRoot);
    const restoredRootStats = statSync(canonicalRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      canonicalRoot,
      rootDevice: restoredRootStats.dev,
      rootInode: restoredRootStats.ino,
      protectedCheckoutVolumeUuid,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              dirtySource: false,
              detached: true,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      agentProfiles: [],
      activatedSkillDirs: new Set(),
    };
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

    return restoredWorkspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    const canonicalPath = resolvePhysicalPath(absolutePath);
    if (!isPathInsideRoot(canonicalPath, workspace.canonicalRoot)) {
      throw new AccessDeniedError(`Path is outside workspace root: ${inputPath}`);
    }

    return canonicalPath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.canonicalRoot],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: resolvePhysicalPath(
          assertAllowedPath(skillRead.absolutePath, [skillRead.skill.baseDir]),
        ),
        readRoots: [
          workspace.canonicalRoot,
          resolvePhysicalPath(skillRead.skill.baseDir),
        ],
        skillRead,
      };
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    return workingDirectory
      ? this.resolvePath(workspace, workingDirectory)
      : workspace.canonicalRoot;
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    // An absent removable mount can leave an ordinary host directory at the
    // same path. Validate the configured physical volume before any mkdir.
    const protectedCheckoutVolumeUuid = this.verifyCheckoutVolumeIdentity(root);
    // A mounted SSD can disappear between a mount check and mkdir. Never
    // recursively create a checkout root on a protected removable volume.
    const rootStats = protectedCheckoutVolumeUuid
      ? await stat(root)
      : await ensureCheckoutWorkspaceRoot(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({
      root,
      canonicalRoot: realpathSync(root),
      protectedCheckoutVolumeUuid,
      mode: "checkout",
    });
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      canonicalRoot: realpathSync(worktree.path),
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    canonicalRoot: string;
    protectedCheckoutVolumeUuid?: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const initialRootStats = statSync(input.canonicalRoot);
    const workspace: Workspace = {
      id: `ws_${randomBytes(5).toString("hex")}`,
      root: input.root,
      canonicalRoot: input.canonicalRoot,
      rootDevice: initialRootStats.dev,
      rootInode: initialRootStats.ino,
      protectedCheckoutVolumeUuid: input.protectedCheckoutVolumeUuid,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
      activatedSkillDirs: new Set(),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
      rootInode: statSync(input.canonicalRoot, { bigint: true }).ino.toString(),
      rootVolumeUuid: input.mode === "checkout"
        ? input.protectedCheckoutVolumeUuid
        : input.mode === "worktree"
        && input.worktree?.managed
        && isPathInsideRoot(input.root, this.config.worktreeRoot)
        ? this.config.managedWorktreeVolumeUuid || undefined
        : undefined,
    });
    this.workspaces.set(workspace.id, workspace);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: false,
      includeBootstrapContext: true,
    };
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [
        this.config.worktreeRoot,
        ...this.config.legacyWorktreeRoots,
      ]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private verifyCheckoutVolumeIdentity(root: string, previouslyBoundUuid?: string): string | undefined {
    const mount = this.config.managedWorktreeMountPoint;
    const uuid = this.config.managedWorktreeVolumeUuid;
    const physicalRoot = mount ? resolvePhysicalPath(root) : undefined;
    const physicalMount = mount ? resolvePhysicalPath(mount) : undefined;
    const protectedPath = Boolean(mount)
      && (isPathInsideRoot(root, mount)
        || isPathInsideRoot(physicalRoot!, physicalMount!));

    if ((!mount && uuid) || (previouslyBoundUuid && (!protectedPath ||
        previouslyBoundUuid.toUpperCase() !== uuid.toUpperCase()))) {
      throw new AccessDeniedError(`Unverified protected checkout volume identity: ${root}`);
    }
    if (!protectedPath) return undefined;

    // A symlink or nested filesystem may point a lexically protected path
    // back to the host. It must resolve to this same mounted device.
    if (!isPathInsideRoot(physicalRoot!, physicalMount!)) {
      throw new AccessDeniedError(`Unverified protected checkout volume identity: ${root}`);
    }

    try {
      verifyManagedWorktreeVolumeSync(this.config);
      const mounted = statSync(mount);
      const checkout = statSync(root);
      if (!checkout.isDirectory() || checkout.dev !== mounted.dev) {
        throw new Error("checkout is not on the protected volume");
      }
    } catch {
      throw new AccessDeniedError(`Unverified protected checkout volume identity: ${root}`);
    }
    return uuid;
  }

  private resolveCanonicalWorkspaceRoot(
    root: string,
    mode: WorkspaceMode,
    sourceRoot: string | undefined,
  ): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      assertAllowedPath(root, [
        this.config.worktreeRoot,
        ...this.config.legacyWorktreeRoots,
      ]);
    }

    try {
      return realpathSync(root);
    } catch {
      throw new AccessDeniedError(`Workspace root is no longer accessible: ${root}`);
    }
  }

  private assertRestoredWorkspaceIdentity(
    session: NonNullable<ReturnType<WorkspaceStore["getSession"]>>,
    root: string,
    canonicalRoot: string,
  ): void {
    const currentInode = statSync(canonicalRoot, { bigint: true }).ino.toString();
    if (session.rootInode && session.rootInode !== currentInode) {
      throw new AccessDeniedError(`Workspace root changed after it was opened: ${root}`);
    }
    if (session.mode !== "worktree" || !session.managed) return;

    const isNewRoot = isPathInsideRoot(root, this.config.worktreeRoot);
    const configuredUuid = this.config.managedWorktreeVolumeUuid;
    const requiresVolume = Boolean(
      this.config.managedWorktreeMountPoint || configuredUuid || session.rootVolumeUuid,
    );
    if (isNewRoot && requiresVolume) {
      // Old sessions must never be rebound to a new physical SSD merely
      // because the filesystem currently happens to have the same path.
      if (!session.rootVolumeUuid
          || session.rootVolumeUuid.toUpperCase() !== configuredUuid.toUpperCase()) {
        throw new AccessDeniedError(`Unverified managed worktree volume identity: ${root}`);
      }
      verifyManagedWorktreeVolumeSync(this.config);
    } else if (session.rootVolumeUuid) {
      // A session once bound to an encrypted volume may not be restored with
      // the volume guard removed or with a different configured root.
      throw new AccessDeniedError(`Unverified managed worktree volume identity: ${root}`);
    }
    assertManagedGitWorktreeBacklink(root, session.sourceRoot);
  }

  private assertWorkspaceRootUnchanged(workspace: Workspace): void {
    let currentRoot: string;
    let currentRootStats: Stats;
    try {
      currentRoot = realpathSync(workspace.root);
      currentRootStats = statSync(currentRoot);
    } catch {
      throw new AccessDeniedError(
        `Workspace root is no longer accessible: ${workspace.root}`,
      );
    }
    if (currentRoot !== workspace.canonicalRoot
        || currentRootStats.dev !== workspace.rootDevice
        || currentRootStats.ino !== workspace.rootInode) {
      throw new AccessDeniedError(
        `Workspace root changed after it was opened: ${workspace.root}`,
      );
    }
  }

  private async loadInitialAgentsFiles(root: string): Promise<LoadedAgentsFile[]> {
    const agentDir = resolve(this.config.agentDir);
    const resolvedRoot = (await tryRealpath(root)) ?? root;
    const resolvedAgentDir = (await tryRealpath(agentDir)) ?? agentDir;
    const loadedFiles: LoadedAgentsFile[] = [];

    for (const file of loadProjectContextFiles({ cwd: root, agentDir })) {
      const path = resolve(file.path);
      if (!isInitialAgentsFilePath(path, root, agentDir)) continue;
      const content = await readResolvedContextFile(
        path,
        file.content,
        resolvedRoot,
        resolvedAgentDir,
      );
      if (content === undefined) continue;

      loadedFiles.push({
        path,
        content,
      });
    }

    return loadedFiles;
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const loadedRealPaths = new Set<string>();
    for (const file of loadedFiles) {
      const realPath = await tryRealpath(file.path);
      if (realPath) loadedRealPaths.add(realPath);
    }
    const discovered: AvailableAgentsFile[] = [];

    await walkWorkspace(root, async (path, entry) => {
      if (!entry.isFile()) return;
      if (!CONTEXT_FILE_NAMES.has(entry.name)) return;
      if (loadedPaths.has(path)) return;
      const realPath = await tryRealpath(path);
      if (realPath && loadedRealPaths.has(realPath)) return;

      discovered.push({ path });
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }
}

/** A legacy worktree without persisted inode has to prove it still belongs
 *  to the original source Git repository. This checks only Git admin pointer
 *  metadata; it never reads or changes the worktree's user files.
 */
function assertManagedGitWorktreeBacklink(root: string, sourceRoot: string | undefined): void {
  const rejected = (stage: string): never => {
    throw new AccessDeniedError(`Unverified managed Git worktree (${stage}) at the original path: ${root}`);
  };
  if (!sourceRoot) return rejected("SOURCE_MISSING");
  try {
    const pointerPath = join(root, ".git");
    const pointerStats = lstatSync(pointerPath);
    if (!pointerStats.isFile() || pointerStats.isSymbolicLink() || pointerStats.size > 4096) rejected("WORKTREE_POINTER_TYPE");
    const content = readFileSync(pointerPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) rejected("WORKTREE_POINTER_FORMAT");
    const gitAdmin = realpathSync(resolve(root, content.slice(8)));
    const sourcePointerPath = join(sourceRoot, ".git");
    const sourcePointerStats = lstatSync(sourcePointerPath);
    if (sourcePointerStats.isSymbolicLink()) rejected("SOURCE_POINTER_SYMLINK");
    let sourceGitDir: string;
    if (sourcePointerStats.isDirectory()) {
      sourceGitDir = realpathSync(sourcePointerPath);
    } else if (sourcePointerStats.isFile() && sourcePointerStats.size <= 4096) {
      // Historical nested managed worktrees may use another linked worktree
      // as their source. Follow its Git admin `commondir` back to the real
      // object store instead of requiring sourceRoot/.git to be a directory.
      const sourceLink = readFileSync(sourcePointerPath, "utf8").trim();
      if (!sourceLink.startsWith("gitdir: ")) rejected("SOURCE_POINTER_FORMAT");
      const sourceAdmin = realpathSync(resolve(sourceRoot, sourceLink.slice(8)));
      const sourceBack = readFileSync(join(sourceAdmin, "gitdir"), "utf8").trim();
      if (!sameGitPathIdentity(sourceBack, sourcePointerPath)) rejected("SOURCE_BACKLINK");
      const commonRelative = readFileSync(join(sourceAdmin, "commondir"), "utf8").trim();
      if (!commonRelative || commonRelative.length > 4096) rejected("SOURCE_COMMONDIR_FORMAT");
      sourceGitDir = realpathSync(resolve(sourceAdmin, commonRelative));
      if (!lstatSync(sourceGitDir).isDirectory()
          || !gitAdminInsideRoot(sourceAdmin, join(sourceGitDir, "worktrees"))) return rejected("SOURCE_COMMONDIR_IDENTITY");
    } else {
      return rejected("SOURCE_POINTER_TYPE");
    }
    const adminRoot = join(sourceGitDir, "worktrees");
    if (!gitAdminInsideRoot(gitAdmin, adminRoot)
        || !lstatSync(gitAdmin).isDirectory()) rejected("WORKTREE_ADMIN_IDENTITY");
    const backPointer = readFileSync(join(gitAdmin, "gitdir"), "utf8").trim();
    // macOS may report the same directory through /var and /private/var.
    // Compare physical pointer paths, not the spelling Git used at creation.
    if (!sameGitPathIdentity(backPointer, pointerPath)) rejected("WORKTREE_BACKLINK");
  } catch (error) {
    if (error instanceof AccessDeniedError) throw error;
    rejected("METADATA_UNREADABLE");
  }
}

/** Windows Git may store 8.3/long-path aliases for the same NTFS object.
 *  Keep Unix canonical-path equality; accept the same nonzero physical file
 *  identity on Windows only, never a name-only or zero-inode match.
 */
function sameGitPathIdentity(first: string, second: string): boolean {
  if (realpathSync(first) === realpathSync(second)) return true;
  if (platform() !== "win32") return false;
  const left = statSync(first, { bigint: true });
  const right = statSync(second, { bigint: true });
  return left.ino !== 0n && left.ino === right.ino && left.dev === right.dev;
}

function gitAdminInsideRoot(admin: string, root: string): boolean {
  if (admin !== root && isPathInsideRoot(admin, root)) return true;
  // Physical parent equality accepts Windows 8.3 aliases while keeping the
  // Git admin at exactly one child level of its verified common-dir/worktrees.
  return platform() === "win32" && sameGitPathIdentity(dirname(admin), root);
}

async function canonicalPath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }

      const parent = dirname(candidate);
      if (parent === candidate) return path;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat, mkdir },
): Promise<PathStats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await ops.mkdir(path, { recursive: true });
  return await ops.stat(path);
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

function isInitialAgentsFilePath(path: string, root: string, agentDir: string): boolean {
  if (isPathInsideRoot(path, agentDir)) return true;
  return isPathInsideRoot(path, root) && dirname(path) === root;
}

async function readResolvedContextFile(
  path: string,
  _fallbackContent: string,
  root: string,
  agentDir: string,
): Promise<string | undefined> {
  try {
    const resolvedPath = await realpath(path);
    if (!isInitialAgentsFilePath(resolvedPath, root, agentDir)) return undefined;
    return await readFile(resolvedPath, "utf8");
  } catch {
    return undefined;
  }
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
): Promise<void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit);
      }
      continue;
    }

    await visit(path, entry);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
