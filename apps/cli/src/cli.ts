#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  type RunCommandOverrides,
  addDependency,
  addRunAttachmentFromFile,
  appendNotes,
  archive,
  clearBackendSession,
  clearDependencies,
  clearGroup,
  clearRunSchedule,
  createTask,
  deleteArchivedRun,
  downloadRunAttachment,
  getAttachmentList,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunAuditHistory,
  getRunBrief,
  getRunList,
  getTask,
  getTaskList,
  initRun,
  readyRun,
  reconfigureRun,
  removeDependency,
  removeRunAttachment,
  renameRun,
  reset,
  resumeRun,
  setGroup,
  setRunSchedule,
  setRunScheduleEnabled,
  startRun,
  unarchive,
  updateRunBackendSession,
  updateRunNote,
  updateRunPinned,
  updateTask,
} from "@task-runner/core/app/service.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  DefinitionListError,
  LauncherConfigError,
  LauncherNotFoundError,
} from "@task-runner/core/config/loader.js";
import {
  isPathArg,
  resolveInputPath,
  resolveTaskRunnerConfigDir,
  resolveTaskRunnerStateDir,
} from "@task-runner/core/config/runtime-paths.js";
import type { RunDependencyRef } from "@task-runner/core/contracts/runs.js";
import {
  type BackendSpecificConfig,
  codexTransportFromEnvValues,
} from "@task-runner/core/core/backends/types.js";
import {
  CommandError,
  type RunListFilter,
  isCommandError,
} from "@task-runner/core/core/commands/service.js";
import { HookRuntimeError } from "@task-runner/core/core/hooks/runtime.js";
import { AttachmentError } from "@task-runner/core/core/run/attachments.js";
import { RunGroupValidationError, validateRunGroupId } from "@task-runner/core/core/run/groups.js";
import { RunNotFoundError } from "@task-runner/core/core/run/manifest.js";
import { ReconfigureLockedFieldError } from "@task-runner/core/core/run/reconfigure.js";
import { readParentRunIdFromEnv } from "@task-runner/core/core/run/recursion-guard.js";
import {
  EmptyPromptError,
  InvalidAddedTaskError,
  InvalidBackendSessionError,
  InvalidRunNameError,
  LockedFieldError,
  RecursionDepthError,
  type RunEvent,
  VarResolutionError,
} from "@task-runner/core/core/run/run-loop.js";
import {
  type ScheduleInput,
  ScheduleValidationError,
} from "@task-runner/core/core/run/schedule.js";
import {
  ResumeError,
  RunCommandError,
  UnknownBackendError,
} from "@task-runner/core/run-command.js";
import { normalizeRunNameMutation } from "@task-runner/core/util/run-name.js";
import { type ParsedArgs, overridesFromParsedArgs, parseArgs } from "./cli/parse-args.js";
import { renderRunEvent } from "./cli/render-run.js";
import {
  renderAttachmentAdded,
  renderAttachmentDownloaded,
  renderAttachmentList,
  renderAttachmentRemoved,
  renderDefinitionDetails,
  renderDefinitionList,
  renderRunAddDependency,
  renderRunArchive,
  renderRunAuditHistory,
  renderRunClearBackendSession,
  renderRunClearDependencies,
  renderRunClearGroup,
  renderRunDelete,
  renderRunList,
  renderRunReady,
  renderRunRemoveDependency,
  renderRunScheduleCleared,
  renderRunScheduleDisabled,
  renderRunScheduleEnabled,
  renderRunScheduleSet,
  renderRunSetBackendSession,
  renderRunSetGroup,
  renderRunSetName,
  renderRunSetNote,
  renderRunSetPinned,
  renderRunStatus,
  renderRunUnarchive,
  renderSystemStatus,
  renderTaskDetails,
  renderTaskList,
} from "./commands/render.js";
import { DaemonClient, DaemonConnectionError, DaemonRpcError } from "./daemon/client.js";
import { type ResolvedHostMode, resolveHostMode, resolveListenUrl } from "./daemon/config.js";
import { SshTunnelSetupError, openSshTunnel } from "./daemon/connect-host.js";
import { DaemonHttpError, daemonGetRunAuditHistory } from "./daemon/http-client.js";
import { type DaemonInfo, RPC_ERROR_COMMAND } from "./daemon/protocol.js";
import { serveDaemon } from "./daemon/server.js";

const HELP = `Usage: task-runner <run|init|serve|status|task|attachment|list|show> [options] [args]

Commands:
  run                     Execute an agent. Either a fresh run, a resume,
                          or start/resume an existing non-initialized run.
  run status <id>         Read a run and print its current status.
  run audit <id>          Read the persisted audit history for a run.
  run brief <id>          Print the canonical worker handoff for a run.
  run reconfigure <id>    Patch vars/message for an initialized run.
  run ready <id|path>     Promote an initialized run into ready state.
  run schedule <id|path>  Set a run schedule with --at, --delay, or --cron.
  run schedule enable <id|path>
                          Enable an existing schedule.
  run schedule disable <id|path>
                          Disable an existing schedule.
  run schedule clear <id|path>
                          Clear a one-time schedule.
  run reset <id|path>     Restore a non-running run to initialized state.
  run archive <id|path>   Mark a non-running run as archived.
  run unarchive <id|path> Clear a run's archive marker.
  run delete <id|path>    Delete an archived run workspace.
  run set-name <id|path>  Update or clear a run's persisted display name.
  run set-note <id|path> <text>
                          Persist a run note (empty/whitespace clears it).
  run clear-note <id|path>
                          Clear a run's persisted note.
  run pin <id|path>       Mark a run as pinned.
  run unpin <id|path>     Clear a run's pinned marker.
  run set-backend-session <id|path> <session-id>
                          Persist a passive run backend session reference.
  run clear-backend-session <id|path>
                          Clear a passive run backend session reference.
  run set-group <id|path> <group-id>
                          Set a non-running run's group.
  run clear-group <id|path>
                          Reset a non-running run to its singleton group.
  run add-dep <id> --run <dep-run-id>
  run add-dep <id> --group <group-id>
                          Add a dependency to an initialized run.
  run remove-dep <id> --run <dep-run-id>
  run remove-dep <id> --group <group-id>
                          Remove a dependency from an initialized run.
  run clear-deps <id>     Remove all dependencies from an initialized run.
  init                    Prepare a run without invoking the backend.
                          Use --run-id <id|path> to overwrite an
                          existing initialized run in place.
  serve                   Start the local daemon server.
  status                  Print the current task-runner environment status.
  task list <id>          List tasks for a run in stable task order.
  task show <id> <task>   Show one task snapshot for a run.
  task set <id> <task>    Update a task's status and/or notes.
  task append-notes <id> <task>
                          Append text to a task's notes.
  task add <id>           Append a new task to a run's task list.
  attachment add <id> <file>
                          Add a file attachment to a run.
  attachment list <id>    List attachments for a run.
  attachment remove <id> <attachment-id>
                          Remove one attachment from a run.
  attachment download <id> <attachment-id> <output-path>
                          Download one attachment from a run.
  list <agents|assignments|launchers|runs>
                          Enumerate definitions or runs.
  show <agent|assignment|launcher> <name|path>
                          Print details of a specific definition.

Arguments:
  [message]               Positional text for fresh runs or resumes.

Task command options:
  --status <s>            (task set) Target status.
  --notes <text>          (task set) Replacement notes body.
  --text <text>           (task append-notes) Text to append.
  --title <text>          (task add) Title for the new task.
  --body <text>           (task add) Optional task body.
  --name <text>           (attachment add) Optional display name.
  --mime-type <type>      (attachment add) Optional MIME type override.
  --scope <run|group>     (attachment list) Attachment listing scope.

Host selection:
  --connect <ws-url>      Route the command through the daemon host.
                          Also honored from TASK_RUNNER_CONNECT.
  --connect-host <host>   Create an invocation-scoped SSH local forward
                          before connecting to the daemon. Also honored
                          from TASK_RUNNER_CONNECT_HOST.
  --connect-local-port    Override the local loopback port used for the
                          SSH forward. Also honored from
                          TASK_RUNNER_CONNECT_LOCAL_PORT.
  --listen <ws-url>       (serve only) Listen URL for the daemon host.
                          Also honored from TASK_RUNNER_LISTEN. The same
                          listener serves HTTP/SSE under /api/.

Execution options:
  --agent <name|path>     Agent bare name or direct path to agent.md.
  --assignment <n|path>   Assignment bare name or direct path to assignment.md.
  --backend-session-id    Adopt an existing backend session id.
  --resume-run <id|path>  Continue an existing run by short id or path.
  --parent-run <run-id>   Set the lineage parent for a fresh run/init.
  --group-id <group-id>   Set the explicit run group for a fresh run/init,
                          or scope list runs to a run group.
  --run-id <id|path>      (init only) Overwrite an initialized run in place.
  --var <key>=<value>     Set an input variable (repeatable).
                          Nested child runs usually inherit parent-owned
                          vars through assignment \`sources: [parent]\`.
  --message-file <path>   Read UTF-8 message text from a file instead of
                          positional message text.
  --add-task <title>      Append a task to the run's task list.
  --cwd <path>            Override the run cwd, or scope list runs to a cwd.
  --backend <id>          Override the agent's backend.
  --launcher <name>       Override the run launcher by named launcher id.
  --model <id>            Override the agent's model.
  --effort <level>        Override effort level.
  --timeout-sec <n>       Override the per-attempt timeout.
  --max-retries <n>       Override the max number of retries.
  --unrestricted          Bypass the backend's approval prompts.
  --name <name>           Set the persisted run display name.
  --schedule-at <iso>     (init, run ready) Schedule a one-time run.
  --schedule-delay <dur>  (init, run ready) Schedule after a duration.
  --schedule-cron <expr>  (init, run ready) Schedule a recurring run.
  --schedule-timezone <tz>
                          Timezone for --schedule-cron.
  --schedule-mode <m>     Recurrence mode: reuse, reset, or clone.
  --schedule-continue-on-failure
                          Continue recurring schedules after failures.
  --at <iso>              (run schedule) Set one-time schedule timestamp.
  --delay <duration>      (run schedule) Set schedule relative to now.
  --cron <expr>           (run schedule) Set recurring cron schedule.
  --timezone <tz>         (run schedule) Timezone for --cron.
  --mode <m>              (run schedule) Recurrence mode.
  --continue-on-failure   (run schedule) Continue recurrence after failures.
  --clear                 (run set-name) Clear the persisted run name.
  --detach                (run only, daemon mode only) Dispatch and exit
                          after the daemon accepts the run.
  --repo <name>           (list runs only) Scope runs to an exact repo.
  --global                (list runs only) Disable default cwd scoping.
  --output-format <fmt>   Output format: "text" (default) or "json".
  --limit <n>             (run audit only) Limit history to the last N rows.
  --field <name>          (run status only, repeatable) Restrict JSON output.
  --include-archived      (list runs only) Include archived runs.
  --help, -h              Print this message.

Exit codes:
  0    All tasks completed successfully (or 0-task run succeeded)
  1    Retries exhausted with incomplete tasks
  2    One or more tasks reported as blocked
  3    Config / validation / daemon connectivity error
  4    Backend / runtime error
  130  Run interrupted by user (Ctrl+C) or external cancellation
`;

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function daemonUnavailableHint(connectUrl: string): string {
  return `task-runner: cannot connect to daemon at ${connectUrl}\nHint: task-runner serve --listen ${connectUrl}\n`;
}

type DaemonConnectContext = Extract<ResolvedHostMode, { mode: "daemon" }>;

function exitCommandFailure(err: unknown, connectUrl?: string): never {
  if (err instanceof DaemonConnectionError) {
    process.stderr.write(daemonUnavailableHint(connectUrl ?? err.url));
    process.exit(3);
  }

  if (err instanceof DaemonRpcError && err.code === RPC_ERROR_COMMAND) {
    process.stderr.write(`task-runner: ${err.message}\n`);
    process.exit(3);
  }

  if (
    isCommandError(err) ||
    err instanceof AttachmentError ||
    err instanceof SshTunnelSetupError ||
    err instanceof AgentNotFoundError ||
    err instanceof AgentConfigError ||
    err instanceof AssignmentNotFoundError ||
    err instanceof AssignmentConfigError ||
    err instanceof LauncherNotFoundError ||
    err instanceof LauncherConfigError ||
    err instanceof DefinitionListError ||
    err instanceof RunCommandError ||
    err instanceof VarResolutionError ||
    err instanceof LockedFieldError ||
    err instanceof ReconfigureLockedFieldError ||
    err instanceof ResumeError ||
    err instanceof HookRuntimeError ||
    err instanceof RunGroupValidationError
  ) {
    process.stderr.write(`task-runner: ${errorMessage(err)}\n`);
    process.exit(3);
  }

  if (connectUrl && err instanceof Error && /ECONNREFUSED|socket hang up/i.test(err.message)) {
    process.stderr.write(daemonUnavailableHint(connectUrl));
    process.exit(3);
  }

  process.stderr.write(`task-runner: ${errorMessage(err)}\n`);
  process.exit(4);
}

function emitRenderedEvent(event: RunEvent): void {
  for (const chunk of renderRunEvent(event)) {
    if (chunk.stream === "stdout") {
      process.stdout.write(chunk.text);
    } else {
      process.stderr.write(chunk.text);
    }
  }
}

function projectStatus(
  detail: ReturnType<typeof getRun>,
  fields: string[],
): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  const source = detail as unknown as Record<string, unknown>;
  const missing: string[] = [];
  for (const field of fields) {
    if (field in source) {
      projection[field] = source[field];
    } else {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new CommandError(`unknown status field(s): ${missing.join(", ")}`);
  }
  return projection;
}

function normalizeTarget(target: string | undefined): string | undefined {
  if (!target) {
    return target;
  }
  return isPathArg(target) ? resolveInputPath(target, process.cwd()) : target;
}

function normalizeRunIdTarget(target: string | undefined, commandName: string): string | undefined {
  if (!target) {
    return target;
  }
  if (isPathArg(target) || target.includes("..")) {
    throw new CommandError(`${commandName} accepts a run id, not a path`);
  }
  return target;
}

function resolveParentRunId(parsed: ParsedArgs): string | undefined {
  const explicit = normalizeRunIdTarget(parsed.parentRun, "--parent-run");
  return explicit ?? readParentRunIdFromEnv() ?? undefined;
}

function resolvedOverrides(parsed: ParsedArgs) {
  return {
    ...overridesFromParsedArgs(parsed),
    cwd: parsed.cwd ? resolveInputPath(parsed.cwd, process.cwd()) : undefined,
  };
}

function resolveMessageFile(parsed: ParsedArgs): void {
  if (parsed.messageFile === undefined) {
    return;
  }
  if (parsed.message !== undefined) {
    throw new CommandError("--message-file cannot be combined with a positional message");
  }
  try {
    parsed.message = readFileSync(resolveInputPath(parsed.messageFile, process.cwd()), "utf8");
  } catch (err) {
    throw new CommandError(
      `cannot read --message-file ${parsed.messageFile}: ${errorMessage(err)}`,
    );
  }
}

function synthesizeClientCodexTransportOverrides():
  | Pick<RunCommandOverrides, "backendSpecific" | "codexTransportEnv">
  | undefined {
  const udsPath = process.env.TASK_RUNNER_CODEX_UDS_PATH;
  const wsUrl = process.env.TASK_RUNNER_CODEX_WS_URL;
  const trimmedUdsPath = udsPath?.trim();
  const trimmedWsUrl = wsUrl?.trim();
  if (trimmedUdsPath && trimmedWsUrl) {
    return {
      codexTransportEnv: {
        udsPath,
        wsUrl,
      },
    };
  }
  let transport: ReturnType<typeof codexTransportFromEnvValues>;
  try {
    transport = codexTransportFromEnvValues({ udsPath, wsUrl });
  } catch (err) {
    throw new CommandError(err instanceof Error ? err.message : String(err));
  }
  if (!transport) {
    return undefined;
  }
  return {
    backendSpecific: {
      codex: {
        transport,
      },
    },
  };
}

function resolvedDaemonOverrides(parsed: ParsedArgs): RunCommandOverrides {
  const codexTransportOverrides =
    parsed.resumeRun === undefined ? synthesizeClientCodexTransportOverrides() : {};
  return {
    ...resolvedOverrides(parsed),
    ...codexTransportOverrides,
  };
}

function hasScheduleInitFlags(parsed: ParsedArgs): boolean {
  return (
    parsed.scheduleAt !== undefined ||
    parsed.scheduleDelay !== undefined ||
    parsed.scheduleCron !== undefined ||
    parsed.scheduleTimezone !== undefined ||
    parsed.scheduleMode !== undefined ||
    parsed.scheduleContinueOnFailure !== undefined
  );
}

function hasRunScheduleFlags(parsed: ParsedArgs): boolean {
  return (
    parsed.at !== undefined ||
    parsed.delay !== undefined ||
    parsed.cron !== undefined ||
    parsed.timezone !== undefined ||
    parsed.mode !== undefined ||
    parsed.continueOnFailure !== undefined
  );
}

function buildScheduleInputFromInitFlags(parsed: ParsedArgs): ScheduleInput | undefined {
  if (!hasScheduleInitFlags(parsed)) {
    return undefined;
  }
  return {
    at: parsed.scheduleAt,
    delay: parsed.scheduleDelay,
    cron: parsed.scheduleCron,
    timezone: parsed.scheduleTimezone,
    mode: parsed.scheduleMode,
    continueOnFailure: parsed.scheduleContinueOnFailure,
  };
}

function buildScheduleInputFromRunScheduleFlags(parsed: ParsedArgs): ScheduleInput {
  const sourceCount =
    Number(parsed.at !== undefined) +
    Number(parsed.delay !== undefined) +
    Number(parsed.cron !== undefined);
  if (sourceCount !== 1) {
    throw new CommandError("run schedule requires exactly one of --at, --delay, or --cron");
  }
  if (parsed.cron === undefined) {
    if (parsed.timezone !== undefined) {
      throw new CommandError("--timezone is valid only with --cron");
    }
    if (parsed.mode !== undefined) {
      throw new CommandError("--mode is valid only with --cron");
    }
    if (parsed.continueOnFailure !== undefined) {
      throw new CommandError("--continue-on-failure is valid only with --cron");
    }
  }
  return {
    at: parsed.at,
    delay: parsed.delay,
    cron: parsed.cron,
    timezone: parsed.timezone,
    mode: parsed.mode,
    continueOnFailure: parsed.continueOnFailure,
  };
}

function renderInitializedRun(detail: ReturnType<typeof getRun>): void {
  emitRenderedEvent({
    type: "run_initialized",
    runId: detail.runId,
    agentName: detail.agent.name,
    assignmentSourcePath: detail.assignment?.sourcePath ?? null,
    name: detail.name,
    cwd: detail.cwd,
    passive: detail.backend === "passive",
    brief: "",
  });
  if (detail.callerInstructions) {
    emitRenderedEvent({
      type: "caller_instructions",
      text: detail.callerInstructions,
    });
  }
}

function renderDetachedRun(runId: string, outputFormat: ParsedArgs["outputFormat"]): void {
  if (outputFormat === "json") {
    writeJson({ runId, detached: true });
    return;
  }

  process.stdout.write(`task-runner: detached run ${runId}\n`);
  process.stdout.write(`Resume later with: task-runner run --resume-run ${runId} "..."\n`);
  process.stdout.write(`Check status with: task-runner run status ${runId}\n`);
}

function terminalExitCode(status: string): number {
  switch (status) {
    case "success":
    case "initialized":
      return 0;
    case "blocked":
      return 2;
    case "exhausted":
      return 1;
    case "aborted":
      return 130;
    default:
      return 4;
  }
}

async function withDaemonClient<T>(
  connect: DaemonConnectContext,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await DaemonClient.connect(connect.effectiveConnectUrl);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function runServe(parsed: ParsedArgs): Promise<never> {
  if (parsed.connect !== undefined) {
    process.stderr.write("task-runner: serve does not accept --connect\n");
    process.exit(3);
  }
  if (parsed.connectHost !== undefined) {
    process.stderr.write("task-runner: serve does not accept --connect-host\n");
    process.exit(3);
  }
  if (parsed.connectLocalPort !== undefined) {
    process.stderr.write("task-runner: serve does not accept --connect-local-port\n");
    process.exit(3);
  }
  if (parsed.positionals.length > 0) {
    process.stderr.write("task-runner: serve takes no positional arguments\n");
    process.exit(3);
  }
  const listenUrl = resolveListenUrl(parsed.listen);
  const server = await serveDaemon(listenUrl);
  let closing = false;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await server.close();
    process.exit(exitCode);
  };
  process.on("SIGINT", () => {
    void shutdown(130);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
  process.stderr.write(`task-runner: serving on ${server.listenUrl}\n`);
  process.stderr.write(`task-runner: http api on ${new URL("/api/", server.httpBaseUrl)}\n`);
  // Keep the process alive until SIGINT closes the daemon.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return await new Promise<never>(() => {});
}

async function runSystemStatus(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  try {
    if (parsed.fields.length > 0) {
      throw new CommandError("status does not support --field");
    }
    if (parsed.positionals.length > 0) {
      process.stderr.write("task-runner: status takes no positional arguments\n");
      process.stderr.write("Usage: task-runner status [--output-format text|json]\n");
      process.exit(3);
    }

    const result =
      connect === undefined
        ? {
            configDir: resolveTaskRunnerConfigDir(),
            stateDir: resolveTaskRunnerStateDir(),
            hostMode: "embedded" as const,
            connectUrl: null,
            daemon: null,
          }
        : await withDaemonClient(connect, (client) =>
            client.call<DaemonInfo>("daemon.info").then((daemon) => ({
              configDir: resolveTaskRunnerConfigDir(),
              stateDir: resolveTaskRunnerStateDir(),
              hostMode: "daemon" as const,
              connectUrl: connect.connectUrl,
              daemon,
            })),
          );

    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(renderSystemStatus(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runRunStatus(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  try {
    const unsupported = unsupportedFlagsForGroupedCommand(parsed, { allowFields: true });
    if (unsupported.length > 0) {
      process.stderr.write(
        `task-runner: run status only supports <run-id>, --connect, --output-format, and --field (got ${unsupported.join(", ")})\n`,
      );
      process.exit(3);
    }
    const target = normalizeRunIdTarget(parsed.positionals[0], "run status");
    if (!target) {
      process.stderr.write("task-runner: run status requires a run id\n");
      process.stderr.write(
        "Usage: task-runner run status <id> [--output-format json] [--field name]...\n",
      );
      process.exit(3);
    }
    if (parsed.positionals.length > 1) {
      process.stderr.write(
        `task-runner: run status takes exactly one run id; got "${parsed.positionals[1]}"\n`,
      );
      process.exit(3);
    }
    const result =
      connect === undefined
        ? getRun(target)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ run: ReturnType<typeof getRun> }>("runs.get", { target })
              .then((r) => r.run),
          );
    if (parsed.outputFormat === "json") {
      writeJson(parsed.fields.length > 0 ? projectStatus(result, parsed.fields) : result);
    } else {
      if (parsed.fields.length > 0) {
        throw new CommandError("--field requires --output-format json");
      }
      process.stdout.write(renderRunStatus(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runRunAudit(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  try {
    if (parsed.fields.length > 0) {
      throw new CommandError("run audit does not support --field");
    }
    const unsupported = unsupportedFlagsForGroupedCommand(parsed, { allowLimit: true });
    if (unsupported.length > 0) {
      process.stderr.write(
        `task-runner: run audit only supports <run-id>, --connect, --output-format, and --limit (got ${unsupported.join(", ")})\n`,
      );
      process.exit(1);
    }
    const target = normalizeRunIdTarget(parsed.positionals[0], "run audit");
    if (!target) {
      process.stderr.write("task-runner: run audit requires a run id\n");
      process.stderr.write(
        "Usage: task-runner run audit <id> [--output-format json] [--limit <n>]\n",
      );
      process.exit(1);
    }
    if (parsed.positionals.length > 1) {
      process.stderr.write(
        `task-runner: run audit takes exactly one run id; got "${parsed.positionals[1]}"\n`,
      );
      process.exit(1);
    }
    const history =
      connect === undefined
        ? getRunAuditHistory(target, { limit: parsed.limit })
        : await daemonGetRunAuditHistory(connect.effectiveConnectUrl, target, {
            limit: parsed.limit,
          });
    if (parsed.outputFormat === "json") {
      writeJson(history);
    } else {
      process.stdout.write(renderRunAuditHistory(history));
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof RunNotFoundError) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof DaemonHttpError && err.status === 404) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(2);
    }
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runRunBrief(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  try {
    if (parsed.outputFormatExplicit) {
      throw new CommandError("run brief does not support --output-format");
    }
    if (parsed.fields.length > 0) {
      throw new CommandError("run brief does not support --field");
    }
    const unsupported = unsupportedFlagsForGroupedCommand(parsed);
    if (unsupported.length > 0) {
      process.stderr.write(
        `task-runner: run brief only supports <run-id> and --connect (got ${unsupported.join(", ")})\n`,
      );
      process.exit(3);
    }
    const target = normalizeRunIdTarget(parsed.positionals[0], "run brief");
    if (!target) {
      process.stderr.write("task-runner: run brief requires a run id\n");
      process.stderr.write("Usage: task-runner run brief <id>\n");
      process.exit(3);
    }
    if (parsed.positionals.length > 1) {
      process.stderr.write(
        `task-runner: run brief takes exactly one run id; got "${parsed.positionals[1]}"\n`,
      );
      process.exit(3);
    }
    const brief =
      connect === undefined
        ? getRunBrief(target)
        : await withDaemonClient(connect, (client) =>
            client.call<{ brief: string }>("runs.brief", { target }).then((r) => r.brief),
          );
    process.stdout.write(`${brief}\n`);
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

function buildReconfigurePatch(parsed: ParsedArgs): {
  vars?: Record<string, string>;
  message?: string;
} {
  const patch: {
    vars?: Record<string, string>;
    message?: string;
  } = {};
  if (Object.keys(parsed.vars).length > 0) {
    patch.vars = { ...parsed.vars };
  }
  if (parsed.message !== undefined) {
    patch.message = parsed.message;
  }
  return patch;
}

async function runReconfigureCommand(
  parsed: ParsedArgs,
  connect?: DaemonConnectContext,
): Promise<never> {
  try {
    if (parsed.fields.length > 0) {
      throw new CommandError("run reconfigure does not support --field");
    }
    const unsupported = unsupportedFlagsForGroupedCommand(parsed, {
      allowVars: true,
      allowMessageFile: true,
    });
    if (unsupported.length > 0) {
      process.stderr.write(
        `task-runner: run reconfigure only supports <run-id>, --var, --message-file, positional message, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
      );
      process.exit(3);
    }
    const target = normalizeRunIdTarget(parsed.positionals[0], "run reconfigure");
    if (!target) {
      process.stderr.write("task-runner: run reconfigure requires a run id\n");
      process.stderr.write(
        "Usage: task-runner run reconfigure <id> [--var key=value ...] [--message-file <path> | <message...>] [--output-format text|json]\n",
      );
      process.exit(3);
    }
    resolveMessageFile(parsed);
    const patch = buildReconfigurePatch(parsed);
    const run =
      connect === undefined
        ? await reconfigureRun(target, patch)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ run: ReturnType<typeof getRun> }>("runs.reconfigure", {
                target,
                ...patch,
              })
              .then((result) => result.run),
          );
    if (parsed.outputFormat === "json") {
      writeJson(run);
    } else {
      process.stdout.write(`task-runner: reconfigured run ${run.runId}\n`);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof RunNotFoundError) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(2);
    }
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runListCommand(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  const kindArg = parsed.subcommand;
  if (
    kindArg !== "agents" &&
    kindArg !== "assignments" &&
    kindArg !== "launchers" &&
    kindArg !== "runs"
  ) {
    process.stderr.write(
      `task-runner: list requires a kind: agents, assignments, launchers, or runs${kindArg ? ` (got "${kindArg}")` : ""}\n`,
    );
    process.stderr.write(
      "Usage: task-runner list <agents|assignments|launchers|runs> [--cwd <path> | --repo <name> | --global | --group-id <group-id>] [--include-archived] [--output-format json]\n",
    );
    process.exit(3);
  }

  try {
    if (kindArg === "runs") {
      if (parsed.positionals.length > 0) {
        process.stderr.write(
          `task-runner: list runs takes no positional args; got "${parsed.positionals[0]}"\n`,
        );
        process.exit(3);
      }
      const unsupported = unsupportedFlagsForGroupedCommand(parsed, {
        allowIncludeArchived: true,
        allowRunListScope: true,
      });
      if (unsupported.length > 0) {
        process.stderr.write(
          `task-runner: list runs only supports --cwd, --repo, --global, --group-id, --connect, --include-archived, and --output-format (got ${unsupported.join(", ")})\n`,
        );
        process.exit(3);
      }
      const filter = resolveRunListFilter(parsed);
      const result =
        connect === undefined
          ? getRunList(filter)
          : await withDaemonClient(connect, (client) =>
              client
                .call<{ runs: ReturnType<typeof getRunList> }>("runs.list", filter)
                .then((r) => r.runs),
            );
      if (parsed.outputFormat === "json") {
        writeJson(result);
      } else {
        process.stdout.write(renderRunList(result));
      }
      process.exit(0);
    }

    const unsupported = unsupportedFlagsForGroupedCommand(parsed);
    if (unsupported.length > 0) {
      process.stderr.write(
        `task-runner: list ${kindArg} only supports --connect and --output-format (got ${unsupported.join(", ")})\n`,
      );
      process.exit(3);
    }
    const definitionKind =
      kindArg === "agents" ? "agent" : kindArg === "assignments" ? "assignment" : "launcher";
    const result =
      connect === undefined
        ? getDefinitionList(definitionKind)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{
                agents?: ReturnType<typeof getDefinitionList>;
                assignments?: ReturnType<typeof getDefinitionList>;
                launchers?: ReturnType<typeof getDefinitionList>;
              }>(
                kindArg === "agents"
                  ? "agents.list"
                  : kindArg === "assignments"
                    ? "assignments.list"
                    : "launchers.list",
              )
              .then((r) =>
                kindArg === "agents"
                  ? r.agents
                  : kindArg === "assignments"
                    ? r.assignments
                    : r.launchers,
              )
              .then((detail) => {
                if (!detail) {
                  throw new Error(`missing ${definitionKind} list`);
                }
                return detail;
              }),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      for (const warning of result.warnings) {
        process.stderr.write(`task-runner: warning: ${warning}\n`);
      }
      process.stdout.write(
        renderDefinitionList({
          kind: definitionKind,
          entries: result.entries,
          warnings: result.warnings,
        }),
      );
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runShowCommand(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  const kindArg = parsed.subcommand;
  if (kindArg !== "agent" && kindArg !== "assignment" && kindArg !== "launcher") {
    process.stderr.write(
      `task-runner: show requires a kind: agent, assignment, or launcher${kindArg ? ` (got "${kindArg}")` : ""}\n`,
    );
    process.stderr.write(
      "Usage: task-runner show <agent|assignment|launcher> <name|path> [--connect <ws-url>] [--output-format json]\n",
    );
    process.exit(3);
  }

  const target = normalizeTarget(parsed.positionals[0]);
  if (!target) {
    process.stderr.write(`task-runner: show ${kindArg} requires a name or path\n`);
    process.stderr.write(
      "Usage: task-runner show <agent|assignment|launcher> <name|path> [--connect <ws-url>] [--output-format json]\n",
    );
    process.exit(3);
  }

  try {
    const result =
      connect === undefined
        ? getDefinition(kindArg, target, process.cwd())
        : await withDaemonClient(connect, (client) =>
            client
              .call<{
                agent?: ReturnType<typeof getDefinition>;
                assignment?: ReturnType<typeof getDefinition>;
                launcher?: ReturnType<typeof getDefinition>;
              }>(
                kindArg === "agent"
                  ? "agents.get"
                  : kindArg === "assignment"
                    ? "assignments.get"
                    : "launchers.get",
                {
                  target,
                  cwd: process.cwd(),
                },
              )
              .then((r) =>
                kindArg === "agent"
                  ? r.agent
                  : kindArg === "assignment"
                    ? r.assignment
                    : r.launcher,
              )
              .then((detail) => {
                if (!detail) {
                  throw new Error(`missing ${kindArg} detail`);
                }
                return detail;
              }),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(renderDefinitionDetails(result as never));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

function unsupportedFlagsForGroupedCommand(
  parsed: ParsedArgs,
  opts: {
    allowFields?: boolean;
    allowLimit?: boolean;
    allowIncludeArchived?: boolean;
    allowRunListScope?: boolean;
    allowVars?: boolean;
    allowMessageFile?: boolean;
    allowClear?: boolean;
    allowAttachmentName?: boolean;
    allowAttachmentMimeType?: boolean;
    allowAttachmentScope?: boolean;
    allowDependencyRef?: boolean;
    allowScheduleInitFlags?: boolean;
    allowRunScheduleFlags?: boolean;
  } = {},
): string[] {
  const unsupported: string[] = [];
  if (parsed.agent !== undefined) unsupported.push("--agent");
  if (parsed.assignment !== undefined) unsupported.push("--assignment");
  if (parsed.resumeRun !== undefined) unsupported.push("--resume-run");
  if (parsed.runId !== undefined) unsupported.push("--run-id");
  if (parsed.backendSessionId !== undefined) unsupported.push("--backend-session-id");
  if (parsed.parentRun !== undefined) unsupported.push("--parent-run");
  if (!opts.allowRunListScope && parsed.groupId !== undefined) unsupported.push("--group-id");
  if (!opts.allowDependencyRef && parsed.dependencyRun !== undefined) unsupported.push("--run");
  if (!opts.allowDependencyRef && parsed.dependencyGroupId !== undefined)
    unsupported.push("--group");
  if (!opts.allowVars && Object.keys(parsed.vars).length > 0) unsupported.push("--var");
  if (!opts.allowRunListScope && parsed.cwd !== undefined) unsupported.push("--cwd");
  if (!opts.allowRunListScope && parsed.repo !== undefined) unsupported.push("--repo");
  if (!opts.allowRunListScope && parsed.global) unsupported.push("--global");
  if (parsed.backend !== undefined) unsupported.push("--backend");
  if (parsed.model !== undefined) unsupported.push("--model");
  if (parsed.effort !== undefined) unsupported.push("--effort");
  if (parsed.timeoutSec !== undefined) unsupported.push("--timeout-sec");
  if (parsed.unrestricted !== undefined) unsupported.push("--unrestricted");
  if (parsed.maxRetries !== undefined) unsupported.push("--max-retries");
  if (parsed.name !== undefined) unsupported.push("--name");
  if (!opts.allowScheduleInitFlags && parsed.scheduleAt !== undefined)
    unsupported.push("--schedule-at");
  if (!opts.allowScheduleInitFlags && parsed.scheduleDelay !== undefined)
    unsupported.push("--schedule-delay");
  if (!opts.allowScheduleInitFlags && parsed.scheduleCron !== undefined)
    unsupported.push("--schedule-cron");
  if (!opts.allowScheduleInitFlags && parsed.scheduleTimezone !== undefined)
    unsupported.push("--schedule-timezone");
  if (!opts.allowScheduleInitFlags && parsed.scheduleMode !== undefined)
    unsupported.push("--schedule-mode");
  if (!opts.allowScheduleInitFlags && parsed.scheduleContinueOnFailure !== undefined)
    unsupported.push("--schedule-continue-on-failure");
  if (!opts.allowRunScheduleFlags && parsed.at !== undefined) unsupported.push("--at");
  if (!opts.allowRunScheduleFlags && parsed.delay !== undefined) unsupported.push("--delay");
  if (!opts.allowRunScheduleFlags && parsed.cron !== undefined) unsupported.push("--cron");
  if (!opts.allowRunScheduleFlags && parsed.timezone !== undefined) unsupported.push("--timezone");
  if (!opts.allowRunScheduleFlags && parsed.mode !== undefined) unsupported.push("--mode");
  if (!opts.allowRunScheduleFlags && parsed.continueOnFailure !== undefined)
    unsupported.push("--continue-on-failure");
  if (!opts.allowClear && parsed.clear) unsupported.push("--clear");
  if (!opts.allowFields && parsed.fields.length > 0) unsupported.push("--field");
  if (parsed.taskStatus !== undefined) unsupported.push("--status");
  if (parsed.taskNotes !== undefined) unsupported.push("--notes");
  if (parsed.taskAppendText !== undefined) unsupported.push("--text");
  if (parsed.taskTitle !== undefined) unsupported.push("--title");
  if (parsed.taskBody !== undefined) unsupported.push("--body");
  if (!opts.allowAttachmentName && parsed.attachmentName !== undefined) unsupported.push("--name");
  if (!opts.allowAttachmentMimeType && parsed.attachmentMimeType !== undefined) {
    unsupported.push("--mime-type");
  }
  if (!opts.allowAttachmentScope && parsed.attachmentScope !== undefined)
    unsupported.push("--scope");
  if (!opts.allowLimit && parsed.limit !== undefined) unsupported.push("--limit");
  if (parsed.addedTasks.length > 0) unsupported.push("--add-task");
  if (!opts.allowMessageFile && parsed.messageFile !== undefined)
    unsupported.push("--message-file");
  if (parsed.detach) unsupported.push("--detach");
  if (parsed.listen !== undefined) unsupported.push("--listen");
  if (!opts.allowIncludeArchived && parsed.includeArchived) unsupported.push("--include-archived");
  return unsupported;
}

function resolveRunListFilter(parsed: ParsedArgs): RunListFilter {
  const explicitScopeCount =
    Number(parsed.cwd !== undefined) +
    Number(parsed.repo !== undefined) +
    Number(parsed.global === true) +
    Number(parsed.groupId !== undefined);
  if (explicitScopeCount > 1) {
    throw new CommandError("list runs accepts only one of --cwd, --repo, --global, or --group-id");
  }
  if (parsed.cwd !== undefined) {
    return {
      includeArchived: parsed.includeArchived,
      scope: {
        kind: "cwd",
        cwd: resolveInputPath(parsed.cwd, process.cwd()),
      },
    };
  }
  if (parsed.repo !== undefined) {
    return {
      includeArchived: parsed.includeArchived,
      scope: {
        kind: "repo",
        repo: parsed.repo,
      },
    };
  }
  if (parsed.global) {
    return {
      includeArchived: parsed.includeArchived,
      scope: { kind: "global" },
    };
  }
  if (parsed.groupId !== undefined) {
    return {
      includeArchived: parsed.includeArchived,
      scope: {
        kind: "group",
        runGroupId: validateRunGroupId(parsed.groupId),
      },
    };
  }
  return {
    includeArchived: parsed.includeArchived,
    scope: {
      kind: "cwd",
      cwd: resolveInputPath(".", process.cwd()),
    },
  };
}

async function startOrResumeDaemonRun(
  client: DaemonClient,
  parsed: ParsedArgs,
  overrides: RunCommandOverrides,
): Promise<{ runId: string }> {
  return parsed.resumeRun
    ? await client.call<{ runId: string }>("runs.resume", {
        target: normalizeTarget(parsed.resumeRun) ?? parsed.resumeRun,
        overrides,
      })
    : await client.call<{ runId: string }>("runs.start", {
        agent: normalizeTarget(parsed.agent),
        assignment: normalizeTarget(parsed.assignment),
        definitionCwd: process.cwd(),
        callerCwd: process.cwd(),
        parentRunId: resolveParentRunId(parsed),
        runGroupId: parsed.groupId,
        backendSessionId: parsed.backendSessionId,
        cliVars: parsed.vars,
        overrides,
      });
}

async function runTaskCommand(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  switch (parsed.subcommand) {
    case "list":
      return runTaskList(parsed, connect);
    case "show":
      return runTaskShow(parsed, connect);
    case "set":
      return runTaskSet(parsed, connect);
    case "append-notes":
      return runTaskAppendNotes(parsed, connect);
    case "add":
      return runTaskAdd(parsed, connect);
    default:
      process.stderr.write(
        `task-runner: task command requires a subcommand: list | show | set | append-notes | add (got "${parsed.subcommand ?? ""}")\n`,
      );
      process.exit(3);
  }
}

function validateAttachmentSourceFile(sourceArg: string): string {
  const sourcePath = resolveInputPath(sourceArg, process.cwd());
  if (!existsSync(sourcePath)) {
    throw new CommandError(`attachment add: source file ${sourcePath} was not found`);
  }
  if (!statSync(sourcePath).isFile()) {
    throw new CommandError(`attachment add: ${sourcePath} is not a file`);
  }
  return sourcePath;
}

async function resolveAttachmentTargetForDaemon(
  target: string,
  client: DaemonClient,
): Promise<string> {
  if (!isPathArg(target)) {
    return target;
  }
  return await client
    .call<{ run: ReturnType<typeof getRun> }>("runs.get", { target })
    .then((result) => result.run.runId);
}

async function runAttachmentCommand(
  parsed: ParsedArgs,
  connect?: DaemonConnectContext,
): Promise<never> {
  switch (parsed.subcommand) {
    case "list": {
      const [runArg, extra] = parsed.positionals;
      const target = normalizeTarget(runArg);
      if (!target) {
        process.stderr.write("task-runner: attachment list requires <run-id-or-path>\n");
        process.exit(3);
      }
      if (extra !== undefined) {
        process.stderr.write(
          `task-runner: attachment list takes exactly one positional (<run-id-or-path>); got extra "${extra}"\n`,
        );
        process.exit(3);
      }
      const unsupported = unsupportedFlagsForGroupedCommand(parsed, { allowAttachmentScope: true });
      if (unsupported.length > 0) {
        process.stderr.write(
          `task-runner: attachment list only supports <run-id-or-path>, --scope, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
        );
        process.exit(3);
      }

      try {
        const attachments =
          connect === undefined
            ? getAttachmentList(target, { scope: parsed.attachmentScope })
            : await withDaemonClient(connect, async (client) =>
                client.listAttachments(await resolveAttachmentTargetForDaemon(target, client), {
                  scope: parsed.attachmentScope,
                }),
              );
        if (parsed.outputFormat === "json") {
          writeJson(attachments);
        } else {
          process.stdout.write(
            renderAttachmentList(attachments, {
              showOwnerRunId: (parsed.attachmentScope ?? "group") !== "run",
            }),
          );
        }
        return process.exit(0);
      } catch (err) {
        return exitCommandFailure(err, connect?.connectUrl);
      }
    }
    case "add": {
      const [runArg, sourceArg, extra] = parsed.positionals;
      const target = normalizeTarget(runArg);
      if (!target || !sourceArg) {
        process.stderr.write(
          "task-runner: attachment add requires <run-id-or-path> <source-file>\n",
        );
        process.exit(3);
      }
      if (extra !== undefined) {
        process.stderr.write(
          `task-runner: attachment add takes exactly two positionals (<run-id-or-path> <source-file>); got extra "${extra}"\n`,
        );
        process.exit(3);
      }
      const unsupported = unsupportedFlagsForGroupedCommand(parsed, {
        allowAttachmentName: true,
        allowAttachmentMimeType: true,
      });
      if (unsupported.length > 0) {
        process.stderr.write(
          `task-runner: attachment add only supports <run-id-or-path>, <source-file>, --name, --mime-type, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
        );
        process.exit(3);
      }

      try {
        const sourcePath = validateAttachmentSourceFile(sourceArg);
        const name = parsed.attachmentName ?? basename(sourcePath);
        let daemonRunId = target;
        const attachment =
          connect === undefined
            ? await addRunAttachmentFromFile(target, {
                sourcePath,
                name: parsed.attachmentName,
                mimeType: parsed.attachmentMimeType,
              })
            : await withDaemonClient(connect, async (client) => {
                daemonRunId = await resolveAttachmentTargetForDaemon(target, client);
                return await client.addAttachment(daemonRunId, {
                  sourcePath,
                  name,
                  mimeType: parsed.attachmentMimeType,
                });
              });
        if (parsed.outputFormat === "json") {
          writeJson(attachment);
        } else {
          process.stdout.write(renderAttachmentAdded(daemonRunId, attachment));
        }
        return process.exit(0);
      } catch (err) {
        return exitCommandFailure(err, connect?.connectUrl);
      }
    }
    case "remove": {
      const [runArg, attachmentId, extra] = parsed.positionals;
      const target = normalizeTarget(runArg);
      if (!target || !attachmentId) {
        process.stderr.write(
          "task-runner: attachment remove requires <run-id-or-path> <attachment-id>\n",
        );
        process.exit(3);
      }
      if (extra !== undefined) {
        process.stderr.write(
          `task-runner: attachment remove takes exactly two positionals (<run-id-or-path> <attachment-id>); got extra "${extra}"\n`,
        );
        process.exit(3);
      }
      const unsupported = unsupportedFlagsForGroupedCommand(parsed);
      if (unsupported.length > 0) {
        process.stderr.write(
          `task-runner: attachment remove only supports <run-id-or-path>, <attachment-id>, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
        );
        process.exit(3);
      }

      try {
        const result =
          connect === undefined
            ? removeRunAttachment(target, attachmentId)
            : await withDaemonClient(connect, async (client) =>
                client.removeAttachment(
                  await resolveAttachmentTargetForDaemon(target, client),
                  attachmentId,
                ),
              );
        if (parsed.outputFormat === "json") {
          writeJson(result);
        } else {
          process.stdout.write(renderAttachmentRemoved(result));
        }
        return process.exit(0);
      } catch (err) {
        return exitCommandFailure(err, connect?.connectUrl);
      }
    }
    case "download": {
      const [runArg, attachmentId, outputPath, extra] = parsed.positionals;
      const target = normalizeTarget(runArg);
      if (!target || !attachmentId || !outputPath) {
        process.stderr.write(
          "task-runner: attachment download requires <run-id-or-path> <attachment-id> <output-path>\n",
        );
        process.exit(3);
      }
      if (extra !== undefined) {
        process.stderr.write(
          `task-runner: attachment download takes exactly three positionals (<run-id-or-path> <attachment-id> <output-path>); got extra "${extra}"\n`,
        );
        process.exit(3);
      }
      const unsupported = unsupportedFlagsForGroupedCommand(parsed);
      if (unsupported.length > 0) {
        process.stderr.write(
          `task-runner: attachment download only supports <run-id-or-path>, <attachment-id>, <output-path>, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
        );
        process.exit(3);
      }

      try {
        const result =
          connect === undefined
            ? downloadRunAttachment(target, attachmentId, outputPath)
            : await withDaemonClient(connect, async (client) =>
                client.downloadAttachment(
                  await resolveAttachmentTargetForDaemon(target, client),
                  attachmentId,
                  outputPath,
                ),
              );
        if (parsed.outputFormat === "json") {
          writeJson(result);
        } else {
          process.stdout.write(renderAttachmentDownloaded(result));
        }
        return process.exit(0);
      } catch (err) {
        return exitCommandFailure(err, connect?.connectUrl);
      }
    }
    default:
      process.stderr.write(
        `task-runner: attachment command requires a subcommand: add | list | remove | download (got "${parsed.subcommand ?? ""}")\n`,
      );
      process.exit(3);
  }
}

async function runResetCommand(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  const [runArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write("task-runner: run reset requires <id-or-path>\n");
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run reset takes exactly one positional (<id-or-path>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }
  const unsupported = unsupportedFlagsForGroupedCommand(parsed);
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run reset only supports <id-or-path>, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    const result =
      connect === undefined
        ? reset(target)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ run: ReturnType<typeof reset> }>("runs.reset", { target })
              .then((r) => r.run),
          );
    if (parsed.outputFormat === "json") {
      writeJson({ runId: result.runId, status: result.status });
    } else {
      process.stdout.write(`task-runner: reset run ${result.runId} to initialized state\n`);
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runReadyCommand(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  const [runArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write("task-runner: run ready requires <id-or-path>\n");
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run ready takes exactly one positional (<id-or-path>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }
  const unsupported = unsupportedFlagsForGroupedCommand(parsed, { allowScheduleInitFlags: true });
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run ready only supports <id-or-path>, --connect, --output-format, and --schedule-* flags (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }
  const schedule = buildScheduleInputFromInitFlags(parsed);

  try {
    const result =
      connect === undefined
        ? readyRun(target, { schedule })
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ run: ReturnType<typeof readyRun> }>("runs.ready", { target, schedule })
              .then((r) => r.run),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(renderRunReady(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runScheduleCommand(
  parsed: ParsedArgs,
  connect?: DaemonConnectContext,
): Promise<never> {
  const [actionOrRunArg, runArg, extra] = parsed.positionals;
  const action =
    actionOrRunArg === "enable" || actionOrRunArg === "disable" || actionOrRunArg === "clear"
      ? actionOrRunArg
      : "set";
  const target = normalizeTarget(action === "set" ? actionOrRunArg : runArg);
  if (!target) {
    process.stderr.write("task-runner: run schedule requires <id-or-path>\n");
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run schedule takes at most two positionals; got extra "${extra}"\n`,
    );
    process.exit(3);
  }
  const unsupported = unsupportedFlagsForGroupedCommand(parsed, { allowRunScheduleFlags: true });
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run schedule only supports <id-or-path>, enable|disable|clear, --connect, --output-format, and schedule flags (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }
  if (action !== "set" && hasRunScheduleFlags(parsed)) {
    process.stderr.write(`task-runner: run schedule ${action} does not accept schedule flags\n`);
    process.exit(3);
  }

  try {
    const result =
      action === "set"
        ? connect === undefined
          ? setRunSchedule(target, { schedule: buildScheduleInputFromRunScheduleFlags(parsed) })
          : await withDaemonClient(connect, (client) =>
              client
                .call<{ run: ReturnType<typeof setRunSchedule> }>("runs.setSchedule", {
                  target,
                  schedule: buildScheduleInputFromRunScheduleFlags(parsed),
                })
                .then((r) => r.run),
            )
        : action === "clear"
          ? connect === undefined
            ? clearRunSchedule(target)
            : await withDaemonClient(connect, (client) =>
                client
                  .call<{ run: ReturnType<typeof clearRunSchedule> }>("runs.clearSchedule", {
                    target,
                  })
                  .then((r) => r.run),
              )
          : connect === undefined
            ? setRunScheduleEnabled(target, { enabled: action === "enable" })
            : await withDaemonClient(connect, (client) =>
                client
                  .call<{ run: ReturnType<typeof setRunScheduleEnabled> }>(
                    action === "enable" ? "runs.enableSchedule" : "runs.disableSchedule",
                    { target },
                  )
                  .then((r) => r.run),
              );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else if (action === "set") {
      process.stdout.write(renderRunScheduleSet(result));
    } else if (action === "clear") {
      process.stdout.write(renderRunScheduleCleared(result));
    } else if (action === "enable") {
      process.stdout.write(renderRunScheduleEnabled(result));
    } else {
      process.stdout.write(renderRunScheduleDisabled(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runDeleteCommand(
  parsed: ParsedArgs,
  connect?: DaemonConnectContext,
): Promise<never> {
  const [runArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write("task-runner: run delete requires <id-or-path>\n");
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run delete takes exactly one positional (<id-or-path>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }
  const unsupported = unsupportedFlagsForGroupedCommand(parsed);
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run delete only supports <id-or-path>, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    const result =
      connect === undefined
        ? deleteArchivedRun(target)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ result: ReturnType<typeof deleteArchivedRun> }>("runs.delete", { target })
              .then((r) => r.result),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(renderRunDelete(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runArchiveToggleCommand(
  parsed: ParsedArgs,
  connect: DaemonConnectContext | undefined,
  verb: "archive" | "unarchive",
): Promise<never> {
  const [runArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write(`task-runner: run ${verb} requires <id-or-path>\n`);
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run ${verb} takes exactly one positional (<id-or-path>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }
  const unsupported = unsupportedFlagsForGroupedCommand(parsed);
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run ${verb} only supports <id-or-path>, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    const result =
      connect === undefined
        ? verb === "archive"
          ? archive(target)
          : unarchive(target)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ result: ReturnType<typeof archive> }>(
                verb === "archive" ? "runs.archive" : "runs.unarchive",
                { target },
              )
              .then((r) => r.result),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(
        verb === "archive" ? renderRunArchive(result) : renderRunUnarchive(result),
      );
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runSetNameCommand(
  parsed: ParsedArgs,
  connect?: DaemonConnectContext,
): Promise<never> {
  const [runArg, nameArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write("task-runner: run set-name requires <id-or-path>\n");
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run set-name takes exactly two positionals (<id-or-path> <name>) unless --clear is used; got extra "${extra}"\n`,
    );
    process.exit(3);
  }
  if (parsed.clear && nameArg !== undefined) {
    process.stderr.write("task-runner: run set-name does not accept both <name> and --clear\n");
    process.exit(3);
  }
  if (!parsed.clear && nameArg === undefined) {
    process.stderr.write("task-runner: run set-name requires <name> or --clear\n");
    process.exit(3);
  }
  let nextName: string | null;
  try {
    nextName = normalizeRunNameMutation({
      name: nameArg,
      clear: parsed.clear === true,
    });
  } catch {
    process.stderr.write("task-runner: run set-name: <name> cannot be empty\n");
    process.exit(3);
  }

  const unsupported = unsupportedFlagsForGroupedCommand(parsed, { allowClear: true });
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run set-name only supports <id-or-path>, <name> or --clear, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    const result =
      connect === undefined
        ? await renameRun(target, { name: nextName })
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ result: Awaited<ReturnType<typeof renameRun>> }>("runs.setName", {
                target,
                name: nextName,
              })
              .then((response) => response.result),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(renderRunSetName(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runNoteCommand(
  parsed: ParsedArgs,
  connect: DaemonConnectContext | undefined,
  verb: "set-note" | "clear-note",
): Promise<never> {
  const [runArg, noteArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write(
      `task-runner: run ${verb} requires <id-or-path>${verb === "set-note" ? " <text>" : ""}\n`,
    );
    process.exit(3);
  }

  if (verb === "set-note") {
    if (noteArg === undefined) {
      process.stderr.write("task-runner: run set-note requires <id-or-path> <text>\n");
      process.exit(3);
    }
    if (extra !== undefined) {
      process.stderr.write(
        `task-runner: run set-note takes exactly two positionals (<id-or-path> <text>); got extra "${extra}"\n`,
      );
      process.exit(3);
    }
  } else if (noteArg !== undefined) {
    process.stderr.write(
      `task-runner: run clear-note takes exactly one positional (<id-or-path>); got extra "${noteArg}"\n`,
    );
    process.exit(3);
  }

  const unsupported = unsupportedFlagsForGroupedCommand(parsed);
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run ${verb} only supports <id-or-path>${verb === "set-note" ? ", <text>" : ""}, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    const note = verb === "set-note" ? (noteArg ?? null) : null;
    const result =
      connect === undefined
        ? updateRunNote(target, { note })
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ result: ReturnType<typeof updateRunNote> }>("runs.setNote", {
                target,
                note,
              })
              .then((response) => response.result),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(renderRunSetNote(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runPinnedCommand(
  parsed: ParsedArgs,
  connect: DaemonConnectContext | undefined,
  verb: "pin" | "unpin",
): Promise<never> {
  const [runArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write(`task-runner: run ${verb} requires <id-or-path>\n`);
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run ${verb} takes exactly one positional (<id-or-path>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }

  const unsupported = unsupportedFlagsForGroupedCommand(parsed);
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run ${verb} only supports <id-or-path>, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    const pinned = verb === "pin";
    const result =
      connect === undefined
        ? updateRunPinned(target, { pinned })
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ result: ReturnType<typeof updateRunPinned> }>("runs.setPinned", {
                target,
                pinned,
              })
              .then((response) => response.result),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(renderRunSetPinned(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runBackendSessionCommand(
  parsed: ParsedArgs,
  connect: DaemonConnectContext | undefined,
  verb: "set-backend-session" | "clear-backend-session",
): Promise<never> {
  const [runArg, backendSessionArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write(
      `task-runner: run ${verb} requires <id-or-path>${verb === "set-backend-session" ? " <session-id>" : ""}\n`,
    );
    process.exit(3);
  }

  if (verb === "set-backend-session") {
    if (backendSessionArg === undefined) {
      process.stderr.write(
        "task-runner: run set-backend-session requires <id-or-path> <session-id>\n",
      );
      process.exit(3);
    }
    if (extra !== undefined) {
      process.stderr.write(
        `task-runner: run set-backend-session takes exactly two positionals (<id-or-path> <session-id>); got extra "${extra}"\n`,
      );
      process.exit(3);
    }
    if (backendSessionArg.trim().length === 0) {
      process.stderr.write("task-runner: run set-backend-session: <session-id> cannot be empty\n");
      process.exit(3);
    }
  } else if (backendSessionArg !== undefined) {
    process.stderr.write(
      `task-runner: run clear-backend-session takes exactly one positional (<id-or-path>); got extra "${backendSessionArg}"\n`,
    );
    process.exit(3);
  }

  const unsupported = unsupportedFlagsForGroupedCommand(parsed);
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run ${verb} only supports <id-or-path>${verb === "set-backend-session" ? ", <session-id>" : ""}, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    let result: Awaited<ReturnType<typeof updateRunBackendSession>>;
    if (verb === "set-backend-session") {
      const backendSessionId = backendSessionArg;
      if (backendSessionId === undefined) {
        throw new Error("task-runner: internal error: missing backend session id");
      }
      result =
        connect === undefined
          ? updateRunBackendSession(target, { backendSessionId })
          : await withDaemonClient(connect, (client) =>
              client
                .call<{ result: ReturnType<typeof updateRunBackendSession> }>(
                  "runs.setBackendSession",
                  {
                    target,
                    backendSessionId,
                  },
                )
                .then((response) => response.result),
            );
    } else {
      result =
        connect === undefined
          ? clearBackendSession(target)
          : await withDaemonClient(connect, (client) =>
              client
                .call<{ result: ReturnType<typeof clearBackendSession> }>(
                  "runs.clearBackendSession",
                  { target },
                )
                .then((response) => response.result),
            );
    }
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(
        verb === "set-backend-session"
          ? renderRunSetBackendSession(result)
          : renderRunClearBackendSession(result),
      );
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runGroupCommand(
  parsed: ParsedArgs,
  connect: DaemonConnectContext | undefined,
  verb: "set-group" | "clear-group",
): Promise<never> {
  const [runArg, groupArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target || (verb === "set-group" && !groupArg)) {
    process.stderr.write(
      `task-runner: run ${verb} requires <id-or-path>${verb === "set-group" ? " <group-id>" : ""}\n`,
    );
    process.exit(3);
  }
  if (verb === "clear-group" && groupArg !== undefined) {
    process.stderr.write(
      `task-runner: run clear-group takes exactly one positional (<id-or-path>); got extra "${groupArg}"\n`,
    );
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run set-group takes exactly two positionals (<id-or-path> <group-id>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }
  const unsupported = unsupportedFlagsForGroupedCommand(parsed);
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run ${verb} only supports ${verb === "set-group" ? "<id-or-path>, <group-id>" : "<id-or-path>"}, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }
  try {
    const result =
      connect === undefined
        ? verb === "set-group"
          ? setGroup(target, { runGroupId: groupArg as string })
          : clearGroup(target)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ result: ReturnType<typeof setGroup> | ReturnType<typeof clearGroup> }>(
                verb === "set-group" ? "runs.setGroup" : "runs.clearGroup",
                verb === "set-group" ? { target, runGroupId: groupArg } : { target },
              )
              .then((response) => response.result),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(
        verb === "set-group" ? renderRunSetGroup(result) : renderRunClearGroup(result),
      );
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runDependencyCommand(
  parsed: ParsedArgs,
  connect: DaemonConnectContext | undefined,
  verb: "add-dep" | "remove-dep" | "clear-deps",
): Promise<never> {
  const [runArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write(
      `task-runner: run ${verb} requires <id-or-path>${verb === "clear-deps" ? "" : " --run <dependency-run-id> or --group <group-id>"}\n`,
    );
    process.exit(3);
  }
  if (verb === "clear-deps") {
    if (extra !== undefined) {
      process.stderr.write(
        `task-runner: run clear-deps takes exactly one positional (<id-or-path>); got extra "${extra}"\n`,
      );
      process.exit(3);
    }
  } else if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run ${verb} takes exactly one positional (<id-or-path>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }

  const unsupported = unsupportedFlagsForGroupedCommand(parsed, {
    allowDependencyRef: verb !== "clear-deps",
  });
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run ${verb} only supports ${verb === "clear-deps" ? "<id-or-path>" : "<id-or-path>, --run or --group"}, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }
  const refCount =
    Number(parsed.dependencyRun !== undefined) + Number(parsed.dependencyGroupId !== undefined);
  if (verb !== "clear-deps" && refCount !== 1) {
    process.stderr.write(`task-runner: run ${verb} requires exactly one of --run or --group\n`);
    process.exit(3);
  }
  if (verb === "clear-deps" && refCount !== 0) {
    process.stderr.write("task-runner: run clear-deps does not accept --run or --group\n");
    process.exit(3);
  }
  const dependency: RunDependencyRef | undefined =
    parsed.dependencyRun !== undefined
      ? { type: "run", runId: parsed.dependencyRun }
      : parsed.dependencyGroupId !== undefined
        ? { type: "group", groupId: parsed.dependencyGroupId }
        : undefined;

  try {
    const method =
      verb === "add-dep"
        ? "runs.addDependency"
        : verb === "remove-dep"
          ? "runs.removeDependency"
          : "runs.clearDependencies";
    const params =
      verb === "clear-deps" ? { target } : { target, dependency: dependency as RunDependencyRef };
    const result =
      connect === undefined
        ? method === "runs.addDependency"
          ? addDependency(target, dependency as RunDependencyRef)
          : method === "runs.removeDependency"
            ? removeDependency(target, dependency as RunDependencyRef)
            : clearDependencies(target)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{
                result:
                  | ReturnType<typeof addDependency>
                  | ReturnType<typeof removeDependency>
                  | ReturnType<typeof clearDependencies>;
              }>(method, params)
              .then((response) => response.result),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else if (verb === "add-dep") {
      process.stdout.write(renderRunAddDependency(result, dependency as RunDependencyRef));
    } else if (verb === "remove-dep") {
      process.stdout.write(renderRunRemoveDependency(result, dependency as RunDependencyRef));
    } else {
      process.stdout.write(renderRunClearDependencies(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runTaskList(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  const [runArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write("task-runner: task list requires <run-id>\n");
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: task list takes exactly one positional (<run-id>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }

  try {
    const tasks =
      connect === undefined
        ? getTaskList(target)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ tasks: ReturnType<typeof getTaskList> }>("tasks.list", { target })
              .then((r) => r.tasks),
          );
    if (parsed.outputFormat === "json") {
      writeJson(tasks);
    } else {
      process.stdout.write(renderTaskList({ manifest: {} as never, tasks }));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runTaskShow(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  const [runArg, taskId, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target || !taskId) {
    process.stderr.write("task-runner: task show requires <run-id> <task-id>\n");
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: task show takes exactly two positionals (<run-id> <task-id>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }

  try {
    const task =
      connect === undefined
        ? getTask(target, taskId)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ task: ReturnType<typeof getTask> }>("tasks.get", { target, taskId })
              .then((r) => r.task),
          );
    if (parsed.outputFormat === "json") {
      writeJson(task);
    } else {
      process.stdout.write(renderTaskDetails({ manifest: {} as never, task }));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runTaskSet(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  const [runArg, taskId] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target || !taskId) {
    process.stderr.write("task-runner: task set requires <run-id> <task-id>\n");
    process.exit(3);
  }

  try {
    const task =
      connect === undefined
        ? await updateTask(target, taskId, {
            status: parsed.taskStatus,
            notes: parsed.taskNotes,
          })
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ task: ReturnType<typeof updateTask> }>("tasks.set", {
                target,
                taskId,
                status: parsed.taskStatus,
                notes: parsed.taskNotes,
              })
              .then((r) => r.task),
          );
    if (parsed.outputFormat === "json") {
      writeJson(task);
    } else {
      process.stdout.write(
        `task-runner: updated ${task.id} (status=${task.status}) in run ${target}\n`,
      );
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runTaskAppendNotes(
  parsed: ParsedArgs,
  connect?: DaemonConnectContext,
): Promise<never> {
  const [runArg, taskId] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target || !taskId) {
    process.stderr.write("task-runner: task append-notes requires <run-id> <task-id>\n");
    process.exit(3);
  }
  if (parsed.taskAppendText === undefined) {
    process.stderr.write("task-runner: task append-notes requires --text\n");
    process.exit(3);
  }

  try {
    const task =
      connect === undefined
        ? await appendNotes(target, taskId, parsed.taskAppendText)
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ task: ReturnType<typeof appendNotes> }>("tasks.appendNotes", {
                target,
                taskId,
                text: parsed.taskAppendText,
              })
              .then((r) => r.task),
          );
    if (parsed.outputFormat === "json") {
      writeJson(task);
    } else {
      process.stdout.write(
        `task-runner: updated ${task.id} (status=${task.status}) in run ${target}\n`,
      );
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runTaskAdd(parsed: ParsedArgs, connect?: DaemonConnectContext): Promise<never> {
  const [runArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write("task-runner: task add requires <run-id>\n");
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: task add takes exactly one positional (<run-id>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }
  if (parsed.taskTitle === undefined) {
    process.stderr.write("task-runner: task add requires --title\n");
    process.exit(3);
  }

  try {
    const task =
      connect === undefined
        ? await createTask(target, { title: parsed.taskTitle, body: parsed.taskBody })
        : await withDaemonClient(connect, (client) =>
            client
              .call<{ task: ReturnType<typeof createTask> }>("tasks.add", {
                target,
                title: parsed.taskTitle,
                body: parsed.taskBody,
              })
              .then((r) => r.task),
          );
    if (parsed.outputFormat === "json") {
      writeJson(task);
    } else {
      process.stdout.write(`task-runner: added task ${task.id} "${task.title}" to run ${target}\n`);
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connect?.connectUrl);
  }
}

async function runExecuteCommandEmbedded(parsed: ParsedArgs): Promise<never> {
  const isInitCommand = parsed.command === "init";
  const isJson = parsed.outputFormat === "json";
  const abortController = new AbortController();
  let sigintCount = 0;
  const onSigint = (): void => {
    sigintCount++;
    if (sigintCount === 1) {
      process.stderr.write(
        "\ntask-runner: caught Ctrl+C — interrupting backend (Ctrl+C again to force-exit)\n",
      );
      abortController.abort();
      return;
    }
    process.stderr.write("\ntask-runner: forced exit\n");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    if (!isInitCommand && parsed.runId !== undefined) {
      throw new RunCommandError("--run-id is only valid with init");
    }
    if (parsed.resumeRun !== undefined && parsed.parentRun !== undefined) {
      throw new RunCommandError("--parent-run cannot be combined with --resume-run");
    }
    if (parsed.resumeRun !== undefined && parsed.groupId !== undefined) {
      throw new RunCommandError("--group-id cannot be combined with --resume-run");
    }
    if (isInitCommand && parsed.resumeRun !== undefined) {
      throw new RunCommandError("init cannot be combined with --resume-run");
    }
    if (!isInitCommand && hasScheduleInitFlags(parsed)) {
      throw new RunCommandError("--schedule-* flags are only valid with init and run ready");
    }
    if (hasRunScheduleFlags(parsed)) {
      throw new RunCommandError("--at, --delay, and --cron are only valid with run schedule");
    }
    resolveMessageFile(parsed);
    if (isInitCommand) {
      const run = await initRun({
        runId: normalizeTarget(parsed.runId) ?? parsed.runId,
        agent: normalizeTarget(parsed.agent),
        assignment: normalizeTarget(parsed.assignment),
        definitionCwd: process.cwd(),
        parentRunId: resolveParentRunId(parsed),
        runGroupId: parsed.groupId,
        backendSessionId: parsed.backendSessionId,
        cliVars: parsed.vars,
        webVars: {},
        overrides: resolvedOverrides(parsed),
        abortSignal: abortController.signal,
        emitEvent: isJson ? undefined : emitRenderedEvent,
      });
      if (isJson) {
        writeJson(run);
      }
      process.exit(0);
    }

    const outcome = parsed.resumeRun
      ? await resumeRun({
          target: normalizeTarget(parsed.resumeRun) ?? parsed.resumeRun,
          overrides: resolvedOverrides(parsed),
          abortSignal: abortController.signal,
          emitEvent: isJson ? undefined : emitRenderedEvent,
        })
      : await startRun({
          agent: normalizeTarget(parsed.agent),
          assignment: normalizeTarget(parsed.assignment),
          definitionCwd: process.cwd(),
          parentRunId: resolveParentRunId(parsed),
          runGroupId: parsed.groupId,
          backendSessionId: parsed.backendSessionId,
          cliVars: parsed.vars,
          webVars: {},
          overrides: resolvedOverrides(parsed),
          abortSignal: abortController.signal,
          emitEvent: isJson ? undefined : emitRenderedEvent,
        });
    if (isJson) {
      writeJson(getRun(outcome.runId));
    }
    process.exit(outcome.exitCode);
  } catch (err) {
    if (
      err instanceof UnknownBackendError ||
      err instanceof AgentNotFoundError ||
      err instanceof AgentConfigError ||
      err instanceof AssignmentNotFoundError ||
      err instanceof AssignmentConfigError ||
      err instanceof RunCommandError ||
      isCommandError(err) ||
      err instanceof VarResolutionError ||
      err instanceof LockedFieldError ||
      err instanceof ResumeError ||
      err instanceof InvalidAddedTaskError ||
      err instanceof InvalidRunNameError ||
      err instanceof EmptyPromptError ||
      err instanceof RecursionDepthError ||
      err instanceof InvalidBackendSessionError ||
      err instanceof ScheduleValidationError
    ) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      if (err instanceof RunCommandError && err.showHelp) {
        process.stderr.write(HELP);
      }
      process.exit(3);
    }
    process.stderr.write(`task-runner: ${(err as Error).message}\n`);
    process.exit(4);
  }
}

async function runExecuteCommandDaemon(
  parsed: ParsedArgs,
  connect: DaemonConnectContext,
): Promise<never> {
  const isInitCommand = parsed.command === "init";
  const isJson = parsed.outputFormat === "json";

  await withDaemonClient(connect, async (client) => {
    if (!isInitCommand && parsed.runId !== undefined) {
      throw new RunCommandError("--run-id is only valid with init");
    }
    if (parsed.resumeRun !== undefined && parsed.parentRun !== undefined) {
      throw new RunCommandError("--parent-run cannot be combined with --resume-run");
    }
    if (isInitCommand && parsed.resumeRun !== undefined) {
      throw new RunCommandError("init cannot be combined with --resume-run");
    }
    if (!isInitCommand && hasScheduleInitFlags(parsed)) {
      throw new RunCommandError("--schedule-* flags are only valid with init and run ready");
    }
    if (hasRunScheduleFlags(parsed)) {
      throw new RunCommandError("--at, --delay, and --cron are only valid with run schedule");
    }
    resolveMessageFile(parsed);
    const daemonOverrides = resolvedDaemonOverrides(parsed);
    if (isInitCommand) {
      const result = await client.call<{ run: ReturnType<typeof getRun> }>("runs.init", {
        runId: normalizeTarget(parsed.runId) ?? parsed.runId,
        agent: normalizeTarget(parsed.agent),
        assignment: normalizeTarget(parsed.assignment),
        definitionCwd: process.cwd(),
        callerCwd: process.cwd(),
        parentRunId: resolveParentRunId(parsed),
        runGroupId: parsed.groupId,
        backendSessionId: parsed.backendSessionId,
        cliVars: parsed.vars,
        overrides: daemonOverrides,
      });
      if (isJson) {
        writeJson(result.run);
      } else {
        renderInitializedRun(result.run);
      }
      process.exit(0);
    }

    if (parsed.detach) {
      const startResult = await startOrResumeDaemonRun(client, parsed, daemonOverrides);
      renderDetachedRun(startResult.runId, parsed.outputFormat);
      process.exit(0);
    }

    let activeRunId: string | undefined;
    let terminalStatus: string | undefined;
    let abortRequested = false;
    let sigintCount = 0;
    let cancelRequested = false;
    let cancelFailed: string | undefined;
    let cancelPromise: Promise<void> | undefined;
    const exitWithCancelFailure = (): never => {
      process.stderr.write(
        `task-runner: Ctrl+C cancel request failed: ${cancelFailed}. Remote run may still be active.\n`,
      );
      process.exit(1);
    };
    const requestCancel = (): void => {
      if (!activeRunId || cancelRequested) {
        return;
      }
      cancelRequested = true;
      cancelPromise = client
        .call<{ runId: string; accepted: true }>("runs.abort", { target: activeRunId })
        .then((result) => {
          if (result.accepted !== true) {
            cancelFailed = `daemon did not accept cancel for run ${activeRunId}`;
          }
        })
        .catch((err) => {
          cancelFailed = errorMessage(err);
        });
    };
    const onSigint = (): void => {
      sigintCount++;
      if (sigintCount === 1) {
        process.stderr.write(
          "\ntask-runner: caught Ctrl+C — requesting daemon cancel (Ctrl+C again to force-exit)\n",
        );
      } else {
        process.stderr.write("\ntask-runner: forced exit\n");
        process.exit(130);
      }
      abortRequested = true;
      if (activeRunId) {
        requestCancel();
      }
    };
    process.on("SIGINT", onSigint);

    let subscriptionId: string | undefined;
    try {
      const startResult = await startOrResumeDaemonRun(client, parsed, daemonOverrides);
      activeRunId = startResult.runId;
      subscriptionId = await client.subscribe(
        {
          channel: "run_timeline",
          runId: activeRunId,
        },
        (notification) => {
          if (notification.method !== "run.timeline") {
            return;
          }
          if (!isJson) {
            emitRenderedEvent(notification.event);
          }
          if (notification.event.type === "run_finished") {
            terminalStatus = notification.event.summary.status;
          }
        },
      );
      if (abortRequested) {
        requestCancel();
      }
      if (cancelPromise) {
        await cancelPromise;
      }
      if (cancelFailed) {
        exitWithCancelFailure();
      }
      while (!terminalStatus && !cancelFailed) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (cancelPromise) {
        await cancelPromise;
      }
      if (cancelFailed) {
        exitWithCancelFailure();
      }
      const finalRun = await client.call<{ run: ReturnType<typeof getRun> }>("runs.get", {
        target: activeRunId,
      });
      if (isJson) {
        writeJson(finalRun.run);
      }
      if (cancelRequested && terminalStatus !== "aborted") {
        process.stderr.write(
          `task-runner: Ctrl+C requested daemon cancel, but interruption was not confirmed (final status: ${terminalStatus}). Remote run may still be active.\n`,
        );
        process.exit(1);
      }
      if (!terminalStatus) {
        process.stderr.write("task-runner: daemon run ended without a terminal status\n");
        process.exit(4);
      }
      process.exit(terminalExitCode(terminalStatus));
    } finally {
      process.off("SIGINT", onSigint);
      if (subscriptionId) {
        await client.unsubscribe(subscriptionId);
      }
    }
  });

  process.exit(4);
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`task-runner: ${(err as Error).message}\n`);
    process.stderr.write(HELP);
    process.exit(3);
  }

  if (parsed.showHelp) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (parsed.detach) {
    if (parsed.command === "init") {
      process.stderr.write("task-runner: init does not accept --detach\n");
      process.exit(3);
    }
    if (parsed.command !== "run") {
      process.stderr.write("task-runner: --detach is only valid with `run` in daemon mode\n");
      process.exit(3);
    }
  }

  if (parsed.command === "serve") {
    await runServe(parsed);
  }

  if (parsed.listen !== undefined) {
    process.stderr.write("task-runner: --listen is only valid with `serve`\n");
    process.exit(3);
  }

  if (parsed.includeArchived && !(parsed.command === "list" && parsed.subcommand === "runs")) {
    process.stderr.write("task-runner: --include-archived is only valid with `list runs`\n");
    process.exit(3);
  }

  let daemonConnect: DaemonConnectContext | undefined;
  try {
    const resolvedHostMode = resolveHostMode(
      parsed.connect,
      parsed.connectHost,
      parsed.connectLocalPort,
    );
    if (resolvedHostMode.mode === "daemon") {
      daemonConnect = resolvedHostMode;
    }
  } catch (err) {
    process.stderr.write(`task-runner: ${errorMessage(err)}\n`);
    process.exit(3);
  }

  if (
    parsed.detach &&
    parsed.command === "run" &&
    parsed.subcommand === undefined &&
    !daemonConnect
  ) {
    process.stderr.write(
      "task-runner: --detach requires daemon-connected run execution (--connect or TASK_RUNNER_CONNECT)\n",
    );
    process.exit(3);
  }

  if (daemonConnect?.connectHost) {
    try {
      await openSshTunnel(daemonConnect.connectHost);
    } catch (err) {
      exitCommandFailure(err, daemonConnect.connectUrl);
    }
  }

  if (parsed.command === "status") {
    await runSystemStatus(parsed, daemonConnect);
  }

  if (parsed.command === "run") {
    if (parsed.subcommand === "status") {
      await runRunStatus(parsed, daemonConnect);
    }
    if (parsed.subcommand === "audit") {
      await runRunAudit(parsed, daemonConnect);
    }
    if (parsed.subcommand === "brief") {
      await runRunBrief(parsed, daemonConnect);
    }
    if (parsed.subcommand === "reconfigure") {
      await runReconfigureCommand(parsed, daemonConnect);
    }
    if (parsed.subcommand === "reset") {
      await runResetCommand(parsed, daemonConnect);
    }
    if (parsed.subcommand === "ready") {
      await runReadyCommand(parsed, daemonConnect);
    }
    if (parsed.subcommand === "schedule") {
      await runScheduleCommand(parsed, daemonConnect);
    }
    if (parsed.subcommand === "archive") {
      await runArchiveToggleCommand(parsed, daemonConnect, "archive");
    }
    if (parsed.subcommand === "unarchive") {
      await runArchiveToggleCommand(parsed, daemonConnect, "unarchive");
    }
    if (parsed.subcommand === "delete") {
      await runDeleteCommand(parsed, daemonConnect);
    }
    if (parsed.subcommand === "set-name") {
      await runSetNameCommand(parsed, daemonConnect);
    }
    if (parsed.subcommand === "set-note") {
      await runNoteCommand(parsed, daemonConnect, "set-note");
    }
    if (parsed.subcommand === "clear-note") {
      await runNoteCommand(parsed, daemonConnect, "clear-note");
    }
    if (parsed.subcommand === "pin") {
      await runPinnedCommand(parsed, daemonConnect, "pin");
    }
    if (parsed.subcommand === "unpin") {
      await runPinnedCommand(parsed, daemonConnect, "unpin");
    }
    if (parsed.subcommand === "set-backend-session") {
      await runBackendSessionCommand(parsed, daemonConnect, "set-backend-session");
    }
    if (parsed.subcommand === "clear-backend-session") {
      await runBackendSessionCommand(parsed, daemonConnect, "clear-backend-session");
    }
    if (parsed.subcommand === "set-group") {
      await runGroupCommand(parsed, daemonConnect, "set-group");
    }
    if (parsed.subcommand === "clear-group") {
      await runGroupCommand(parsed, daemonConnect, "clear-group");
    }
    if (parsed.subcommand === "add-dep") {
      await runDependencyCommand(parsed, daemonConnect, "add-dep");
    }
    if (parsed.subcommand === "remove-dep") {
      await runDependencyCommand(parsed, daemonConnect, "remove-dep");
    }
    if (parsed.subcommand === "clear-deps") {
      await runDependencyCommand(parsed, daemonConnect, "clear-deps");
    }
  }

  if (parsed.command === "task") {
    await runTaskCommand(parsed, daemonConnect);
  }

  if (parsed.command === "attachment") {
    await runAttachmentCommand(parsed, daemonConnect);
  }

  if (parsed.command === "list") {
    await runListCommand(parsed, daemonConnect);
  }

  if (parsed.command === "show") {
    await runShowCommand(parsed, daemonConnect);
  }

  if (parsed.command !== "run" && parsed.command !== "init") {
    process.stderr.write(`task-runner: unknown command "${parsed.command}"\n`);
    process.stderr.write(HELP);
    process.exit(3);
  }

  if (daemonConnect) {
    try {
      await runExecuteCommandDaemon(parsed, daemonConnect);
    } catch (err) {
      exitCommandFailure(err, daemonConnect.connectUrl);
    }
  } else {
    await runExecuteCommandEmbedded(parsed);
  }
}

main().catch((err) => {
  process.stderr.write(`task-runner: ${errorMessage(err)}\n`);
  process.exit(4);
});
