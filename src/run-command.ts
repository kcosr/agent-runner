import { UnknownBackendError, resolveBackend } from "./backends/registry.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  loadAgentConfig,
  loadAssignmentConfig,
} from "./config/loader.js";
import { loadedAgentFromManifest, synthesizeAdHocAgent } from "./core/config/loaded.js";
import { ResumeError, type RunManifest, resolveResumeTarget } from "./core/run/manifest.js";
import { type RunEvent, type RunOptions, type RunOutcome, runAgent } from "./core/run/run-loop.js";
import { resolveTaskRunnerCommand } from "./task-runner-command.js";

export class RunCommandError extends Error {
  constructor(
    message: string,
    public readonly showHelp: boolean = false,
  ) {
    super(message);
    this.name = "RunCommandError";
  }
}

export interface ExecuteRunCommandOptions {
  initialize: boolean;
  agent?: string;
  assignment?: string;
  definitionCwd?: string;
  callerCwd?: string;
  resumeRun?: string;
  backendSessionId?: string;
  cliVars: Record<string, string>;
  overrides: NonNullable<RunOptions["overrides"]>;
  abortSignal?: AbortSignal;
  emitEvent?: (event: RunEvent) => void;
}

function validateResumeOverrides(
  manifest: RunManifest,
  opts: ExecuteRunCommandOptions,
): string | null {
  if (manifest.archivedAt !== null) {
    return `cannot resume archived run ${manifest.runId} — unarchive it first with ${resolveTaskRunnerCommand()} run unarchive ${manifest.runId}`;
  }

  const priorInitialized = manifest.status === "initialized";

  if (opts.agent !== undefined) {
    return "--agent cannot be combined with --resume-run (the agent is fixed on the run; under the manifest-canonical design, resume reads it from run.json instead of reloading agent.md)";
  }
  if (opts.assignment !== undefined) {
    return "--assignment cannot be combined with --resume-run (the assignment is baked into the workspace; use --add-task to extend the task list)";
  }
  if (opts.overrides.backend !== undefined) {
    return "--backend cannot be combined with --resume-run (backend is locked to the run that created the session)";
  }
  if (opts.overrides.taskMode !== undefined) {
    return "--task-mode cannot be combined with --resume-run — task interaction mode is frozen into the manifest at first write. If you need a different mode, create a fresh run instead.";
  }
  if (opts.backendSessionId !== undefined) {
    return "--backend-session-id cannot be combined with --resume-run (the resume target already carries a backend session id)";
  }
  if (opts.overrides.cwd !== undefined) {
    return "--cwd cannot be combined with --resume-run — backend sessions are bound to the cwd they were created in, so a different cwd would invalidate the captured session id. If you need a different cwd, create a fresh run instead.";
  }
  if (Object.keys(opts.cliVars).length > 0) {
    return "--var cannot be combined with --resume-run — runtime vars are resolved from the assignment at first write and frozen into the manifest; they are not re-resolved on resume, so passing --var would silently no-op. Edit the assignment and create a fresh run if vars need to change.";
  }

  if (priorInitialized) {
    const forbidden: string[] = [];
    if (opts.overrides.message && opts.overrides.message.trim().length > 0)
      forbidden.push("message");
    if ((opts.overrides.addedTasks?.length ?? 0) > 0) forbidden.push("--add-task");
    if (opts.overrides.model !== undefined) forbidden.push("--model");
    if (opts.overrides.effort !== undefined) forbidden.push("--effort");
    if (opts.overrides.timeoutSec !== undefined) forbidden.push("--timeout-sec");
    if (opts.overrides.maxRetries !== undefined) forbidden.push("--max-retries");
    if (opts.overrides.unrestricted !== undefined) forbidden.push("--unrestricted");
    if (opts.overrides.sessionName !== undefined) forbidden.push("--session-name");
    if (forbidden.length > 0) {
      return `resuming an initialized run does not accept ${forbidden.join(", ")} — init froze these at creation. If you need different values, create a fresh run.`;
    }
    return null;
  }

  const hasMessage = Boolean(opts.overrides.message && opts.overrides.message.trim().length > 0);
  const hasAddedTasks = (opts.overrides.addedTasks?.length ?? 0) > 0;
  if (!hasMessage && !hasAddedTasks) {
    return "--resume-run requires a follow-up message or at least one --add-task";
  }
  return null;
}

export async function executeRunCommand(opts: ExecuteRunCommandOptions): Promise<RunOutcome> {
  if (opts.initialize && opts.resumeRun !== undefined) {
    throw new ResumeError("init cannot be combined with --resume-run");
  }

  let resumeTarget: ReturnType<typeof resolveResumeTarget> | undefined;
  if (opts.resumeRun !== undefined) {
    resumeTarget = resolveResumeTarget(opts.resumeRun);
    const violation = validateResumeOverrides(resumeTarget.manifest, opts);
    if (violation !== null) {
      throw new ResumeError(violation);
    }
  }

  const loaded =
    resumeTarget !== undefined
      ? loadedAgentFromManifest(resumeTarget.manifest)
      : opts.agent !== undefined
        ? loadAgentConfig(opts.agent, opts.definitionCwd)
        : (() => {
            if (opts.overrides.backend === undefined) {
              throw new RunCommandError(
                "--agent was omitted — --backend is required to synthesize an ad-hoc agent",
                true,
              );
            }
            return synthesizeAdHocAgent({
              backend: opts.overrides.backend,
              model: opts.overrides.model,
              effort: opts.overrides.effort,
              timeoutSec: opts.overrides.timeoutSec,
              unrestricted: opts.overrides.unrestricted,
              cwd: opts.overrides.cwd,
            });
          })();

  const loadedAssignment =
    opts.assignment !== undefined
      ? loadAssignmentConfig(opts.assignment, opts.definitionCwd)
      : undefined;

  const backendId =
    opts.overrides.backend ?? resumeTarget?.manifest.backend ?? loaded.config.backend;
  const backend = resolveBackend(backendId);

  if (!opts.initialize && backendId === "passive") {
    const taskRunnerCmd = resolveTaskRunnerCommand();
    const runId = resumeTarget?.manifest.runId;
    const hint = runId
      ? `${taskRunnerCmd} task set ${runId} <task-id> --status in_progress\n  ${taskRunnerCmd} status ${runId}`
      : `${taskRunnerCmd} init --agent <passive-agent> --assignment <...>\n  ${taskRunnerCmd} task set <run-id> <task-id> --status in_progress`;
    throw new RunCommandError(
      `cannot run passive agent "${loaded.config.name}" — passive agents are driven externally via task commands. Use:\n  ${hint}`,
    );
  }

  return runAgent({
    loaded,
    loadedAssignment,
    cliVars: opts.cliVars,
    backend,
    callerCwd: opts.callerCwd,
    resume: resumeTarget,
    initialize: opts.initialize,
    bootstrapBackendSessionId: opts.backendSessionId,
    abortSignal: opts.abortSignal,
    overrides: opts.overrides,
    emitEvent: opts.emitEvent,
  });
}

export {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  ResumeError,
  UnknownBackendError,
};
