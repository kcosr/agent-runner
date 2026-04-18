import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type TaskState, VALID_STATUSES, isValidStatus } from "../../assignment/model.js";
import { setCodexThreadName } from "../../backends/codex.js";
import { setPiSessionName } from "../../backends/pi.js";
import {
  type DefinitionEntry,
  type DefinitionKind,
  listAgents,
  listAssignments,
  loadAgentConfig,
  loadAssignmentConfig,
} from "../../config/loader.js";
import { isPathArg } from "../../config/runtime-paths.js";
import type {
  AttachmentListEntry,
  AttachmentListOptions,
  RunAttachment,
  RunAttachmentRemoveResult,
} from "../../contracts/attachments.js";
import {
  type RunArchiveResult,
  type RunBackendSessionResult,
  type RunDeleteResult,
  type RunDependenciesResult,
  type RunDetail,
  type RunNameResult,
  type RunSummary,
  type RunTaskMutationCapabilities,
  canArchiveRun,
  canDeleteRun,
  canResetRun,
  canUnarchiveRun,
  deriveTaskMutationCapabilities,
  toRunArchiveResult,
  toRunBackendSessionResult,
  toRunDependenciesResult,
  toRunDetail,
  toRunNameResult,
  toRunSummary,
} from "../../contracts/runs.js";
import { resolveTaskRunnerCommand } from "../../task-runner-command.js";
import { trimRunName } from "../../util/run-name.js";
import { shortId } from "../../util/short-id.js";
import type { LoadedAgent, LoadedAssignment } from "../config/loaded.js";
import {
  AttachmentError,
  attachmentStoragePath,
  cloneAttachments,
  removeAttachmentFiles,
  resolveAttachmentOutputPath,
  stageAttachmentFromFile,
  stageAttachmentFromStream,
  validateAttachmentName,
} from "../run/attachments.js";
import {
  buildRunDependencyGraph,
  deriveDependencyStateFromSatisfiedRunIds,
  resolveDependencies,
  resolveDependentsFromManifests,
  wouldCreateDependencyCycle,
} from "../run/dependencies.js";
import {
  ResumeError,
  type RunManifest,
  RunNotFoundError,
  type TaskSnapshot,
  listRunManifests,
  resolveResumeTarget,
  writeManifest,
} from "../run/manifest.js";
import { derivePassiveTerminalStatus } from "../run/status.js";
import {
  loadWorkspaceTaskMap,
  persistWorkspaceTaskState,
  resetWorkspaceRun,
  withGlobalStateLock,
  withTaskStateLock,
  withTaskStateLockAsync,
} from "../run/workspace-state.js";

export type StatusCommandResult = RunDetail;
export type BriefCommandResult = string;

export interface DefinitionListResult {
  kind: DefinitionKind;
  entries: DefinitionEntry[];
}

export type DefinitionDetailsResult =
  | {
      kind: "agent";
      loaded: LoadedAgent;
    }
  | {
      kind: "assignment";
      loaded: LoadedAssignment;
    };

export interface RunResetResult {
  manifest: RunManifest;
}

export type RunListEntry = RunSummary;
export type {
  RunArchiveResult,
  RunBackendSessionResult,
  RunDeleteResult,
  RunDependenciesResult,
  RunNameResult,
} from "../../contracts/runs.js";

export type RunListResult = RunListEntry[];
export type RunListScopeFilter =
  | {
      kind: "cwd";
      cwd: string;
    }
  | {
      kind: "repo";
      repo: string;
    }
  | {
      kind: "global";
    };

export interface RunListFilter {
  includeArchived?: boolean;
  scope?: RunListScopeFilter;
}

export interface TaskListResult {
  manifest: RunManifest;
  tasks: TaskSnapshot[];
}

export interface TaskDetailsResult {
  manifest: RunManifest;
  task: TaskSnapshot;
}

export interface TaskMutationResult {
  manifest: RunManifest;
  task: TaskSnapshot;
}

export interface AttachmentListResult {
  manifest: RunManifest;
  attachments: AttachmentListEntry[];
}

export interface AttachmentResult {
  manifest: RunManifest;
  attachment: RunAttachment;
}

export interface AttachmentReadResult {
  manifest: RunManifest;
  attachment: RunAttachment;
  absolutePath: string;
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export class ConflictError extends CommandError {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class TaskNotFoundError extends CommandError {
  constructor(runId: string, taskId: string) {
    super(`task "${taskId}" not found in run ${runId}`);
    this.name = "TaskNotFoundError";
  }
}

type TaskMutationKind = "set" | "append-notes" | "add";

const MAX_TITLE_LENGTH = 200;

function resolveRun(target: string): ReturnType<typeof resolveResumeTarget> {
  try {
    return resolveResumeTarget(target);
  } catch (error) {
    if (!(error instanceof RunNotFoundError) || isPathArg(target)) {
      throw error;
    }

    const matches = listRunManifests().filter((entry) => entry.manifest.runId === target);
    if (matches.length === 0) {
      throw error;
    }
    if (matches.length > 1) {
      throw new CommandError(
        `run id "${target}" is ambiguous across repo buckets; use a workspace path instead (${matches.map((entry) => entry.workspaceDir).join(", ")})`,
      );
    }
    const [match] = matches;
    if (!match) {
      throw error;
    }

    return {
      workspaceDir: match.workspaceDir,
      manifest: match.manifest,
    };
  }
}

function requireResettableRun(manifest: RunManifest): void {
  if (canResetRun(manifest)) {
    return;
  }
  throw new ConflictError(
    "cannot reset a running run (run reset is rejected while a run is in-flight)",
  );
}

function requireDeletableRun(manifest: RunManifest): void {
  if (canDeleteRun(manifest)) {
    return;
  }
  if (manifest.status === "running") {
    throw new ConflictError("cannot delete a running run");
  }
  throw new CommandError(`cannot delete run ${manifest.runId} unless it is archived`);
}

function requireDependencyMutationAllowed(
  manifest: RunManifest,
  verb: "add" | "remove" | "clear",
): void {
  if (manifest.status !== "initialized") {
    throw new CommandError(
      `cannot ${verb} dependencies unless run ${manifest.runId} is initialized`,
    );
  }
}

function readRunGraph(): ReadonlyMap<string, RunManifest> {
  return buildRunDependencyGraph(listRunManifests().map((entry) => entry.manifest));
}

function withDependencyMutationLock<T>(fn: () => T): T {
  return withGlobalStateLock("run-dependencies", fn);
}

function refreshRunSnapshotAfterTaskStateSettles(
  resolved: ReturnType<typeof resolveResumeTarget>,
): void {
  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
  });
}

function taskSnapshots(manifest: RunManifest): TaskSnapshot[] {
  return Object.values(manifest.finalTasks);
}

function taskSnapshot(manifest: RunManifest, taskId: string): TaskSnapshot {
  const task = manifest.finalTasks[taskId];
  if (!task) {
    throw new TaskNotFoundError(manifest.runId, taskId);
  }
  return task;
}

function requireTaskMutationAllowed(
  manifest: RunManifest,
  kind: TaskMutationKind,
): RunTaskMutationCapabilities {
  const capabilities = deriveTaskMutationCapabilities(manifest);

  if (kind === "set") {
    if (capabilities.canSetStatus || capabilities.canEditNotes) {
      return capabilities;
    }
  }

  if (kind === "append-notes") {
    if (capabilities.canEditNotes) {
      return capabilities;
    }
  }

  if (kind === "add") {
    if (manifest.lockedFields.includes("tasks")) {
      throw new CommandError(
        "task add: the `tasks` field is locked for this run — cannot add tasks",
      );
    }
    if (capabilities.canAdd) {
      return capabilities;
    }
    if (capabilities.canEditNotes && !capabilities.canSetStatus) {
      throw new CommandError(
        `cannot add tasks to a terminal non-passive run; use ${resolveTaskRunnerCommand()} run --resume-run <id> --add-task "..." instead`,
      );
    }
  }

  if (manifest.status === "running") {
    const verb = kind === "add" ? "add tasks" : "mutate tasks";
    throw new ConflictError(
      `cannot ${verb} on a running run${kind === "add" ? " (task add remains rejected while a run is in-flight)" : " (task set and task append-notes remain allowed while a run is in-flight)"}`,
    );
  }

  throw new CommandError(
    `cannot mutate tasks on a ${manifest.status} run (task-runner task set/add is rejected while a run is in-flight)`,
  );
}

function applyPassiveFinalization(manifest: RunManifest, ordered: TaskState[]): void {
  const derived = derivePassiveTerminalStatus(ordered);

  if (manifest.status === derived) {
    return;
  }

  manifest.status = derived;
  if (derived === "initialized") {
    manifest.endedAt = null;
    manifest.exitCode = null;
  } else if (derived === "blocked") {
    manifest.endedAt = new Date().toISOString();
    manifest.exitCode = 2;
  } else {
    manifest.endedAt = new Date().toISOString();
    manifest.exitCode = 0;
  }
}

function persistTaskMap(
  resolved: ReturnType<typeof resolveResumeTarget>,
  tasks: Map<string, TaskState>,
): void {
  persistWorkspaceTaskState(resolved.manifest, tasks, {
    beforeManifestWrite: (ordered, manifest) => {
      if (manifest.backend === "passive") {
        applyPassiveFinalization(manifest, ordered);
      }
    },
    alreadyLocked: true,
  });
}

function updateTaskMap(
  resolved: ReturnType<typeof resolveResumeTarget>,
  updater: (tasks: Map<string, TaskState>) => void,
): void {
  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    const tasks = loadWorkspaceTaskMap(resolved.manifest);
    updater(tasks);
    persistTaskMap(resolved, tasks);
  });
}

function validateTaskTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new CommandError("task add: --title cannot be empty");
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new CommandError(
      `task add: --title exceeds ${MAX_TITLE_LENGTH} characters (${trimmed.length})`,
    );
  }
  if (trimmed.includes("\n")) {
    throw new CommandError("task add: --title must be a single line");
  }
  return trimmed;
}

function validateRunName(name: string): string {
  try {
    return trimRunName(name);
  } catch {
    throw new CommandError("run set-name: <name> cannot be empty");
  }
}

function validateBackendSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    throw new CommandError("run set-backend-session: <session-id> cannot be empty");
  }
  return trimmed;
}

function validateAttachmentSourcePath(sourcePath: string): void {
  if (!existsSync(sourcePath)) {
    throw new CommandError(`attachment add: source file ${sourcePath} was not found`);
  }
  const stat = statSync(sourcePath);
  if (!stat.isFile()) {
    throw new CommandError(`attachment add: ${sourcePath} is not a file`);
  }
}

async function propagateRunNameChange(manifest: RunManifest): Promise<void> {
  if (manifest.backend === "codex" && manifest.backendSessionId !== null) {
    await setCodexThreadName({
      threadId: manifest.backendSessionId,
      cwd: manifest.cwd,
      env: process.env as Record<string, string>,
      name: manifest.name,
    });
  }
  if (manifest.backend === "pi" && manifest.backendSessionId !== null) {
    await setPiSessionName({
      sessionPath: manifest.backendSessionId,
      cwd: manifest.cwd,
      env: process.env as Record<string, string>,
      name: manifest.name,
    });
  }
}

export function readStatus(target: string): StatusCommandResult {
  const resolved = resolveRun(target);
  refreshRunSnapshotAfterTaskStateSettles(resolved);

  const manifestView = resolved.manifest;
  const dependencyGraph = new Map<string, RunManifest>([[manifestView.runId, manifestView]]);
  const dependents: RunManifest[] = [];

  for (const entry of listRunManifests()) {
    const candidate = entry.manifest.runId === manifestView.runId ? manifestView : entry.manifest;
    if (manifestView.dependencyRunIds.includes(candidate.runId)) {
      dependencyGraph.set(candidate.runId, candidate);
    }
    if (
      candidate.runId !== manifestView.runId &&
      candidate.dependencyRunIds.includes(manifestView.runId)
    ) {
      dependents.push(candidate);
    }
  }

  return toRunDetail({
    manifest: manifestView,
    isLive: false,
    dependencies: resolveDependencies(manifestView, dependencyGraph),
    dependents: resolveDependentsFromManifests(manifestView.runId, dependents),
  });
}

export function readBrief(target: string): BriefCommandResult {
  const resolved = resolveRun(target);
  refreshRunSnapshotAfterTaskStateSettles(resolved);
  return resolved.manifest.brief;
}

export function listDefinitions(kind: DefinitionKind): DefinitionListResult {
  return {
    kind,
    entries: kind === "agent" ? listAgents() : listAssignments(),
  };
}

function matchesRunListScope(
  manifest: RunManifest,
  scope: RunListScopeFilter | undefined,
): boolean {
  if (scope === undefined || scope.kind === "global") {
    return true;
  }
  switch (scope.kind) {
    case "cwd":
      return manifest.cwd === scope.cwd;
    case "repo":
      return manifest.repo === scope.repo;
    default: {
      const unreachableScope: never = scope;
      return unreachableScope;
    }
  }
}

export function listRuns(filter: RunListFilter = {}): RunListResult {
  const includeArchived = filter.includeArchived === true;
  const entries = listRunManifests();
  const projectedEntries = entries.map((entry) => ({
    ...entry,
    manifest: entry.manifest,
  }));
  const successfulRunIds = new Set(
    projectedEntries
      .filter((entry) => entry.manifest.status === "success")
      .map((entry) => entry.manifest.runId),
  );
  return projectedEntries
    .filter((entry) => matchesRunListScope(entry.manifest, filter.scope))
    .map((entry) =>
      toRunSummary(
        entry,
        undefined,
        deriveDependencyStateFromSatisfiedRunIds(entry.manifest, successfulRunIds),
      ),
    )
    .filter((entry) => includeArchived || entry.archivedAt === null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function showDefinition(
  kind: DefinitionKind,
  target: string,
  cwd?: string,
): DefinitionDetailsResult {
  if (kind === "agent") {
    return {
      kind,
      loaded: loadAgentConfig(target, cwd),
    };
  }
  return {
    kind,
    loaded: loadAssignmentConfig(target, cwd),
  };
}

export function resetRun(target: string): RunResetResult {
  const resolved = resolveRun(target);
  requireResettableRun(resolved.manifest);
  return {
    manifest: resetWorkspaceRun(resolved.workspaceDir),
  };
}

function setRunArchived(target: string, archived: boolean): RunArchiveResult {
  const resolved = resolveRun(target);
  let changed = false;

  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    if (resolved.manifest.status === "running") {
      throw new ConflictError(`cannot ${archived ? "archive" : "unarchive"} a running run`);
    }

    const alreadyArchived = resolved.manifest.archivedAt !== null;
    if (archived) {
      if (alreadyArchived) {
        return;
      }
      resolved.manifest.archivedAt = new Date().toISOString();
      changed = true;
    } else {
      if (!alreadyArchived) {
        return;
      }
      resolved.manifest.archivedAt = null;
      changed = true;
    }

    writeManifest(resolved.workspaceDir, resolved.manifest);
  });

  return toRunArchiveResult({
    manifest: resolved.manifest,
    changed,
  });
}

export function archiveRun(target: string): RunArchiveResult {
  return setRunArchived(target, true);
}

export function unarchiveRun(target: string): RunArchiveResult {
  return setRunArchived(target, false);
}

export function deleteRun(target: string): RunDeleteResult {
  const resolved = resolveRun(target);
  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    requireDeletableRun(resolved.manifest);
    rmSync(resolved.workspaceDir, { recursive: true, force: true });
  });
  return { runId: resolved.manifest.runId };
}

export async function setRunName(
  target: string,
  input: { name: string | null },
): Promise<RunNameResult> {
  const resolved = resolveRun(target);
  let changed = false;

  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    const nextName = input.name === null ? null : validateRunName(input.name);
    if (resolved.manifest.name === nextName) {
      return;
    }
    resolved.manifest.name = nextName;
    resolved.manifest.resetSeed.name = nextName;
    writeManifest(resolved.workspaceDir, resolved.manifest);
    changed = true;
  });

  if (changed) {
    try {
      await propagateRunNameChange(resolved.manifest);
    } catch {
      // Best-effort backend propagation. The manifest update is canonical.
    }
  }

  return toRunNameResult({
    manifest: resolved.manifest,
    changed,
  });
}

function requirePassiveBackendSessionMutation(manifest: RunManifest, verb: "set" | "clear"): void {
  if (manifest.backend === "passive") {
    return;
  }
  throw new CommandError(
    `run ${verb}-backend-session: post-creation backend session mutation is only allowed for passive runs`,
  );
}

export function setRunBackendSession(
  target: string,
  input: { backendSessionId: string },
): RunBackendSessionResult {
  const resolved = resolveRun(target);
  let changed = false;

  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    requirePassiveBackendSessionMutation(resolved.manifest, "set");
    const nextBackendSessionId = validateBackendSessionId(input.backendSessionId);
    if (resolved.manifest.backendSessionId === nextBackendSessionId) {
      return;
    }
    resolved.manifest.backendSessionId = nextBackendSessionId;
    writeManifest(resolved.workspaceDir, resolved.manifest);
    changed = true;
  });

  return toRunBackendSessionResult({
    manifest: resolved.manifest,
    changed,
  });
}

export function clearRunBackendSession(target: string): RunBackendSessionResult {
  const resolved = resolveRun(target);
  let changed = false;

  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    requirePassiveBackendSessionMutation(resolved.manifest, "clear");
    if (resolved.manifest.backendSessionId === null) {
      return;
    }
    resolved.manifest.backendSessionId = null;
    writeManifest(resolved.workspaceDir, resolved.manifest);
    changed = true;
  });

  return toRunBackendSessionResult({
    manifest: resolved.manifest,
    changed,
  });
}

export function addRunDependency(target: string, dependencyTarget: string): RunDependenciesResult {
  const resolved = resolveRun(target);
  let changed = false;

  withDependencyMutationLock(() => {
    withTaskStateLock(resolved.workspaceDir, () => {
      resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
      requireDependencyMutationAllowed(resolved.manifest, "add");

      let dependencyManifest: RunManifest;
      try {
        dependencyManifest = resolveRun(dependencyTarget).manifest;
      } catch (err) {
        if (err instanceof RunNotFoundError) {
          throw new CommandError(`run add-dep: dependency run ${dependencyTarget} was not found`);
        }
        throw err;
      }

      if (dependencyManifest.runId === resolved.manifest.runId) {
        throw new CommandError(
          `run add-dep: run ${resolved.manifest.runId} cannot depend on itself`,
        );
      }
      if (resolved.manifest.dependencyRunIds.includes(dependencyManifest.runId)) {
        throw new CommandError(
          `run add-dep: dependency ${dependencyManifest.runId} already exists on run ${resolved.manifest.runId}`,
        );
      }

      const graph = readRunGraph();
      const graphWithTarget = new Map(graph);
      graphWithTarget.set(resolved.manifest.runId, resolved.manifest);
      graphWithTarget.set(dependencyManifest.runId, dependencyManifest);
      if (
        wouldCreateDependencyCycle(
          graphWithTarget,
          resolved.manifest.runId,
          dependencyManifest.runId,
        )
      ) {
        throw new CommandError(
          `run add-dep: adding dependency ${dependencyManifest.runId} would create a cycle`,
        );
      }

      resolved.manifest.dependencyRunIds = [
        ...resolved.manifest.dependencyRunIds,
        dependencyManifest.runId,
      ];
      resolved.manifest.resetSeed.dependencyRunIds = [...resolved.manifest.dependencyRunIds];
      writeManifest(resolved.workspaceDir, resolved.manifest);
      changed = true;
    });
  });

  return toRunDependenciesResult({
    manifest: resolved.manifest,
    changed,
  });
}

export function removeRunDependency(
  target: string,
  dependencyRunId: string,
): RunDependenciesResult {
  const resolved = resolveRun(target);
  let changed = false;

  withDependencyMutationLock(() => {
    withTaskStateLock(resolved.workspaceDir, () => {
      resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
      requireDependencyMutationAllowed(resolved.manifest, "remove");

      if (!resolved.manifest.dependencyRunIds.includes(dependencyRunId)) {
        throw new CommandError(
          `run remove-dep: dependency ${dependencyRunId} does not exist on run ${resolved.manifest.runId}`,
        );
      }

      resolved.manifest.dependencyRunIds = resolved.manifest.dependencyRunIds.filter(
        (runId) => runId !== dependencyRunId,
      );
      resolved.manifest.resetSeed.dependencyRunIds = [...resolved.manifest.dependencyRunIds];
      writeManifest(resolved.workspaceDir, resolved.manifest);
      changed = true;
    });
  });

  return toRunDependenciesResult({
    manifest: resolved.manifest,
    changed,
  });
}

export function clearRunDependencies(target: string): RunDependenciesResult {
  const resolved = resolveRun(target);
  let changed = false;

  withDependencyMutationLock(() => {
    withTaskStateLock(resolved.workspaceDir, () => {
      resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
      requireDependencyMutationAllowed(resolved.manifest, "clear");

      if (resolved.manifest.dependencyRunIds.length === 0) {
        return;
      }

      resolved.manifest.dependencyRunIds = [];
      resolved.manifest.resetSeed.dependencyRunIds = [];
      writeManifest(resolved.workspaceDir, resolved.manifest);
      changed = true;
    });
  });

  return toRunDependenciesResult({
    manifest: resolved.manifest,
    changed,
  });
}

export function listTasks(target: string): TaskListResult {
  const resolved = resolveRun(target);
  refreshRunSnapshotAfterTaskStateSettles(resolved);
  return {
    manifest: resolved.manifest,
    tasks: taskSnapshots(resolved.manifest),
  };
}

function toAttachmentListEntry(attachment: RunAttachment, ownerRunId: string): AttachmentListEntry {
  return {
    ...attachment,
    ownerRunId,
  };
}

function listAttachmentOwnerManifests(
  target: string,
  options: AttachmentListOptions = {},
): AttachmentListResult["manifest"][] {
  const resolved = resolveRun(target);
  refreshRunSnapshotAfterTaskStateSettles(resolved);
  if (!options.cwdScope) {
    return [resolved.manifest];
  }

  const matchingEntries = listRunManifests()
    .filter((entry) => entry.manifest.cwd === resolved.manifest.cwd)
    .sort((left, right) => {
      const startedAtCompare = left.manifest.startedAt.localeCompare(right.manifest.startedAt);
      if (startedAtCompare !== 0) {
        return startedAtCompare;
      }
      return left.manifest.runId.localeCompare(right.manifest.runId);
    });

  return matchingEntries.map((entry) => {
    const peerResolved = resolveResumeTarget(entry.workspaceDir);
    refreshRunSnapshotAfterTaskStateSettles(peerResolved);
    return peerResolved.manifest;
  });
}

export function listAttachments(
  target: string,
  options: AttachmentListOptions = {},
): AttachmentListResult {
  const [manifest, ...peerManifests] = listAttachmentOwnerManifests(target, options);
  if (manifest === undefined) {
    throw new Error("attachment list requires a resolved run manifest");
  }
  return {
    manifest,
    attachments: [manifest, ...peerManifests].flatMap((entry) =>
      cloneAttachments(entry.attachments).map((attachment) =>
        toAttachmentListEntry(attachment, entry.runId),
      ),
    ),
  };
}

export function readAttachment(target: string, attachmentId: string): AttachmentReadResult {
  const resolved = resolveRun(target);
  refreshRunSnapshotAfterTaskStateSettles(resolved);
  const { attachment, absolutePath } = attachmentStoragePath(resolved.manifest, attachmentId);
  return {
    manifest: resolved.manifest,
    attachment,
    absolutePath,
  };
}

export async function addAttachmentFromFile(
  target: string,
  input: { sourcePath: string; name?: string; mimeType?: string },
): Promise<AttachmentResult> {
  const resolved = resolveRun(target);
  const sourcePath = resolve(input.sourcePath);
  validateAttachmentSourcePath(sourcePath);
  const displayName = input.name ?? basename(sourcePath);
  try {
    validateAttachmentName(displayName, "attachment add: --name");
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }

  let attachment!: RunAttachment;
  await withTaskStateLockAsync(resolved.workspaceDir, async () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    attachment = await stageAttachmentFromFile(resolved.manifest, {
      id: `att-${shortId()}`,
      name: displayName,
      sourcePath,
      mimeType: input.mimeType,
    });
    resolved.manifest.attachments = [...resolved.manifest.attachments, attachment];
    writeManifest(resolved.workspaceDir, resolved.manifest);
  });

  return {
    manifest: resolved.manifest,
    attachment,
  };
}

export async function addAttachmentFromStream(
  target: string,
  input: { name: string; source: AsyncIterable<Uint8Array>; mimeType?: string },
): Promise<AttachmentResult> {
  const resolved = resolveRun(target);
  try {
    validateAttachmentName(input.name, "attachment name");
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }

  let attachment!: RunAttachment;
  await withTaskStateLockAsync(resolved.workspaceDir, async () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    attachment = await stageAttachmentFromStream(resolved.manifest, {
      id: `att-${shortId()}`,
      name: input.name,
      source: input.source,
      mimeType: input.mimeType,
    });
    resolved.manifest.attachments = [...resolved.manifest.attachments, attachment];
    writeManifest(resolved.workspaceDir, resolved.manifest);
  });

  return {
    manifest: resolved.manifest,
    attachment,
  };
}

export function removeAttachment(target: string, attachmentId: string): RunAttachmentRemoveResult {
  const resolved = resolveRun(target);
  let changed = false;

  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    removeAttachmentFiles(resolved.manifest, attachmentId);
    resolved.manifest.attachments = resolved.manifest.attachments.filter(
      (attachment) => attachment.id !== attachmentId,
    );
    writeManifest(resolved.workspaceDir, resolved.manifest);
    changed = true;
  });

  return {
    runId: resolved.manifest.runId,
    attachmentId,
    changed,
  };
}

export function downloadAttachment(
  target: string,
  attachmentId: string,
  outputPath: string,
): RunAttachment & { outputPath: string } {
  const { attachment, absolutePath } = readAttachment(target, attachmentId);
  const resolvedOutputPath = resolveAttachmentOutputPath(outputPath, attachment.name);
  copyFileSync(absolutePath, resolvedOutputPath);
  return {
    ...attachment,
    outputPath: resolvedOutputPath,
  };
}

export function showTask(target: string, taskId: string): TaskDetailsResult {
  const resolved = resolveRun(target);
  refreshRunSnapshotAfterTaskStateSettles(resolved);
  return {
    manifest: resolved.manifest,
    task: taskSnapshot(resolved.manifest, taskId),
  };
}

export function setTask(
  target: string,
  taskId: string,
  update: { status?: string; notes?: string },
): TaskMutationResult {
  if (update.status === undefined && update.notes === undefined) {
    throw new CommandError("task set requires at least one of --status / --notes");
  }
  if (update.status !== undefined && !isValidStatus(update.status)) {
    throw new CommandError(
      `invalid --status "${update.status}" — expected one of: ${VALID_STATUSES.join(", ")}`,
    );
  }

  const resolved = resolveRun(target);
  const capabilities = requireTaskMutationAllowed(resolved.manifest, "set");

  updateTaskMap(resolved, (tasks) => {
    const task = tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(resolved.manifest.runId, taskId);
    }
    if (
      update.status !== undefined &&
      update.status !== task.status &&
      !capabilities.canSetStatus
    ) {
      throw new CommandError(
        `cannot change task status on a terminal non-passive run; use ${resolveTaskRunnerCommand()} run --resume-run <id> with a follow-up message instead`,
      );
    }
    if (update.status !== undefined) {
      task.status = update.status as TaskState["status"];
    }
    if (update.notes !== undefined) {
      task.notes = update.notes;
    }
  });

  return {
    manifest: resolved.manifest,
    task: taskSnapshot(resolved.manifest, taskId),
  };
}

export function appendTaskNotes(target: string, taskId: string, text: string): TaskMutationResult {
  const appendText = text.trim();
  if (appendText.length === 0) {
    throw new CommandError("task append-notes: --text cannot be empty");
  }

  const resolved = resolveRun(target);
  const capabilities = requireTaskMutationAllowed(resolved.manifest, "append-notes");

  updateTaskMap(resolved, (tasks) => {
    const task = tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(resolved.manifest.runId, taskId);
    }
    task.notes = task.notes.length === 0 ? appendText : `${task.notes}\n${appendText}`;
  });

  return {
    manifest: resolved.manifest,
    task: taskSnapshot(resolved.manifest, taskId),
  };
}

export function addTask(
  target: string,
  input: { title: string; body?: string },
): TaskMutationResult {
  const title = validateTaskTitle(input.title);
  const resolved = resolveRun(target);
  requireTaskMutationAllowed(resolved.manifest, "add");

  let taskId = "";
  updateTaskMap(resolved, (tasks) => {
    do {
      taskId = `cli-${shortId()}`;
    } while (tasks.has(taskId));
    tasks.set(taskId, {
      id: taskId,
      title,
      body: input.body ?? "",
      status: "pending",
      notes: "",
    });
  });

  return {
    manifest: resolved.manifest,
    task: taskSnapshot(resolved.manifest, taskId),
  };
}

export function isCommandError(err: unknown): err is CommandError | ResumeError | AttachmentError {
  return (
    err instanceof CommandError || err instanceof ResumeError || err instanceof AttachmentError
  );
}
