import { readFileSync } from "node:fs";
import { type TaskState, VALID_STATUSES, isValidStatus } from "../../assignment/model.js";
import { parseAssignment } from "../../assignment/parser.js";
import { setCodexThreadName } from "../../backends/codex.js";
import {
  type DefinitionEntry,
  type DefinitionKind,
  listAgents,
  listAssignments,
  loadAgentConfig,
  loadAssignmentConfig,
} from "../../config/loader.js";
import {
  type RunArchiveResult,
  type RunDetail,
  type RunNameResult,
  type RunSummary,
  type RunTaskMutationCapabilities,
  deriveTaskMutationCapabilities,
  toRunArchiveResult,
  toRunDetail,
  toRunNameResult,
  toRunSummary,
} from "../../contracts/runs.js";
import { resolveTaskRunnerCommand } from "../../task-runner-command.js";
import { trimRunName } from "../../util/run-name.js";
import { shortId } from "../../util/short-id.js";
import type { LoadedAgent, LoadedAssignment } from "../config/loaded.js";
import {
  ResumeError,
  type RunManifest,
  type TaskSnapshot,
  listRunManifests,
  resolveResumeTarget,
  workspaceAssignmentPath,
  writeManifest,
} from "../run/manifest.js";
import {
  type LiveTaskOverlay,
  applyLiveOverlay,
  derivePassiveTerminalStatus,
} from "../run/status.js";
import {
  loadWorkspaceTaskMap,
  persistWorkspaceTaskState,
  resetWorkspaceRun,
  taskModeFromManifest,
  withTaskStateLock,
} from "../run/workspace-state.js";

export type StatusCommandResult = RunDetail;

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
export type { RunArchiveResult, RunNameResult } from "../../contracts/runs.js";

export type RunListResult = RunListEntry[];

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
  return resolveResumeTarget(target);
}

function requireArchivableRun(manifest: RunManifest, verb: "archive" | "unarchive"): void {
  if (manifest.status === "running") {
    throw new ConflictError(`cannot ${verb} a running run`);
  }
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
      `cannot ${verb} on a running ${taskModeFromManifest(manifest)}-mode run${kind === "add" ? " (task add remains rejected while a run is in-flight)" : " (task CLI mutation during a run is only allowed in taskMode=cli for task set/append-notes)"}`,
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
  mergeOptions: Parameters<typeof loadWorkspaceTaskMap>[1],
  updater: (tasks: Map<string, TaskState>) => void,
): void {
  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    const tasks = loadWorkspaceTaskMap(resolved.manifest, mergeOptions);
    updater(tasks);
    persistTaskMap(resolved, tasks);
  });
}

function liveOverlay(rawAssignment: string): LiveTaskOverlay {
  const overlay: LiveTaskOverlay = new Map();
  for (const update of parseAssignment(rawAssignment)) {
    overlay.set(update.taskId, { status: update.status, notes: update.notes });
  }
  return overlay;
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

async function propagateRunNameChange(manifest: RunManifest): Promise<void> {
  if (manifest.backend !== "codex" || manifest.backendSessionId === null) {
    return;
  }
  await setCodexThreadName({
    threadId: manifest.backendSessionId,
    cwd: manifest.cwd,
    env: process.env as Record<string, string>,
    name: manifest.name,
  });
}

export function readStatus(target: string): StatusCommandResult {
  const resolved = resolveRun(target);
  refreshRunSnapshotAfterTaskStateSettles(resolved);

  let isLive = false;
  let manifestView = resolved.manifest;
  if (
    resolved.manifest.status === "running" &&
    taskModeFromManifest(resolved.manifest) === "file"
  ) {
    try {
      const raw = readFileSync(workspaceAssignmentPath(resolved.workspaceDir), "utf8");
      const overlay = liveOverlay(raw);
      if (overlay.size > 0) {
        manifestView = applyLiveOverlay(resolved.manifest, overlay);
        isLive = true;
      }
    } catch {
      // Fall back to the persisted manifest snapshot.
    }
  }

  return toRunDetail({ manifest: manifestView, isLive });
}

export function listDefinitions(kind: DefinitionKind): DefinitionListResult {
  return {
    kind,
    entries: kind === "agent" ? listAgents() : listAssignments(),
  };
}

export function listRuns(opts: { includeArchived?: boolean } = {}): RunListResult {
  const includeArchived = opts.includeArchived === true;
  return listRunManifests()
    .map(toRunSummary)
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
  if (resolved.manifest.status === "running") {
    throw new ConflictError(
      "cannot reset a running run (run reset is rejected while a run is in-flight)",
    );
  }
  return {
    manifest: resetWorkspaceRun(resolved.workspaceDir),
  };
}

function setRunArchived(target: string, archived: boolean): RunArchiveResult {
  const resolved = resolveRun(target);
  let changed = false;

  withTaskStateLock(resolved.workspaceDir, () => {
    resolved.manifest = resolveResumeTarget(resolved.workspaceDir).manifest;
    requireArchivableRun(resolved.manifest, archived ? "archive" : "unarchive");

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

export function listTasks(target: string): TaskListResult {
  const resolved = resolveRun(target);
  refreshRunSnapshotAfterTaskStateSettles(resolved);
  return {
    manifest: resolved.manifest,
    tasks: taskSnapshots(resolved.manifest),
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

  updateTaskMap(
    resolved,
    {
      applyStatus: capabilities.canSetStatus,
    },
    (tasks) => {
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
    },
  );

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

  updateTaskMap(
    resolved,
    {
      applyStatus: capabilities.canSetStatus,
    },
    (tasks) => {
      const task = tasks.get(taskId);
      if (!task) {
        throw new TaskNotFoundError(resolved.manifest.runId, taskId);
      }
      task.notes = task.notes.length === 0 ? appendText : `${task.notes}\n${appendText}`;
    },
  );

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
  updateTaskMap(resolved, {}, (tasks) => {
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

export function isCommandError(err: unknown): err is CommandError | ResumeError {
  return err instanceof CommandError || err instanceof ResumeError;
}
