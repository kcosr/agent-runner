import type { RunEvent } from "../core/run/run-loop.js";
import type { RunCompletionSummary } from "../core/run/status.js";
import { resolveTaskRunnerCommand } from "../task-runner-command.js";

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

function renderBannerLines(event: {
  agentName: string;
  runId: string;
  assignmentSourcePath: string | null;
  assignmentPath: string;
  sessionName: string | null;
  cwd: string;
  header: string;
}): string[] {
  const lines = [event.header];
  if (event.assignmentSourcePath) {
    lines.push(`             source=${event.assignmentSourcePath}`);
  }
  lines.push(`             assignment=${event.assignmentPath}`);
  if (event.sessionName) {
    lines.push(`             session=${event.sessionName}`);
  }
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
    lines.push(`Assignment file: ${summary.assignmentPath}`);
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
    lines.push(`Assignment file: ${summary.assignmentPath}`);
    lines.push("");
    lines.push("Run was interrupted by the user. To resume:");
    lines.push(`  ${taskRunnerCmd} run --resume-run ${summary.runId} "..."`);
    return `${lines.join("\n")}\n`;
  }

  lines.push(`Tasks completed: ${summary.tasksCompleted}/${summary.tasksTotal}`);
  lines.push(`Attempts: ${summary.attempts}/${summary.maxAttempts}`);
  lines.push(`Assignment file: ${summary.assignmentPath}`);

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
    lines.push("");
    lines.push(`Review ${summary.assignmentPath} for additional agent output.`);
  }

  lines.push("");
  lines.push("To continue this run with a follow-up message:");
  lines.push(`  ${taskRunnerCmd} run --resume-run ${summary.runId} "..."`);

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
      lines.push(
        event.passive
          ? `             drive with: ${taskRunnerCmd} task set ${event.runId} <task-id> ...`
          : `             resume with: ${taskRunnerCmd} run --resume-run ${event.runId}`,
      );
      const chunks = stderr(`${lines.join("\n")}\n`);
      if (event.passive && event.pendingPrompt.length > 0) {
        return [...chunks, ...stdout(`${event.pendingPrompt}\n`)];
      }
      return chunks;
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
