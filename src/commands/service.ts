import { readFileSync } from "node:fs";
import { type TaskState, VALID_STATUSES, isValidStatus } from "../assignment/model.js";
import { parseAssignment } from "../assignment/parser.js";
import {
  type DefinitionEntry,
  type DefinitionKind,
  type LoadedAgent,
  type LoadedAssignment,
  listAgents,
  listAssignments,
  loadAgentConfig,
  loadAssignmentConfig,
} from "../config/loader.js";
import {
  type ListedRunManifest,
  type ManifestStatus,
  ResumeError,
  type RunManifest,
  type TaskSnapshot,
  listRunManifests,
  resolveResumeTarget,
  workspaceAssignmentPath,
  writeManifest,
} from "../runner/manifest.js";
import { type LiveTaskOverlay, applyLiveOverlay } from "../runner/output.js";
import {
  loadWorkspaceTaskMap,
  persistWorkspaceTaskState,
  resetWorkspaceRun,
  taskModeFromManifest,
  withTaskStateLock,
} from "../runner/workspace-state.js";
import { resolveTaskRunnerCommand } from "../task-runner-command.js";
import { shortId } from "../util/short-id.js";

export interface StatusCommandResult {
  manifest: RunManifest;
  isLive: boolean;
}

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

export interface RunListEntry {
  runId: string;
  repo: string;
  status: ManifestStatus;
  archivedAt: string | null;
  agentName: string;
  assignmentName: string | null;
  backend: string;
  model: string | null;
  sessionName: string | null;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  tasksCompleted: number;
  tasksTotal: number;
}

export interface RunListResult {
  runs: RunListEntry[];
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

export interface RunArchiveResult {
  manifest: RunManifest;
  changed: boolean;
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

type TaskMutationKind = "set" | "append-notes" | "add";

const MUTATION_ALLOWED_STATUSES = new Set<ManifestStatus>([
  "initialized",
  "success",
  "blocked",
  "exhausted",
  "aborted",
  "error",
]);

const TERMINAL_MUTATION_STATUSES = new Set<ManifestStatus>([
  "success",
  "blocked",
  "exhausted",
  "aborted",
  "error",
]);

const MAX_TITLE_LENGTH = 200;

function resolveRun(target: string): ReturnType<typeof resolveResumeTarget> {
  return resolveResumeTarget(target);
}

function requireArchivableRun(manifest: RunManifest, verb: "archive" | "unarchive"): void {
  if (manifest.status === "running") {
    throw new CommandError(`cannot ${verb} a running run`);
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
    throw new CommandError(`task "${taskId}" not found in run ${manifest.runId}`);
  }
  return task;
}

function requireMutableStatus(manifest: RunManifest): void {
  if (!MUTATION_ALLOWED_STATUSES.has(manifest.status)) {
    throw new CommandError(
      `cannot mutate tasks on a ${manifest.status} run (task-runner task set/add is rejected while a run is in-flight)`,
    );
  }
}

function requireTaskMutationAllowed(manifest: RunManifest, kind: TaskMutationKind): void {
  if (manifest.status === "running") {
    if (taskModeFromManifest(manifest) === "cli" && (kind === "set" || kind === "append-notes")) {
      return;
    }

    const verb = kind === "add" ? "add tasks" : "mutate tasks";
    throw new CommandError(
      `cannot ${verb} on a running ${taskModeFromManifest(manifest)}-mode run${kind === "add" ? " (task add remains rejected while a run is in-flight)" : " (task CLI mutation during a run is only allowed in taskMode=cli for task set/append-notes)"}`,
    );
  }

  requireMutableStatus(manifest);
}

function isTerminalNonPassiveRun(manifest: RunManifest): boolean {
  return manifest.backend !== "passive" && TERMINAL_MUTATION_STATUSES.has(manifest.status);
}

function applyPassiveFinalization(manifest: RunManifest, ordered: TaskState[]): void {
  let hasOpen = false;
  let hasBlocked = false;
  for (const task of ordered) {
    if (task.status === "pending" || task.status === "in_progress") hasOpen = true;
    if (task.status === "blocked") hasBlocked = true;
  }

  let derived: ManifestStatus;
  if (ordered.length === 0 || hasOpen) {
    derived = "initialized";
  } else if (hasBlocked) {
    derived = "blocked";
  } else {
    derived = "success";
  }

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

  return { manifest: manifestView, isLive };
}

export function listDefinitions(kind: DefinitionKind): DefinitionListResult {
  return {
    kind,
    entries: kind === "agent" ? listAgents() : listAssignments(),
  };
}

function runListEntryFromManifest(entry: ListedRunManifest): RunListEntry {
  return {
    runId: entry.manifest.runId,
    repo: entry.repo,
    status: entry.manifest.status,
    archivedAt: entry.manifest.archivedAt,
    agentName: entry.manifest.agent.name,
    assignmentName: entry.manifest.assignment?.name ?? null,
    backend: entry.manifest.backend,
    model: entry.manifest.model,
    sessionName: entry.manifest.sessionName,
    cwd: entry.manifest.cwd,
    startedAt: entry.manifest.startedAt,
    endedAt: entry.manifest.endedAt,
    tasksCompleted: entry.manifest.tasksCompleted,
    tasksTotal: entry.manifest.tasksTotal,
  };
}

export function listRuns(opts: { includeArchived?: boolean } = {}): RunListResult {
  const includeArchived = opts.includeArchived === true;
  const runs = listRunManifests()
    .map(runListEntryFromManifest)
    .filter((entry) => includeArchived || entry.archivedAt === null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { runs };
}

export function showDefinition(kind: DefinitionKind, target: string): DefinitionDetailsResult {
  if (kind === "agent") {
    return {
      kind,
      loaded: loadAgentConfig(target),
    };
  }
  return {
    kind,
    loaded: loadAssignmentConfig(target),
  };
}

export function resetRun(target: string): RunResetResult {
  const resolved = resolveRun(target);
  if (resolved.manifest.status === "running") {
    throw new CommandError(
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

  return {
    manifest: resolved.manifest,
    changed,
  };
}

export function archiveRun(target: string): RunArchiveResult {
  return setRunArchived(target, true);
}

export function unarchiveRun(target: string): RunArchiveResult {
  return setRunArchived(target, false);
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
  requireTaskMutationAllowed(resolved.manifest, "set");

  updateTaskMap(
    resolved,
    {
      applyStatus: !isTerminalNonPassiveRun(resolved.manifest),
    },
    (tasks) => {
      const task = tasks.get(taskId);
      if (!task) {
        throw new CommandError(`task "${taskId}" not found in run ${resolved.manifest.runId}`);
      }
      if (
        update.status !== undefined &&
        update.status !== task.status &&
        isTerminalNonPassiveRun(resolved.manifest)
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
  requireTaskMutationAllowed(resolved.manifest, "append-notes");

  updateTaskMap(
    resolved,
    {
      applyStatus: !isTerminalNonPassiveRun(resolved.manifest),
    },
    (tasks) => {
      const task = tasks.get(taskId);
      if (!task) {
        throw new CommandError(`task "${taskId}" not found in run ${resolved.manifest.runId}`);
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
  if (isTerminalNonPassiveRun(resolved.manifest)) {
    throw new CommandError(
      `cannot add tasks to a terminal non-passive run; use ${resolveTaskRunnerCommand()} run --resume-run <id> --add-task "..." instead`,
    );
  }
  if (resolved.manifest.lockedFields.includes("tasks")) {
    throw new CommandError("task add: the `tasks` field is locked for this run — cannot add tasks");
  }

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
