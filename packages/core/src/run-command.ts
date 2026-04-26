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
import { buildRunDependencyGraph, countUnsatisfiedDependencies } from "./core/run/dependencies.js";
import {
  ResumeError,
  type RunExecution,
  type RunManifest,
  listRunManifests,
  resolveResumeTarget,
} from "./core/run/manifest.js";
import { hasIncompleteTasks, missingResumeInputMessage } from "./core/run/resume-policy.js";
import type { RunAuditEnvelope } from "./core/run/run-events.js";
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
  parentRunId?: string | null;
  resumeRun?: string;
  backendSessionId?: string;
  cliVars: Record<string, string>;
  webVars: Record<string, string>;
  overrides: NonNullable<RunOptions["overrides"]>;
  execution?: RunExecution;
  abortSignal?: AbortSignal;
  emitEvent?: (event: RunEvent) => void;
  emitAuditEnvelope?: (envelope: RunAuditEnvelope) => void;
}

function passiveRunError(agentName: string, runId?: string): string {
  const taskRunnerCmd = resolveTaskRunnerCommand();
  const hint = runId
    ? `${taskRunnerCmd} task set ${runId} <task-id> --status in_progress\n  ${taskRunnerCmd} status ${runId}`
    : `${taskRunnerCmd} init --agent <passive-agent> --assignment <...>\n  ${taskRunnerCmd} task set <run-id> <task-id> --status in_progress`;
  return `cannot run passive agent "${agentName}" — passive agents are driven externally via task commands. Use:\n  ${hint}`;
}

function validateResumeOverrides(
  manifest: RunManifest,
  opts: ExecuteRunCommandOptions,
): string | null {
  const webVars = opts.webVars ?? {};
  if (manifest.archivedAt !== null) {
    return `cannot resume archived run ${manifest.runId} — unarchive it first with ${resolveTaskRunnerCommand()} run unarchive ${manifest.runId}`;
  }

  const priorReady = manifest.status === "ready" && manifest.sessions.length === 0;

  if (opts.agent !== undefined) {
    return "--agent cannot be combined with --resume-run (the agent is fixed on the run; under the manifest-canonical design, resume reads it from run.json instead of reloading agent.md)";
  }
  if (opts.assignment !== undefined) {
    return "--assignment cannot be combined with --resume-run (the assignment is baked into the workspace; use --add-task to extend the task list)";
  }
  if (opts.overrides.backend !== undefined) {
    return "--backend cannot be combined with --resume-run (backend is locked to the run that created the session)";
  }
  if (opts.overrides.launcher !== undefined) {
    return "--launcher cannot be combined with --resume-run (launcher is frozen into the run manifest)";
  }
  if (opts.backendSessionId !== undefined) {
    return "--backend-session-id cannot be combined with --resume-run (the resume target already carries a backend session id)";
  }
  if (opts.parentRunId !== undefined && opts.parentRunId !== null) {
    return "--parent-run cannot be combined with --resume-run";
  }
  if (opts.overrides.cwd !== undefined) {
    return "--cwd cannot be combined with --resume-run — backend sessions are bound to the cwd they were created in, so a different cwd would invalidate the captured session id. If you need a different cwd, create a fresh run instead.";
  }
  if (opts.overrides.name !== undefined) {
    return "--name cannot be combined with --resume-run";
  }
  if (Object.keys(opts.cliVars).length > 0) {
    return "--var cannot be combined with --resume-run — runtime vars are resolved from the assignment at first write and frozen into the manifest; they are not re-resolved on resume, so passing --var would silently no-op. Edit the assignment and create a fresh run if vars need to change.";
  }
  if (Object.keys(webVars).length > 0) {
    return "web-authored vars cannot be combined with --resume-run — runtime vars are resolved from the assignment at first write and frozen into the manifest; they are not re-resolved on resume. Start a fresh run if web inputs need to change.";
  }
  if (manifest.backend === "passive") {
    return passiveRunError(manifest.agent.name, manifest.runId);
  }
  if (manifest.status === "initialized") {
    return `cannot execute initialized run ${manifest.runId} — promote it first with ${resolveTaskRunnerCommand()} run ready ${manifest.runId}`;
  }

  if (priorReady) {
    const forbidden: string[] = [];
    if (opts.overrides.message && opts.overrides.message.trim().length > 0)
      forbidden.push("message");
    if ((opts.overrides.addedTasks?.length ?? 0) > 0) forbidden.push("--add-task");
    if (opts.overrides.launcher !== undefined) forbidden.push("--launcher");
    if (opts.overrides.model !== undefined) forbidden.push("--model");
    if (opts.overrides.effort !== undefined) forbidden.push("--effort");
    if (opts.overrides.timeoutSec !== undefined) forbidden.push("--timeout-sec");
    if (opts.overrides.maxRetries !== undefined) forbidden.push("--max-retries");
    if (opts.overrides.unrestricted !== undefined) forbidden.push("--unrestricted");
    if (opts.overrides.name !== undefined) forbidden.push("--name");
    if (forbidden.length > 0) {
      return `starting a ready run does not accept ${forbidden.join(", ")} — init froze these at creation. If you need different values, reinitialize the run first.`;
    }
    const unsatisfied = countUnsatisfiedDependencies(
      manifest,
      buildRunDependencyGraph(listRunManifests().map((entry) => entry.manifest)),
    );
    if (unsatisfied > 0) {
      return `cannot execute run ${manifest.runId} because ${unsatisfied} dependency run(s) are not successful`;
    }
    return null;
  }

  const hasMessage = Boolean(opts.overrides.message && opts.overrides.message.trim().length > 0);
  const hasAddedTasks = (opts.overrides.addedTasks?.length ?? 0) > 0;
  if (!hasMessage && !hasAddedTasks && !hasIncompleteTasks(manifest.finalTasks)) {
    return missingResumeInputMessage();
  }
  return null;
}

function validateInitOverwriteTarget(manifest: RunManifest): string | null {
  if (manifest.archivedAt !== null) {
    return `cannot reinitialize archived run ${manifest.runId}`;
  }
  if (manifest.status !== "initialized") {
    return `cannot reinitialize run ${manifest.runId} unless it is initialized`;
  }
  return null;
}

export async function executeRunCommand(opts: ExecuteRunCommandOptions): Promise<RunOutcome> {
  const webVars = opts.webVars ?? {};
  const isInitOverwrite = opts.initialize && opts.resumeRun !== undefined;

  let resumeTarget: ReturnType<typeof resolveResumeTarget> | undefined;
  if (opts.resumeRun !== undefined) {
    resumeTarget = resolveResumeTarget(opts.resumeRun);
    const violation = isInitOverwrite
      ? validateInitOverwriteTarget(resumeTarget.manifest)
      : validateResumeOverrides(resumeTarget.manifest, opts);
    if (violation !== null) {
      throw new ResumeError(violation);
    }
  }

  const loaded = isInitOverwrite
    ? opts.agent !== undefined
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
          });
        })()
    : resumeTarget !== undefined
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
            });
          })();

  const loadedAssignment =
    opts.assignment !== undefined
      ? loadAssignmentConfig(opts.assignment, opts.definitionCwd)
      : undefined;

  const backendId =
    opts.overrides.backend ?? resumeTarget?.manifest.backend ?? loaded.config.backend;
  const backend = resolveBackend(backendId);

  if (opts.backendSessionId !== undefined && backend.supportsBootstrapSessionImport === false) {
    throw new RunCommandError(
      `--backend-session-id is unsupported for ${backendId} because public ${backendId} resume ids are not safely self-validating`,
    );
  }

  if (!opts.initialize && backendId === "passive") {
    throw new RunCommandError(passiveRunError(loaded.config.name, resumeTarget?.manifest.runId));
  }

  return runAgent({
    loaded,
    loadedAssignment,
    cliVars: opts.cliVars,
    webVars,
    parentRunId: opts.parentRunId,
    backend,
    callerCwd: opts.callerCwd,
    resume: resumeTarget,
    initialize: opts.initialize,
    bootstrapBackendSessionId: opts.backendSessionId,
    execution: opts.execution,
    abortSignal: opts.abortSignal,
    overrides: opts.overrides,
    emitEvent: opts.emitEvent,
    emitAuditEnvelope: opts.emitAuditEnvelope,
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
