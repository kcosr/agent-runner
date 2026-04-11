import {
  type InvalidStatusReport,
  type TaskState,
  type TaskStatus,
  isValidStatus,
} from "./model.js";
import type { ParsedSectionUpdate } from "./parser.js";
import { renderSection } from "./writer.js";

const TASK_ID_MARKER = /^<!--\s*task-id:\s*([A-Za-z0-9._:-]+)\s*-->\s*$/gm;

export interface MergeResult {
  invalidStatuses: InvalidStatusReport[];
  missingFromFile: string[];
  unknownInFile: string[];
}

export interface MergeOptions {
  applyStatus?: boolean;
  applyNotes?: boolean;
}

export function mergeUpdates(
  tasks: Map<string, TaskState>,
  updates: ParsedSectionUpdate[],
  opts: MergeOptions = {},
): MergeResult {
  const result: MergeResult = {
    invalidStatuses: [],
    missingFromFile: [],
    unknownInFile: [],
  };
  const seen = new Set<string>();

  for (const update of updates) {
    if (seen.has(update.taskId)) {
      result.unknownInFile.push(update.taskId);
      continue;
    }
    const task = tasks.get(update.taskId);
    if (!task) {
      result.unknownInFile.push(update.taskId);
      continue;
    }
    seen.add(update.taskId);

    if (opts.applyStatus !== false && update.status !== undefined) {
      if (isValidStatus(update.status)) {
        task.status = update.status as TaskStatus;
      } else {
        result.invalidStatuses.push({
          taskId: update.taskId,
          rawValue: update.status,
        });
      }
    }
    if (opts.applyNotes !== false && update.notes !== undefined) {
      task.notes = update.notes;
    }
  }

  for (const id of tasks.keys()) {
    if (!seen.has(id)) result.missingFromFile.push(id);
  }

  return result;
}

export function mergeIntoFile(existing: string, tasks: Map<string, TaskState>): string {
  const presentIds = new Set<string>();
  for (const match of existing.matchAll(TASK_ID_MARKER)) {
    const id = match[1];
    if (id !== undefined) presentIds.add(id);
  }

  const orderedTasks = Array.from(tasks.values());
  const missing = orderedTasks.filter((t) => !presentIds.has(t.id));
  if (missing.length === 0) return existing;

  const baseIndex = orderedTasks.length - missing.length;
  const appended = missing
    .map((task, offset) => renderSection(baseIndex + offset, task))
    .join("\n");

  const trailing = existing.endsWith("\n") ? "" : "\n";
  return `${existing}${trailing}\n${appended}`;
}
