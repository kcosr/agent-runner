import { renderRunStatus } from "../runner/output.js";
import type {
  DefinitionDetailsResult,
  DefinitionListResult,
  RunArchiveResult,
  RunListResult,
  RunResetResult,
  StatusCommandResult,
  TaskDetailsResult,
  TaskListResult,
  TaskMutationResult,
} from "./service.js";

export function renderDefinitionList(result: DefinitionListResult): string {
  if (result.entries.length === 0) {
    return `No ${result.kind} definitions found.\n`;
  }
  return `${result.entries.map((entry) => `  ${entry.name}`).join("\n")}\n`;
}

export function renderDefinitionDetails(result: DefinitionDetailsResult): string {
  if (result.kind === "agent") {
    const { loaded } = result;
    const lines: string[] = [];
    lines.push(`Agent: ${loaded.config.name}`);
    lines.push(`  backend:      ${loaded.config.backend}`);
    if (loaded.config.model) lines.push(`  model:        ${loaded.config.model}`);
    if (loaded.config.effort) lines.push(`  effort:       ${loaded.config.effort}`);
    lines.push(`  timeoutSec:   ${loaded.config.timeoutSec}`);
    lines.push(`  unrestricted: ${loaded.config.unrestricted}`);
    lines.push(`  cwd:          ${loaded.config.cwd}`);
    if (loaded.config.lockedFields.length > 0) {
      lines.push(`  lockedFields: ${loaded.config.lockedFields.join(", ")}`);
    }
    lines.push(`  source:       ${loaded.sourcePath}`);
    if (loaded.instructions) {
      lines.push("");
      lines.push(loaded.instructions);
    }
    return `${lines.join("\n")}\n`;
  }

  const { loaded } = result;
  const lines: string[] = [];
  lines.push(`Assignment: ${loaded.config.name}`);
  if (loaded.config.sessionName) {
    lines.push(`  sessionName:  ${loaded.config.sessionName}`);
  }
  lines.push(`  maxRetries:   ${loaded.config.maxRetries}`);
  if (loaded.config.tasks.length > 0) {
    lines.push(`  tasks:        ${loaded.config.tasks.length}`);
    for (const task of loaded.config.tasks) {
      lines.push(`    - ${task.id}: ${task.title}`);
    }
  }
  const varNames = Object.keys(loaded.config.vars);
  if (varNames.length > 0) {
    lines.push(`  vars:         ${varNames.join(", ")}`);
  }
  if (loaded.config.lockedFields.length > 0) {
    lines.push(`  lockedFields: ${loaded.config.lockedFields.join(", ")}`);
  }
  lines.push(`  source:       ${loaded.sourcePath}`);
  if (loaded.instructions) {
    lines.push("");
    lines.push(loaded.instructions);
  }
  return `${lines.join("\n")}\n`;
}

export function renderRunReset(result: RunResetResult): string {
  return `task-runner: reset run ${result.manifest.runId} to initialized state\n`;
}

export function renderRunList(result: RunListResult): string {
  if (result.length === 0) {
    return "No runs found.\n";
  }
  return `${result
    .map((run) => {
      const archived = run.archivedAt !== null ? ` archived=${run.archivedAt}` : "";
      return `${run.runId} [${run.status}] ${run.tasksCompleted}/${run.tasksTotal} repo=${run.repo} agent=${run.agentName} assignment=${run.assignmentName ?? "none"}${archived}`;
    })
    .join("\n")}\n`;
}

export function renderRunArchive(result: RunArchiveResult): string {
  if (!result.changed) {
    return `task-runner: run ${result.runId} is already archived\n`;
  }
  return `task-runner: archived run ${result.runId}\n`;
}

export function renderRunUnarchive(result: RunArchiveResult): string {
  if (!result.changed) {
    return `task-runner: run ${result.runId} is not archived\n`;
  }
  return `task-runner: unarchived run ${result.runId}\n`;
}

export function renderStatus(result: StatusCommandResult): string {
  return renderRunStatus(result);
}

export function renderTaskList(result: TaskListResult): string {
  return `${result.tasks.map((task) => `[${task.status}] ${task.id} - ${task.title}`).join("\n")}\n`;
}

export function renderTaskDetails(result: TaskDetailsResult): string {
  return renderTaskSnapshot(result.task);
}

export function renderTaskMutation(result: TaskMutationResult): string {
  return `task-runner: updated ${result.task.id} (status=${result.task.status}) in run ${result.manifest.runId}\n`;
}

export function renderTaskAdded(result: TaskMutationResult): string {
  return `task-runner: added task ${result.task.id} "${result.task.title}" to run ${result.manifest.runId}\n`;
}

export function renderTaskSnapshot(task: TaskDetailsResult["task"]): string {
  return `id: ${task.id}\ntitle: ${task.title}\nstatus: ${task.status}\nbody:\n${task.body}\nnotes:\n${task.notes}\n`;
}
