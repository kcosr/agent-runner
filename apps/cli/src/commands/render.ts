import type {
  AttachmentListEntry,
  RunAttachment,
  RunAttachmentDownloadResult,
  RunAttachmentRemoveResult,
} from "@task-runner/core/contracts/attachments.js";
import type { RunAuditHistory } from "@task-runner/core/contracts/events.js";
import type {
  RunBackendSessionResult,
  RunDetail,
  RunNoteResult,
  RunPinnedResult,
  RunSessionSummary,
} from "@task-runner/core/contracts/runs.js";
import type {
  DefinitionDetailsResult,
  DefinitionListResult,
  RunArchiveResult,
  RunDeleteResult,
  RunDependenciesResult,
  RunListResult,
  RunResetResult,
  TaskDetailsResult,
  TaskListResult,
  TaskMutationResult,
} from "@task-runner/core/core/commands/service.js";
import { resolveTaskRunnerCommand } from "@task-runner/core/task-runner-command.js";
import type { HostMode } from "../daemon/config.js";
import type { DaemonInfo } from "../daemon/protocol.js";

export interface SystemStatusResult {
  configDir: string;
  stateDir: string;
  hostMode: HostMode;
  connectUrl: string | null;
  daemon: DaemonInfo | null;
}

function formatRunSessionSummary(label: string, session: RunSessionSummary | null): string {
  if (!session) {
    return `${label}: none`;
  }
  return `${label}: ${session.attemptCount} / ${session.maxAttemptsPerSession} attempts (session ${
    session.sessionIndex + 1
  }, ${session.status})`;
}

export function renderRunStatus(detail: RunDetail): string {
  const taskRunnerCmd = resolveTaskRunnerCommand();
  const lines: string[] = [];
  lines.push("");
  lines.push(`── run ${detail.runId} ──`);
  lines.push(
    `Status: ${detail.effectiveStatus}${detail.exitCode !== null ? ` (exit ${detail.exitCode})` : ""}`,
  );
  if (detail.effectiveStatus !== detail.status) {
    lines.push(`Lifecycle status: ${detail.status}`);
  }
  lines.push(`Agent: ${detail.agent.name}`);
  if (detail.assignment) {
    lines.push(`Assignment: ${detail.assignment.name}`);
  }
  lines.push(`Backend: ${detail.backend}${detail.model ? ` (${detail.model})` : ""}`);
  lines.push(`Name: ${detail.name ?? "Unnamed"}`);
  if (detail.pinned) {
    lines.push("Pinned: yes");
  }
  if (detail.note !== null) {
    lines.push("Note: present");
  }
  if (detail.backendSessionId) {
    lines.push(`Backend session: ${detail.backendSessionId}`);
  }
  if (detail.parentRunId) {
    lines.push(`Parent run: ${detail.parentRunId}`);
  }
  lines.push(`Repo: ${detail.repo}`);
  lines.push(`Cwd: ${detail.cwd}`);
  lines.push(`Workspace: ${detail.workspaceDir}`);
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
    lines.push(`Tasks completed: ${detail.tasksCompleted}/${detail.tasksTotal}`);
    lines.push(`Attempts: ${detail.totalAttemptCount} total`);
    lines.push(`Sessions: ${detail.totalSessionCount}`);
    lines.push(`Retry budget: ${detail.maxAttemptsPerSession} per session`);
    if (detail.currentSession) {
      lines.push(formatRunSessionSummary("Current session", detail.currentSession));
    } else if (detail.lastSession) {
      lines.push(formatRunSessionSummary("Last session", detail.lastSession));
    } else {
      lines.push(formatRunSessionSummary("Current session", null));
    }
  }
  lines.push(
    `Dependencies: ${detail.dependencies.length === 0 ? "ready (0 total)" : `${detail.dependencies.filter((dependency) => dependency.satisfied).length}/${detail.dependencies.length} satisfied`}`,
  );
  lines.push(`Attachments: ${detail.attachments.length}`);

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

  if (detail.dependencies.length > 0) {
    lines.push("");
    lines.push("Depends on:");
    for (const dependency of detail.dependencies) {
      const status = dependency.missing
        ? "missing"
        : `${dependency.effectiveStatus ?? dependency.status}${dependency.satisfied ? " satisfied" : " not-ready"}`;
      lines.push(`  - ${dependency.runId} [${status}] ${dependency.name ?? "Unnamed"}`);
    }
  }

  if (detail.dependents.length > 0) {
    lines.push("");
    lines.push("Required by:");
    for (const dependent of detail.dependents) {
      lines.push(
        `  - ${dependent.runId} [${dependent.effectiveStatus ?? dependent.status}] ${dependent.name ?? "Unnamed"}`,
      );
    }
  }

  const isPassive = detail.backend === "passive";
  const isArchived = detail.archivedAt !== null;

  if (detail.status === "running") {
    lines.push("");
    lines.push("(task statuses above come from canonical run.json task state)");
  } else if (isArchived) {
    lines.push("");
    lines.push("Run is archived. Unarchive it before resuming:");
    lines.push(`  ${taskRunnerCmd} run unarchive ${detail.runId}`);
  } else if (detail.status === "initialized") {
    lines.push("");
    if (isPassive) {
      lines.push("Drive this run externally:");
      lines.push(`  ${taskRunnerCmd} run brief ${detail.runId}`);
      lines.push(`  ${taskRunnerCmd} task set ${detail.runId} <task-id> --status in_progress`);
    } else {
      lines.push("To promote this run for execution:");
      lines.push(`  ${taskRunnerCmd} run ready ${detail.runId}`);
      lines.push(`  ${taskRunnerCmd} run brief ${detail.runId}`);
    }
  } else if (detail.status === "ready") {
    lines.push("");
    lines.push("To execute this run:");
    lines.push(`  ${taskRunnerCmd} run --resume-run ${detail.runId}`);
    lines.push(`  ${taskRunnerCmd} run brief ${detail.runId}`);
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

export function renderSystemStatus(result: SystemStatusResult): string {
  const lines = [
    `Config dir: ${result.configDir}`,
    `State dir: ${result.stateDir}`,
    `Host mode: ${result.hostMode}`,
    `Connect URL: ${result.connectUrl ?? "none"}`,
    `Daemon: ${result.daemon ? "connected" : "not connected"}`,
  ];

  if (result.daemon) {
    lines.push(`Daemon listen URL: ${result.daemon.listenUrl}`);
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
  if (result.kind === "launcher") {
    const { loaded } = result;
    const lines: string[] = [];
    lines.push(`Launcher: ${loaded.name}`);
    if (loaded.kind === "direct") {
      lines.push("  kind:         direct");
      lines.push("  source:       built-in");
      lines.push("  semantics:    no launcher prefix is applied");
      return `${lines.join("\n")}\n`;
    }
    lines.push("  kind:         prefix");
    lines.push(`  command:      ${loaded.command}`);
    lines.push(`  args:         ${loaded.args.length === 0 ? "[]" : loaded.args.join(" ")}`);
    lines.push(`  source:       ${loaded.sourcePath}`);
    return `${lines.join("\n")}\n`;
  }

  if (result.kind === "agent") {
    const { loaded } = result;
    const lines: string[] = [];
    lines.push(`Agent: ${loaded.config.name}`);
    lines.push(`  backend:      ${loaded.config.backend}`);
    if (loaded.config.model) lines.push(`  model:        ${loaded.config.model}`);
    if (loaded.config.effort) lines.push(`  effort:       ${loaded.config.effort}`);
    if (loaded.config.launcher !== undefined) {
      lines.push(
        `  launcher:     ${typeof loaded.config.launcher === "string" ? loaded.config.launcher : loaded.config.launcher.command}`,
      );
    }
    lines.push(`  timeoutSec:   ${loaded.config.timeoutSec}`);
    lines.push(`  unrestricted: ${loaded.config.unrestricted}`);
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
  if (loaded.config.cwd !== undefined) {
    lines.push(`  cwd:          ${loaded.config.cwd}`);
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

export function renderRunReady(result: RunDetail): string {
  return `task-runner: promoted run ${result.runId} to ready\n`;
}

export function renderRunList(result: RunListResult): string {
  if (result.length === 0) {
    return "No runs found.\n";
  }
  return `${result
    .map((run) => {
      const archived = run.archivedAt !== null ? ` archived=${run.archivedAt}` : "";
      return `${run.runId} [${run.effectiveStatus}] name=${run.name ?? "<unnamed>"} ${run.tasksCompleted}/${run.tasksTotal} repo=${run.repo} agent=${run.agentName} assignment=${run.assignmentName ?? "none"}${archived} cwd=${run.cwd}`;
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

export function renderRunDelete(result: RunDeleteResult): string {
  return `task-runner: deleted archived run ${result.runId}\n`;
}

function formatAuditFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatAuditDetails(details: Array<[string, unknown]>): string {
  const populated = details.filter(([, value]) => value !== undefined);
  if (populated.length === 0) {
    return "";
  }
  return `: ${populated.map(([key, value]) => `${key}=${formatAuditFieldValue(value)}`).join(" ")}`;
}

function formatRunAuditEventLine(event: RunAuditHistory["events"][number]["event"]): string {
  switch (event.type) {
    case "run.created":
      return `${event.type}${formatAuditDetails([
        ["backend", event.fields.backend],
        ["agent", event.fields.agentName],
        ["name", event.fields.name],
      ])}`;
    case "run.started":
    case "run.resumed":
      return `${event.type}${formatAuditDetails([
        ["sessionIndex", event.sessionIndex],
        ["backendSessionIdAtStart", event.fields.backendSessionIdAtStart],
      ])}`;
    case "run.ready":
    case "run.reset":
      return `${event.type}${formatAuditDetails([["previousStatus", event.fields.previousStatus]])}`;
    case "run.backend_session_updated":
      return `${event.type}${formatAuditDetails([
        ["reason", event.fields.reason],
        ["previous", event.fields.previousBackendSessionId],
        ["next", event.fields.nextBackendSessionId],
      ])}`;
    case "run.hook_recorded":
      return `${event.type}${formatAuditDetails([
        ["phase", event.fields.phase],
        ["id", event.fields.hookId],
        ["outcome", event.fields.outcome],
      ])}`;
    case "run.attempt_recorded":
      return `${event.type}${formatAuditDetails([
        ["attemptNumber", event.attemptNumber],
        ["exitCode", event.fields.exitCode],
        ["timedOut", event.fields.timedOut],
      ])}`;
    case "run.retrying":
      return `${event.type}${formatAuditDetails([
        ["incomplete", event.fields.incompleteCount],
        ["invalid", event.fields.invalidStatusCount],
      ])}`;
    case "run.finished":
      return `${event.type}${formatAuditDetails([
        ["status", event.fields.terminalStatus],
        ["exitCode", event.fields.exitCode],
      ])}`;
    case "run.aborted":
    case "run.resume_rejected":
    case "run.archived":
    case "run.unarchived":
      return event.type;
    case "run.renamed":
      return `${event.type}${formatAuditDetails([
        ["previous", event.fields.previousName],
        ["next", event.fields.nextName],
      ])}`;
    case "task.added":
      return `${event.type}${formatAuditDetails([
        ["taskId", event.fields.taskId],
        ["title", event.fields.taskTitle],
      ])}`;
    case "task.updated":
      return `${event.type}${formatAuditDetails([
        ["taskId", event.fields.taskId],
        ["command", event.fields.command],
        ["statusBefore", event.fields.statusBefore],
        ["statusAfter", event.fields.statusAfter],
        ["notesChanged", event.fields.notesChanged],
      ])}`;
    default: {
      const raw = Object.keys(event.fields).length === 0 ? "" : ` ${JSON.stringify(event.fields)}`;
      return `${event.type}${raw}`;
    }
  }
}

export function renderRunAuditHistory(history: RunAuditHistory): string {
  if (history.events.length === 0) {
    return "No audit events found.\n";
  }
  return `${history.events
    .map((envelope) => `${envelope.event.recordedAt}  ${formatRunAuditEventLine(envelope.event)}`)
    .join("\n")}\n`;
}

export function renderRunSetName(result: {
  runId: string;
  name: string | null;
  changed: boolean;
}): string {
  if (result.name === null) {
    return result.changed
      ? `task-runner: cleared name for run ${result.runId}\n`
      : `task-runner: run ${result.runId} already has no name\n`;
  }
  return result.changed
    ? `task-runner: set name for run ${result.runId} to "${result.name}"\n`
    : `task-runner: run ${result.runId} already has name "${result.name}"\n`;
}

export function renderRunSetNote(result: RunNoteResult): string {
  if (result.note === null) {
    return result.changed
      ? `task-runner: cleared note for run ${result.runId}\n`
      : `task-runner: run ${result.runId} already has no note\n`;
  }
  return result.changed
    ? `task-runner: set note for run ${result.runId} to present\n`
    : `task-runner: run ${result.runId} already has note present\n`;
}

export function renderRunSetPinned(result: RunPinnedResult): string {
  if (result.pinned) {
    return result.changed
      ? `task-runner: pinned run ${result.runId}\n`
      : `task-runner: run ${result.runId} is already pinned\n`;
  }
  return result.changed
    ? `task-runner: unpinned run ${result.runId}\n`
    : `task-runner: run ${result.runId} is already unpinned\n`;
}

export function renderRunSetBackendSession(result: RunBackendSessionResult): string {
  if (result.backendSessionId === null) {
    throw new Error("renderRunSetBackendSession requires a non-null backendSessionId");
  }
  return result.changed
    ? `task-runner: set backend session for run ${result.runId} to "${result.backendSessionId}"\n`
    : `task-runner: run ${result.runId} already has backend session "${result.backendSessionId}"\n`;
}

export function renderRunClearBackendSession(result: RunBackendSessionResult): string {
  return result.changed
    ? `task-runner: cleared backend session for run ${result.runId}\n`
    : `task-runner: run ${result.runId} already has no backend session\n`;
}

export function renderRunAddDependency(
  result: RunDependenciesResult,
  dependencyRunId: string,
): string {
  return `task-runner: added dependency ${dependencyRunId} to run ${result.runId}\n`;
}

export function renderRunRemoveDependency(
  result: RunDependenciesResult,
  dependencyRunId: string,
): string {
  return `task-runner: removed dependency ${dependencyRunId} from run ${result.runId}\n`;
}

export function renderRunClearDependencies(result: RunDependenciesResult): string {
  if (!result.changed) {
    return `task-runner: run ${result.runId} already has no dependencies\n`;
  }
  return `task-runner: cleared dependencies for run ${result.runId}\n`;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

export function renderAttachmentList(
  attachments: AttachmentListEntry[],
  options: { showOwnerRunId?: boolean } = {},
): string {
  if (attachments.length === 0) {
    return "No attachments.\n";
  }
  return `${attachments
    .map((attachment) => {
      const owner = options.showOwnerRunId ? `  owner=${attachment.ownerRunId}` : "";
      return `${attachment.id}  ${attachment.name}  ${attachment.mimeType}  ${formatBytes(attachment.size)}  ${attachment.addedAt}${owner}`;
    })
    .join("\n")}\n`;
}

export function renderAttachmentAdded(runId: string, attachment: RunAttachment): string {
  return `task-runner: added attachment ${attachment.id} "${attachment.name}" to run ${runId}\n`;
}

export function renderAttachmentRemoved(result: RunAttachmentRemoveResult): string {
  return result.changed
    ? `task-runner: removed attachment ${result.attachmentId} from run ${result.runId}\n`
    : `task-runner: attachment ${result.attachmentId} was already absent from run ${result.runId}\n`;
}

export function renderAttachmentDownloaded(result: RunAttachmentDownloadResult): string {
  return `task-runner: downloaded attachment ${result.id} to ${result.outputPath}\n`;
}
