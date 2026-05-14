import { resolveAgentRunnerCommand } from "@agent-runner/core/agent-runner-command.js";
import type { DefinitionDetail } from "@agent-runner/core/app/service.js";
import type {
  AttachmentListEntry,
  RunAttachment,
  RunAttachmentDownloadResult,
  RunAttachmentRemoveResult,
} from "@agent-runner/core/contracts/attachments.js";
import type { RunAuditHistory } from "@agent-runner/core/contracts/events.js";
import type {
  QueueResumeMessageResult,
  QueuedResumeMessage,
  RemoveQueuedResumeMessageResult,
  RunBackendSessionResult,
  RunDependencyRef,
  RunDetail,
  RunGroupResult,
  RunNoteResult,
  RunPinnedResult,
  RunSessionSummary,
} from "@agent-runner/core/contracts/runs.js";
import type {
  DefinitionListResult,
  RunArchiveResult,
  RunDeleteResult,
  RunDependenciesResult,
  RunListResult,
  TaskDetailsResult,
  TaskListResult,
} from "@agent-runner/core/core/commands/service.js";
import { formatSchedule } from "@agent-runner/core/core/run/schedule.js";
import type { HostMode } from "../daemon/config.js";
import type { DaemonInfo } from "../daemon/protocol.js";

interface SystemStatusResult {
  configDir: string;
  stateDir: string;
  hostMode: HostMode;
  connectUrl: string | null;
  daemon: DaemonInfo | null;
}

interface RunQueuedResumeMessagesResult {
  runId: string;
  queuedResumeMessages: QueuedResumeMessage[];
}

interface QueueResumeMessageCliResult {
  runId: string;
  queuedResumeMessage: QueuedResumeMessage;
  queuedResumeMessageCount: number;
}

interface RemoveQueuedResumeMessageCliResult {
  runId: string;
  removedMessageId: string;
  queuedResumeMessageCount: number;
}

export function queueResumeMessageCliResult(
  result: QueueResumeMessageResult,
): QueueResumeMessageCliResult {
  return {
    runId: result.run.runId,
    queuedResumeMessage: result.queuedResumeMessage,
    queuedResumeMessageCount: result.run.queuedResumeMessages.length,
  };
}

export function removeQueuedResumeMessageCliResult(
  result: RemoveQueuedResumeMessageResult,
): RemoveQueuedResumeMessageCliResult {
  return {
    runId: result.run.runId,
    removedMessageId: result.removedMessageId,
    queuedResumeMessageCount: result.run.queuedResumeMessages.length,
  };
}

export function queuedResumeMessagesCliResult(detail: RunDetail): RunQueuedResumeMessagesResult {
  return {
    runId: detail.runId,
    queuedResumeMessages: detail.queuedResumeMessages,
  };
}

export function renderRunQueueResumeMessage(result: QueueResumeMessageCliResult): string {
  return `agent-runner: queued message ${result.queuedResumeMessage.id} for run ${result.runId}\n`;
}

export function renderRunRemoveQueuedResumeMessage(
  result: RemoveQueuedResumeMessageCliResult,
): string {
  return `agent-runner: removed queued message ${result.removedMessageId} from run ${result.runId}\n`;
}

export function renderRunQueuedResumeMessages(result: RunQueuedResumeMessagesResult): string {
  if (result.queuedResumeMessages.length === 0) {
    return `No queued resume messages for run ${result.runId}.\n`;
  }
  const lines = [`Queued resume messages for run ${result.runId}:`];
  for (const message of result.queuedResumeMessages) {
    lines.push(`${message.id}  ${message.createdAt}`);
    for (const textLine of message.text.split("\n")) {
      lines.push(`  ${textLine}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
  const agentRunnerCmd = resolveAgentRunnerCommand();
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
  lines.push(`Run group: ${detail.runGroupId}`);
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
  lines.push(
    `Schedule: ${detail.schedule === null ? "none" : `${formatSchedule(detail.schedule)} (${detail.scheduleState})`}`,
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
      if (dependency.type === "run") {
        const status = dependency.missing
          ? "missing"
          : `${dependency.effectiveStatus ?? dependency.status}${dependency.satisfied ? " satisfied" : " not-ready"}`;
        lines.push(`  - run ${dependency.runId} [${status}] ${dependency.name ?? "Unnamed"}`);
      } else {
        const status = dependency.missing
          ? "missing"
          : dependency.satisfied
            ? "satisfied"
            : "not-ready";
        lines.push(
          `  - group ${dependency.groupId} [${status}; ${dependency.successful}/${dependency.total} successful, ${dependency.unsatisfied} unsatisfied, ${dependency.archivedExcluded} archived excluded]`,
        );
      }
    }
  }

  if (detail.dependents.length > 0) {
    lines.push("");
    lines.push("Required by:");
    for (const dependent of detail.dependents) {
      lines.push(
        `  - ${dependent.via === "group" ? `group ${dependent.dependencyGroupId} -> ` : ""}${dependent.runId} [${dependent.effectiveStatus ?? dependent.status}] ${dependent.name ?? "Unnamed"}`,
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
    lines.push(`  ${agentRunnerCmd} run unarchive ${detail.runId}`);
  } else if (detail.status === "initialized") {
    lines.push("");
    if (isPassive) {
      lines.push("Drive this run externally:");
      lines.push(`  ${agentRunnerCmd} run brief ${detail.runId}`);
      lines.push(`  ${agentRunnerCmd} task set ${detail.runId} <task-id> --status in_progress`);
    } else {
      lines.push("To promote this run for execution:");
      lines.push(`  ${agentRunnerCmd} run ready ${detail.runId}`);
      lines.push(`  ${agentRunnerCmd} run brief ${detail.runId}`);
    }
  } else if (detail.status === "ready") {
    lines.push("");
    lines.push("To execute this run:");
    lines.push(`  ${agentRunnerCmd} run --resume-run ${detail.runId}`);
    lines.push(`  ${agentRunnerCmd} run brief ${detail.runId}`);
  } else if (
    detail.status === "blocked" ||
    detail.status === "exhausted" ||
    detail.status === "aborted" ||
    detail.status === "error"
  ) {
    lines.push("");
    if (isPassive) {
      lines.push("Reopen tasks to continue:");
      lines.push(`  ${agentRunnerCmd} task set ${detail.runId} <task-id> --status in_progress`);
    } else {
      lines.push("To resume this run:");
      lines.push(`  ${agentRunnerCmd} run --resume-run ${detail.runId} "..."`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderScheduleMutation(verb: string, detail: RunDetail): string {
  if (detail.schedule === null) {
    return `agent-runner: ${verb} schedule for run ${detail.runId}\n`;
  }
  return `agent-runner: ${verb} schedule for run ${detail.runId}: ${formatSchedule(detail.schedule)} (next ${detail.schedule.runAt}, ${detail.scheduleState})\n`;
}

export function renderRunScheduleSet(detail: RunDetail): string {
  return renderScheduleMutation("set", detail);
}

export function renderRunScheduleEnabled(detail: RunDetail): string {
  return renderScheduleMutation("enabled", detail);
}

export function renderRunScheduleDisabled(detail: RunDetail): string {
  return renderScheduleMutation("disabled", detail);
}

export function renderRunScheduleCleared(detail: RunDetail): string {
  return renderScheduleMutation("cleared", detail);
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

export function renderDefinitionDetails(result: DefinitionDetail): string {
  if (result.kind === "launcher") {
    const loaded = result.definition;
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

  if (result.kind === "environment") {
    const loaded = result.definition;
    const config = loaded.config;
    const lines: string[] = [];
    lines.push(`Environment: ${loaded.name}`);
    lines.push(`  kind:         ${config.kind}`);
    lines.push(`  mode:         ${config.mode}`);
    lines.push(`  engine:       ${config.engine}`);
    lines.push(`  cwd:          ${config.cwd}`);
    const varNames = Object.keys(config.vars);
    if (varNames.length > 0) {
      lines.push(`  vars:         ${varNames.join(", ")}`);
    }
    if (config.mode === "existing") {
      lines.push(`  container:    ${config.container}`);
      lines.push(`  mounts:       ${config.expectedMounts.length}`);
    } else {
      lines.push(`  image:        ${config.image}`);
      lines.push(`  lifetime:     ${config.lifetime}`);
      if (config.workspace !== undefined) {
        lines.push(`  workspace:    ${config.workspace.scope}`);
        lines.push(`  containerPath: ${config.workspace.containerPath}`);
      }
      const sessionMounts =
        config.sessionMounts === "backend" ? "backend" : config.sessionMounts.join(", ");
      if (sessionMounts.length > 0) {
        lines.push(`  sessionMounts: ${sessionMounts}`);
      }
      lines.push(`  mounts:       ${config.mounts.length}`);
    }
    lines.push(`  source:       ${loaded.sourcePath}`);
    return `${lines.join("\n")}\n`;
  }

  if (result.kind === "agent") {
    const lines: string[] = [];
    lines.push(`Agent: ${result.config.name}`);
    lines.push(`  backend:      ${result.config.backend}`);
    if (result.config.model) lines.push(`  model:        ${result.config.model}`);
    if (result.config.effort) lines.push(`  effort:       ${result.config.effort}`);
    if (result.config.launcher !== undefined) {
      lines.push(
        `  launcher:     ${typeof result.config.launcher === "string" ? result.config.launcher : result.config.launcher.command}`,
      );
    }
    if (result.config.executionEnvironment !== undefined) {
      lines.push(`  environment:  ${result.config.executionEnvironment}`);
    }
    lines.push(`  timeoutSec:   ${result.config.timeoutSec}`);
    lines.push(`  unrestricted: ${result.config.unrestricted}`);
    if (result.config.lockedFields.length > 0) {
      lines.push(`  lockedFields: ${result.config.lockedFields.join(", ")}`);
    }
    lines.push(`  source:       ${result.sourcePath}`);
    if (result.instructions) {
      lines.push("");
      lines.push(result.instructions);
    }
    return `${lines.join("\n")}\n`;
  }

  if (result.kind === "task") {
    const lines: string[] = [];
    lines.push(`Task: ${result.task.id}`);
    lines.push(`  title:        ${result.task.title}`);
    lines.push(`  hooks:        ${result.task.hooks.length}`);
    for (const hook of result.task.hooks) {
      if (hook.builtin !== undefined) {
        lines.push(`    - builtin: ${hook.builtin}`);
      } else if (hook.name !== undefined) {
        lines.push(`    - name: ${hook.name}`);
      } else if (hook.path !== undefined) {
        lines.push(`    - path: ${hook.path}`);
      }
    }
    lines.push(`  source:       ${result.sourcePath}`);
    if (result.task.body) {
      lines.push("");
      lines.push(result.task.body);
    }
    return `${lines.join("\n")}\n`;
  }

  const lines: string[] = [];
  lines.push(`Assignment: ${result.config.name}`);
  if (result.config.cwd !== undefined) {
    lines.push(`  cwd:          ${result.config.cwd}`);
  }
  lines.push(`  maxRetries:   ${result.config.maxRetries}`);
  if (result.config.tasks.length > 0) {
    lines.push(`  tasks:        ${result.config.tasks.length}`);
    for (const task of result.config.tasks) {
      lines.push(`    - ${task.id}: ${task.title}`);
    }
  }
  const varNames = Object.keys(result.config.vars);
  if (varNames.length > 0) {
    lines.push(`  vars:         ${varNames.join(", ")}`);
  }
  if (result.config.lockedFields.length > 0) {
    lines.push(`  lockedFields: ${result.config.lockedFields.join(", ")}`);
  }
  lines.push(`  source:       ${result.sourcePath}`);
  if (result.instructions) {
    lines.push("");
    lines.push(result.instructions);
  }
  return `${lines.join("\n")}\n`;
}

export function renderRunReady(result: RunDetail): string {
  const schedule = result.schedule === null ? "" : `schedule: ${formatSchedule(result.schedule)}\n`;
  return `agent-runner: promoted run ${result.runId} to ready\n${schedule}`;
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
    return `agent-runner: run ${result.runId} is already archived\n`;
  }
  return `agent-runner: archived run ${result.runId}\n`;
}

export function renderRunUnarchive(result: RunArchiveResult): string {
  if (!result.changed) {
    return `agent-runner: run ${result.runId} is not archived\n`;
  }
  return `agent-runner: unarchived run ${result.runId}\n`;
}

export function renderRunDelete(result: RunDeleteResult): string {
  return `agent-runner: deleted archived run ${result.runId}\n`;
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
    case "run.controller_detached":
      return `${event.type}${formatAuditDetails([
        ["backend", event.fields.backend],
        ["backendSessionId", event.fields.backendSessionId],
        ["transportType", event.fields.transportType],
        ["reason", event.fields.reason],
      ])}`;
    case "run.controller_reconciled":
      return `${event.type}${formatAuditDetails([
        ["backend", event.fields.backend],
        ["backendSessionId", event.fields.backendSessionId],
        ["transportType", event.fields.transportType],
        ["decision", event.fields.decision],
        ["reason", event.fields.reason],
        ["remoteStatus", event.fields.remoteStatus],
        ["error", event.fields.error],
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
    case "run.queued_resume_message_added":
      return `${event.type}${formatAuditDetails([
        ["messageId", event.fields.messageId],
        ["messageCreatedAt", event.fields.messageCreatedAt],
      ])}`;
    case "run.queued_resume_message_removed":
      return `${event.type}${formatAuditDetails([["messageId", event.fields.messageId]])}`;
    case "run.queued_resume_messages_drained":
      return `${event.type}${formatAuditDetails([
        ["messageIds", event.fields.messageIds],
        ["messageCount", event.fields.messageCount],
      ])}`;
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
      ? `agent-runner: cleared name for run ${result.runId}\n`
      : `agent-runner: run ${result.runId} already has no name\n`;
  }
  return result.changed
    ? `agent-runner: set name for run ${result.runId} to "${result.name}"\n`
    : `agent-runner: run ${result.runId} already has name "${result.name}"\n`;
}

export function renderRunSetNote(result: RunNoteResult): string {
  if (result.note === null) {
    return result.changed
      ? `agent-runner: cleared note for run ${result.runId}\n`
      : `agent-runner: run ${result.runId} already has no note\n`;
  }
  return result.changed
    ? `agent-runner: set note for run ${result.runId} to present\n`
    : `agent-runner: run ${result.runId} already has note present\n`;
}

export function renderRunSetPinned(result: RunPinnedResult): string {
  if (result.pinned) {
    return result.changed
      ? `agent-runner: pinned run ${result.runId}\n`
      : `agent-runner: run ${result.runId} is already pinned\n`;
  }
  return result.changed
    ? `agent-runner: unpinned run ${result.runId}\n`
    : `agent-runner: run ${result.runId} is already unpinned\n`;
}

export function renderRunSetBackendSession(result: RunBackendSessionResult): string {
  if (result.backendSessionId === null) {
    throw new Error("renderRunSetBackendSession requires a non-null backendSessionId");
  }
  return result.changed
    ? `agent-runner: set backend session for run ${result.runId} to "${result.backendSessionId}"\n`
    : `agent-runner: run ${result.runId} already has backend session "${result.backendSessionId}"\n`;
}

export function renderRunClearBackendSession(result: RunBackendSessionResult): string {
  return result.changed
    ? `agent-runner: cleared backend session for run ${result.runId}\n`
    : `agent-runner: run ${result.runId} already has no backend session\n`;
}

export function renderRunSetGroup(result: RunGroupResult): string {
  return result.changed
    ? `agent-runner: set group for run ${result.runId} to ${result.runGroupId}\n`
    : `agent-runner: run ${result.runId} is already in group ${result.runGroupId}\n`;
}

export function renderRunClearGroup(result: RunGroupResult): string {
  return result.changed
    ? `agent-runner: cleared group for run ${result.runId}; run is now in singleton group ${result.runGroupId}\n`
    : `agent-runner: run ${result.runId} is already in singleton group ${result.runGroupId}\n`;
}

function dependencyLabel(dependency: RunDependencyRef): string {
  return dependency.type === "run" ? dependency.runId : dependency.groupId;
}

export function renderRunAddDependency(
  result: RunDependenciesResult,
  dependency: RunDependencyRef,
): string {
  return `agent-runner: added ${dependency.type} dependency ${dependencyLabel(dependency)} to run ${result.runId}\n`;
}

export function renderRunRemoveDependency(
  result: RunDependenciesResult,
  dependency: RunDependencyRef,
): string {
  return `agent-runner: removed ${dependency.type} dependency ${dependencyLabel(dependency)} from run ${result.runId}\n`;
}

export function renderRunClearDependencies(result: RunDependenciesResult): string {
  if (!result.changed) {
    return `agent-runner: run ${result.runId} already has no dependencies\n`;
  }
  return `agent-runner: cleared dependencies for run ${result.runId}\n`;
}

export function renderTaskList(result: TaskListResult): string {
  return `${result.tasks.map((task) => `[${task.status}] ${task.id} - ${task.title}`).join("\n")}\n`;
}

export function renderTaskDetails(result: TaskDetailsResult): string {
  return renderTaskSnapshot(result.task);
}

function renderTaskSnapshot(task: TaskDetailsResult["task"]): string {
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
  return `agent-runner: added attachment ${attachment.id} "${attachment.name}" to run ${runId}\n`;
}

export function renderAttachmentRemoved(result: RunAttachmentRemoveResult): string {
  return result.changed
    ? `agent-runner: removed attachment ${result.attachmentId} from run ${result.runId}\n`
    : `agent-runner: attachment ${result.attachmentId} was already absent from run ${result.runId}\n`;
}

export function renderAttachmentDownloaded(result: RunAttachmentDownloadResult): string {
  return `agent-runner: downloaded attachment ${result.id} to ${result.outputPath}\n`;
}
