import type { RunDetail } from "../contracts/runs.js";
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
} from "../core/commands/service.js";
import { resolveTaskRunnerCommand } from "../task-runner-command.js";

export function renderRunStatus(detail: RunDetail): string {
  const taskRunnerCmd = resolveTaskRunnerCommand();
  const lines: string[] = [];
  lines.push("");
  lines.push(`── run ${detail.runId} ──`);
  lines.push(
    `Status: ${detail.status}${detail.exitCode !== null ? ` (exit ${detail.exitCode})` : ""}`,
  );
  lines.push(`Agent: ${detail.agent.name}`);
  if (detail.assignment) {
    lines.push(`Assignment: ${detail.assignment.name}`);
  }
  lines.push(`Backend: ${detail.backend}${detail.model ? ` (${detail.model})` : ""}`);
  if (detail.sessionName) {
    lines.push(`Session name: ${detail.sessionName}`);
  }
  if (detail.backendSessionId) {
    lines.push(`Backend session: ${detail.backendSessionId}`);
  }
  lines.push(`Cwd: ${detail.cwd}`);
  lines.push(`Workspace: ${detail.workspaceDir}`);
  lines.push(`Assignment file: ${detail.assignmentPath}`);
  lines.push(`Started: ${detail.startedAt}`);
  if (detail.endedAt) {
    lines.push(`Ended: ${detail.endedAt}`);
  }
  if (detail.archivedAt) {
    lines.push(`Archived: ${detail.archivedAt}`);
  }
  if (detail.backend === "passive") {
    lines.push(`Tasks completed: ${detail.tasksCompleted}/${detail.tasksTotal}`);
  } else {
    lines.push(
      `Tasks completed: ${detail.tasksCompleted}/${detail.tasksTotal}    Attempts: ${detail.attempts}/${detail.maxAttempts}    Sessions: ${detail.sessionCount}`,
    );
  }

  if (detail.tasks.length > 0) {
    lines.push("");
    lines.push("Tasks:");
    for (const task of detail.tasks) {
      lines.push(`  - ${task.id} — ${task.title} [${task.status}]`);
      const notes = task.notes.trim();
      if (notes) {
        for (const noteLine of notes.split("\n")) {
          lines.push(`      ${noteLine}`);
        }
      }
    }
  }

  const isPassive = detail.backend === "passive";
  const isArchived = detail.archivedAt !== null;

  if (detail.status === "running") {
    lines.push("");
    if (detail.taskMode === "cli") {
      lines.push(
        "(task statuses above come from canonical run.json task state; assignment.md is rendered for audit only)",
      );
    } else if (detail.isLive) {
      lines.push(
        "(task statuses above are read live from the workspace assignment.md; the current attempt may still be in progress)",
      );
    } else {
      lines.push("(run is still in progress; status reflects the most recent persisted attempt)");
    }
  } else if (isArchived) {
    lines.push("");
    lines.push("Run is archived. Unarchive it before resuming:");
    lines.push(`  ${taskRunnerCmd} run unarchive ${detail.runId}`);
  } else if (detail.status === "initialized") {
    lines.push("");
    if (isPassive) {
      lines.push("Drive this run externally:");
      lines.push(`  ${taskRunnerCmd} task set ${detail.runId} <task-id> --status in_progress`);
      lines.push(
        `  ${taskRunnerCmd} task set ${detail.runId} <task-id> --status completed --notes "..."`,
      );
      lines.push('  For multi-line notes, prefer a quoted heredoc and pass --notes "$notes".');
    } else {
      lines.push("To execute this run:");
      lines.push(`  ${taskRunnerCmd} run --resume-run ${detail.runId}`);
    }
  } else if (
    detail.status === "blocked" ||
    detail.status === "exhausted" ||
    detail.status === "aborted" ||
    detail.status === "error"
  ) {
    lines.push("");
    if (isPassive) {
      lines.push("Reopen tasks to continue:");
      lines.push(`  ${taskRunnerCmd} task set ${detail.runId} <task-id> --status in_progress`);
    } else {
      lines.push("To resume this run:");
      lines.push(`  ${taskRunnerCmd} run --resume-run ${detail.runId} "..."`);
    }
  }

  return `${lines.join("\n")}\n`;
}

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
