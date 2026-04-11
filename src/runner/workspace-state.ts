import { readFileSync } from "node:fs";
import { type MergeResult, mergeUpdates } from "../assignment/merge.js";
import type { TaskState } from "../assignment/model.js";
import { parseAssignment } from "../assignment/parser.js";
import { renderAssignment } from "../assignment/writer.js";
import { writeTextFileAtomic } from "../util/write-file-atomic.js";
import {
  type RunManifest,
  snapshotTasks,
  workspaceAssignmentPath,
  writeManifest,
} from "./manifest.js";

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
): WorkspaceMergeResult {
  const rawAssignment = ensureWorkspaceAssignmentText(manifest.workspaceDir, tasks);
  const updates = parseAssignment(rawAssignment);
  return {
    rawAssignment,
    mergeInfo: mergeUpdates(tasks, updates),
  };
}

export function loadWorkspaceTaskMap(manifest: RunManifest): Map<string, TaskState> {
  const tasks = taskMapFromManifestSnapshot(manifest);
  mergeWorkspaceAssignmentIntoTaskMap(manifest, tasks);
  return tasks;
}

export function persistWorkspaceTaskState(
  manifest: RunManifest,
  tasks: Map<string, TaskState>,
  opts: {
    beforeManifestWrite?: (ordered: TaskState[], manifest: RunManifest) => void;
  } = {},
): TaskState[] {
  const ordered = syncManifestTaskState(manifest, tasks);
  writeTextFileAtomic(workspaceAssignmentPath(manifest.workspaceDir), renderAssignment(ordered));
  opts.beforeManifestWrite?.(ordered, manifest);
  writeManifest(manifest.workspaceDir, manifest);
  return ordered;
}
