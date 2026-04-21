import type { RunEvent } from "@task-runner/core/core/run/run-loop.js";
import type { RunCompletionSummary } from "@task-runner/core/core/run/status.js";
import { resolveTaskRunnerCommand } from "@task-runner/core/task-runner-command.js";

export interface RenderedRunChunk {
  stream: "stdout" | "stderr";
  text: string;
}

function stderr(text: string): RenderedRunChunk[] {
  return [{ stream: "stderr", text }];
}

function stdout(text: string): RenderedRunChunk[] {
  return [{ stream: "stdout", text }];
}

function hasIncompleteTasks(summary: RunCompletionSummary): boolean {
  return summary.tasks.some((task) => task.status !== "completed");
}

function appendResumeHint(
  lines: string[],
  summary: RunCompletionSummary,
  taskRunnerCmd: string,
  intro: string,
): void {
  const resumeCmd = `${taskRunnerCmd} run --resume-run ${summary.runId}`;
  if (hasIncompleteTasks(summary)) {
    lines.push(intro);
    lines.push(`  ${resumeCmd}`);
    lines.push(`  ${resumeCmd} "..."`);
    return;
  }

  lines.push("To continue this run, provide a follow-up message or add a task:");
  lines.push(`  ${resumeCmd} "..."`);
}

function renderBannerLines(event: {
  agentName: string;
  runId: string;
  assignmentSourcePath: string | null;
  name: string | null;
  cwd: string;
  header: string;
}): string[] {
  const lines = [event.header];
  if (event.assignmentSourcePath) {
    lines.push(`             source=${event.assignmentSourcePath}`);
  }
  lines.push(`             name=${event.name ?? "Unnamed"}`);
  lines.push(`             cwd=${event.cwd}`);
  return lines;
}

function renderSummary(summary: RunCompletionSummary): string {
  const taskRunnerCmd = resolveTaskRunnerCommand();
  const lines: string[] = [];
  lines.push("");
  lines.push("── summary ──");
  lines.push(`Status: ${summary.status}`);

  if (summary.status === "initialized") {
    lines.push(`Tasks seeded: ${summary.tasksTotal}`);
    if (summary.tasks.length > 0) {
      lines.push("");
      lines.push("Seeded tasks:");
      for (const task of summary.tasks) {
        lines.push(`  - ${task.id} — ${task.title}`);
      }
    }
    lines.push("");
    lines.push("To execute this run:");
    lines.push(`  ${taskRunnerCmd} run --resume-run ${summary.runId}`);
    return `${lines.join("\n")}\n`;
  }

  if (summary.status === "aborted") {
    lines.push(`Tasks completed: ${summary.tasksCompleted}/${summary.tasksTotal}`);
    lines.push(`Attempts: ${summary.attempts}/${summary.maxAttempts}`);
    lines.push("");
    appendResumeHint(lines, summary, taskRunnerCmd, "Run was interrupted by the user. To resume:");
    return `${lines.join("\n")}\n`;
  }

  lines.push(`Tasks completed: ${summary.tasksCompleted}/${summary.tasksTotal}`);
  lines.push(`Attempts: ${summary.attempts}/${summary.maxAttempts}`);

  if (summary.tasks.length > 0) {
    lines.push("");
    lines.push("Task results:");
    for (const task of summary.tasks) {
      lines.push(`  - ${task.id} — ${task.title} [${task.status}]`);
      const notes = task.notes.trim();
      if (notes) {
        for (const noteLine of notes.split("\n")) {
          lines.push(`      ${noteLine}`);
        }
      }
    }
  }

  lines.push("");
  appendResumeHint(lines, summary, taskRunnerCmd, "To continue this run:");

  return `${lines.join("\n")}\n`;
}

export function renderRunEvent(event: RunEvent): RenderedRunChunk[] {
  switch (event.type) {
    case "run_initialized": {
      const taskRunnerCmd = resolveTaskRunnerCommand();
      const lines = renderBannerLines({
        ...event,
        header: `task-runner: initialized ${event.passive ? "passive " : ""}agent=${event.agentName} run=${event.runId}`,
      });
      if (event.passive) {
        lines.push(`             brief=${taskRunnerCmd} run brief ${event.runId}`);
        lines.push(
          `             drive with: ${taskRunnerCmd} task set ${event.runId} <task-id> ...`,
        );
      } else {
        lines.push(`             brief=${taskRunnerCmd} run brief ${event.runId}`);
        lines.push(`             ready with: ${taskRunnerCmd} run ready ${event.runId}`);
      }
      return stderr(`${lines.join("\n")}\n`);
    }
    case "caller_instructions":
      return stderr(
        `\n── caller instructions ──\n${event.text.trim()}\n── end caller instructions ──\n`,
      );
    case "run_started": {
      const suffix = event.sessionIndex === null ? "" : ` (session ${event.sessionIndex})`;
      const lines = renderBannerLines({
        ...event,
        header: `task-runner: agent=${event.agentName} run=${event.runId}${suffix}`,
      });
      return stderr(`${lines.join("\n")}\n\n`);
    }
    case "attempt_started":
      return stderr(`── attempt ${event.attempt} ──\n`);
    case "agent_message_delta":
      return stdout(event.text);
    case "backend_notice":
      return stderr(event.text);
    case "retrying":
      return stderr(
        `\ntask-runner: retrying — ${event.incompleteCount} incomplete, ${event.invalidStatusCount} invalid status${event.invalidStatusCount === 1 ? "" : "es"}\n\n`,
      );
    case "run_aborted":
      return stderr("\ntask-runner: interrupted by user; stopping.\n");
    case "resume_rejected":
      return stderr("task-runner: backend rejected the resume session; stopping.\n");
    case "run_finished":
      return stderr(renderSummary(event.summary));
  }
}
