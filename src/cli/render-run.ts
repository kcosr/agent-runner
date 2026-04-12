import { renderSummary } from "../runner/output.js";
import type { RunEvent } from "../runner/run-loop.js";
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
