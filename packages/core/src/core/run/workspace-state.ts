import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type MergeOptions, type MergeResult, mergeUpdates } from "../../assignment/merge.js";
import type { TaskState } from "../../assignment/model.js";
import { parseAssignment } from "../../assignment/parser.js";
import { renderAssignment } from "../../assignment/writer.js";
import { writeTextFileAtomic } from "../../util/write-file-atomic.js";
import { normalizeTaskMode } from "../config/schema.js";
import {
  type RunManifest,
  applyRunResetSeed,
  manifestPath,
  snapshotTasks,
  workspaceAssignmentPath,
  writeManifest,
} from "./manifest.js";

const LOCK_DIR_NAME = ".task-state.lock";
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, ms);
}

export function taskModeFromManifest(manifest: Pick<RunManifest, "taskMode">): "file" | "cli" {
  return normalizeTaskMode(manifest.taskMode);
}

function taskLockPath(workspaceDir: string): string {
  return `${workspaceDir}/${LOCK_DIR_NAME}`;
}

export function withTaskStateLock<T>(workspaceDir: string, fn: () => T): T {
  const lockPath = taskLockPath(workspaceDir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for task-state lock at ${lockPath}`);
      }
      sleep(LOCK_WAIT_MS);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function readManifestSnapshot(workspaceDir: string): RunManifest {
  return JSON.parse(readFileSync(manifestPath(workspaceDir), "utf8")) as RunManifest;
}

function orderedTasks(tasks: Map<string, TaskState>): TaskState[] {
  return Array.from(tasks.values());
}

export function taskMapFromManifestSnapshot(manifest: RunManifest): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();
  for (const snap of Object.values(manifest.finalTasks)) {
    tasks.set(snap.id, {
      id: snap.id,
      title: snap.title,
      body: snap.body,
      status: snap.status,
      notes: snap.notes,
    });
  }
  return tasks;
}

export function refreshManifestTaskState(manifest: RunManifest): Map<string, TaskState> {
  const latest = readManifestSnapshot(manifest.workspaceDir);
  manifest.taskMode = latest.taskMode;
  manifest.finalTasks = latest.finalTasks;
  manifest.tasksCompleted = latest.tasksCompleted;
  manifest.tasksTotal = latest.tasksTotal;
  return taskMapFromManifestSnapshot(latest);
}

export function syncManifestTaskState(
  manifest: RunManifest,
  tasks: Map<string, TaskState>,
): TaskState[] {
  const ordered = orderedTasks(tasks);
  manifest.finalTasks = snapshotTasks(tasks);
  manifest.tasksCompleted = ordered.filter((task) => task.status === "completed").length;
  manifest.tasksTotal = ordered.length;
  return ordered;
}

function ensureWorkspaceAssignmentText(
  workspaceDir: string,
  tasks: Map<string, TaskState>,
): string {
  const assignmentPath = workspaceAssignmentPath(workspaceDir);
  let rawAssignment = "";
  try {
    rawAssignment = readFileSync(assignmentPath, "utf8");
  } catch {
    // fall back to a freshly rendered assignment below
  }

  if (rawAssignment.trim().length > 0) {
    return rawAssignment;
  }

  const rendered = renderAssignment(orderedTasks(tasks));
  writeTextFileAtomic(assignmentPath, rendered);
  return rendered;
}

export interface WorkspaceMergeResult {
  rawAssignment: string;
  mergeInfo: MergeResult;
}

export function mergeWorkspaceAssignmentIntoTaskMap(
  manifest: RunManifest,
  tasks: Map<string, TaskState>,
  mergeOptions: MergeOptions = {},
): WorkspaceMergeResult {
  if (taskModeFromManifest(manifest) === "cli") {
    return {
      rawAssignment: renderAssignment(orderedTasks(tasks)),
      mergeInfo: {
        invalidStatuses: [],
        missingFromFile: [],
        unknownInFile: [],
      },
    };
  }

  const rawAssignment = ensureWorkspaceAssignmentText(manifest.workspaceDir, tasks);
  const updates = parseAssignment(rawAssignment);
  return {
    rawAssignment,
    mergeInfo: mergeUpdates(tasks, updates, mergeOptions),
  };
}

export function loadWorkspaceTaskMap(
  manifest: RunManifest,
  mergeOptions: MergeOptions = {},
): Map<string, TaskState> {
  const tasks = taskMapFromManifestSnapshot(manifest);
  if (taskModeFromManifest(manifest) === "file") {
    mergeWorkspaceAssignmentIntoTaskMap(manifest, tasks, mergeOptions);
  }
  return tasks;
}

export function persistWorkspaceTaskState(
  manifest: RunManifest,
  tasks: Map<string, TaskState>,
  opts: {
    beforeManifestWrite?: (ordered: TaskState[], manifest: RunManifest) => void;
    alreadyLocked?: boolean;
  } = {},
): TaskState[] {
  const persist = (): TaskState[] => {
    const ordered = syncManifestTaskState(manifest, tasks);
    writeTextFileAtomic(workspaceAssignmentPath(manifest.workspaceDir), renderAssignment(ordered));
    opts.beforeManifestWrite?.(ordered, manifest);
    writeManifest(manifest.workspaceDir, manifest);
    return ordered;
  };

  if (opts.alreadyLocked) {
    return persist();
  }

  return withTaskStateLock(manifest.workspaceDir, persist);
}

export function resetWorkspaceRun(workspaceDir: string): RunManifest {
  return withTaskStateLock(workspaceDir, () => {
    const manifest = readManifestSnapshot(workspaceDir);
    if (manifest.status === "running") {
      throw new Error(
        "cannot reset a running run (run reset is rejected while a run is in-flight)",
      );
    }

    applyRunResetSeed(manifest);
    rmSync(join(workspaceDir, "attempts"), { recursive: true, force: true });
    persistWorkspaceTaskState(manifest, taskMapFromManifestSnapshot(manifest), {
      alreadyLocked: true,
    });
    return manifest;
  });
}
