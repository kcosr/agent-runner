#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  type RunCommandOverrides,
  addDependency,
  addRunAttachmentFromFile,
  appendNotes,
  archive,
  clearBackendSession,
  clearDependencies,
  createTask,
  deleteArchivedRun,
  downloadRunAttachment,
  getAttachmentList,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunBrief,
  getRunList,
  getTask,
  getTaskList,
  initRun,
  removeDependency,
  removeRunAttachment,
  renameRun,
  reset,
  resumeRun,
  startRun,
  unarchive,
  updateRunBackendSession,
  updateTask,
} from "@task-runner/core/app/service.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  DefinitionListError,
} from "@task-runner/core/config/loader.js";
import {
  isPathArg,
  resolveInputPath,
  resolveTaskRunnerConfigDir,
  resolveTaskRunnerStateDir,
} from "@task-runner/core/config/runtime-paths.js";
import type { BackendSpecificConfig } from "@task-runner/core/core/backends/types.js";
import {
  CommandError,
  type RunListFilter,
  isCommandError,
} from "@task-runner/core/core/commands/service.js";
import { AttachmentError } from "@task-runner/core/core/run/attachments.js";
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
  renderRunClearBackendSession,
  renderRunClearDependencies,
  renderRunDelete,
  renderRunList,
  renderRunRemoveDependency,
  renderRunSetBackendSession,
  renderRunSetName,
  renderRunStatus,
  renderRunUnarchive,
  renderSystemStatus,
  renderTaskDetails,
  renderTaskList,
} from "./commands/render.js";
import { DaemonClient, DaemonConnectionError, DaemonRpcError } from "./daemon/client.js";
import { resolveHostMode, resolveListenUrl } from "./daemon/config.js";
import {
  daemonAddAttachment,
  daemonDownloadAttachment,
  daemonListAttachments,
  daemonRemoveAttachment,
} from "./daemon/http-client.js";
import { type DaemonInfo, RPC_ERROR_COMMAND } from "./daemon/protocol.js";
import { serveDaemon } from "./daemon/server.js";

const HELP = `Usage: task-runner <run|init|serve|status|task|attachment|list|show> [options] [args]

Commands:
  run                     Execute an agent. Either a fresh run, a resume,
                          or execute-after-init (when --resume-run points
                          at an initialized run).
  run status <id>         Read a run and print its current status.
  run brief <id>          Print the canonical worker handoff for a run.
  run reset <id|path>     Restore a non-running run to initialized state.
  run archive <id|path>   Mark a non-running run as archived.
  run unarchive <id|path> Clear a run's archive marker.
  run delete <id|path>    Delete an archived run workspace.
  run set-name <id|path>  Update or clear a run's persisted display name.
  run set-backend-session <id|path> <session-id>
                          Persist a passive run backend session reference.
  run clear-backend-session <id|path>
                          Clear a passive run backend session reference.
  run add-dep <id> <dep>  Add a dependency to an initialized run.
  run remove-dep <id> <dep>
                          Remove a dependency from an initialized run.
  run clear-deps <id>     Remove all dependencies from an initialized run.
  init                    Prepare a run without invoking the backend.
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
  list <agents|assignments|runs>
                          Enumerate definitions or runs.
  show <agent|assignment> <name|path>
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
  --cwd-scope             (attachment list) Include same-cwd peer-run attachments.

Host selection:
  --connect <ws-url>      Route the command through the daemon host.
                          Also honored from TASK_RUNNER_CONNECT.
  --listen <ws-url>       (serve only) Listen URL for the daemon host.
                          Also honored from TASK_RUNNER_LISTEN. The same
                          listener serves HTTP/SSE under /api/.

Execution options:
  --agent <name|path>     Agent bare name or direct path to agent.md.
  --assignment <n|path>   Assignment bare name or direct path to assignment.md.
  --backend-session-id    Adopt an existing backend session id.
  --resume-run <id|path>  Continue an existing run by short id or path.
  --var <key>=<value>     Set an input variable (repeatable).
  --add-task <title>      Append a task to the run's task list.
  --cwd <path>            Override the run cwd, or scope list runs to a cwd.
  --backend <id>          Override the agent's backend.
  --model <id>            Override the agent's model.
  --effort <level>        Override effort level.
  --timeout-sec <n>       Override the per-attempt timeout.
  --max-retries <n>       Override the max number of retries.
  --unrestricted          Bypass the backend's approval prompts.
  --name <name>           Set the persisted run display name.
  --clear                 (run set-name) Clear the persisted run name.
  --detach                (run only, daemon mode only) Dispatch and exit
                          after the daemon accepts the run.
  --repo <name>           (list runs only) Scope runs to an exact repo.
  --global                (list runs only) Disable default cwd scoping.
  --output-format <fmt>   Output format: "text" (default) or "json".
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

function exitCommandFailure(err: unknown, connectUrl?: string): never {
  if (err instanceof DaemonConnectionError) {
    process.stderr.write(daemonUnavailableHint(err.url));
    process.exit(3);
  }

  if (err instanceof DaemonRpcError && err.code === RPC_ERROR_COMMAND) {
    process.stderr.write(`task-runner: ${err.message}\n`);
    process.exit(3);
  }

  if (
    isCommandError(err) ||
    err instanceof AttachmentError ||
    err instanceof AgentNotFoundError ||
    err instanceof AgentConfigError ||
    err instanceof AssignmentNotFoundError ||
    err instanceof AssignmentConfigError ||
    err instanceof DefinitionListError
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

function resolvedOverrides(parsed: ParsedArgs) {
  return {
    ...overridesFromParsedArgs(parsed),
    cwd: parsed.cwd ? resolveInputPath(parsed.cwd, process.cwd()) : undefined,
  };
}

function synthesizeClientBackendSpecificOverride(): BackendSpecificConfig | undefined {
  const codexWsUrl = process.env.TASK_RUNNER_CODEX_WS_URL;
  if (!codexWsUrl) {
    return undefined;
  }
  return {
    codex: {
      transport: {
        type: "ws",
        url: codexWsUrl,
      },
    },
  };
}

function resolvedDaemonOverrides(parsed: ParsedArgs): RunCommandOverrides {
  return {
    ...resolvedOverrides(parsed),
    backendSpecific: synthesizeClientBackendSpecificOverride(),
  };
}

function renderInitializedRun(detail: ReturnType<typeof getRun>): void {
  emitRenderedEvent({
    type: "run_initialized",
    runId: detail.runId,
    agentName: detail.agent.name,
    assignmentSourcePath: detail.assignment?.sourcePath ?? null,
    assignmentPath: detail.assignmentPath,
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
  connectUrl: string,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await DaemonClient.connect(connectUrl);
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

async function runSystemStatus(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? {
            configDir: resolveTaskRunnerConfigDir(),
            stateDir: resolveTaskRunnerStateDir(),
            hostMode: "embedded" as const,
            connectUrl: null,
            daemon: null,
          }
        : await withDaemonClient(connectUrl, (client) =>
            client.call<DaemonInfo>("daemon.info").then((daemon) => ({
              configDir: resolveTaskRunnerConfigDir(),
              stateDir: resolveTaskRunnerStateDir(),
              hostMode: "daemon" as const,
              connectUrl,
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runRunStatus(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? getRun(target)
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runRunBrief(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? getRunBrief(target)
        : await withDaemonClient(connectUrl, (client) =>
            client.call<{ brief: string }>("runs.brief", { target }).then((r) => r.brief),
          );
    process.stdout.write(`${brief}\n`);
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connectUrl);
  }
}

async function runListCommand(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
  const kindArg = parsed.subcommand;
  if (kindArg !== "agents" && kindArg !== "assignments" && kindArg !== "runs") {
    process.stderr.write(
      `task-runner: list requires a kind: agents, assignments, or runs${kindArg ? ` (got "${kindArg}")` : ""}\n`,
    );
    process.stderr.write(
      "Usage: task-runner list <agents|assignments|runs> [--cwd <path> | --repo <name> | --global] [--include-archived] [--output-format json]\n",
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
          `task-runner: list runs only supports --cwd, --repo, --global, --connect, --include-archived, and --output-format (got ${unsupported.join(", ")})\n`,
        );
        process.exit(3);
      }
      const filter = resolveRunListFilter(parsed);
      const result =
        connectUrl === undefined
          ? getRunList(filter)
          : await withDaemonClient(connectUrl, (client) =>
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
    const result =
      connectUrl === undefined
        ? getDefinitionList(kindArg === "agents" ? "agent" : "assignment")
        : await withDaemonClient(connectUrl, (client) =>
            client
              .call<{
                agents?: ReturnType<typeof getDefinitionList>;
                assignments?: ReturnType<typeof getDefinitionList>;
              }>(kindArg === "agents" ? "agents.list" : "assignments.list")
              .then((r) => (kindArg === "agents" ? (r.agents ?? []) : (r.assignments ?? []))),
          );
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(
        renderDefinitionList({
          kind: kindArg === "agents" ? "agent" : "assignment",
          entries: result,
        }),
      );
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connectUrl);
  }
}

async function runShowCommand(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
  const kindArg = parsed.subcommand;
  if (kindArg !== "agent" && kindArg !== "assignment") {
    process.stderr.write(
      `task-runner: show requires a kind: agent or assignment${kindArg ? ` (got "${kindArg}")` : ""}\n`,
    );
    process.stderr.write(
      "Usage: task-runner show <agent|assignment> <name|path> [--connect <ws-url>] [--output-format json]\n",
    );
    process.exit(3);
  }

  const target = normalizeTarget(parsed.positionals[0]);
  if (!target) {
    process.stderr.write(`task-runner: show ${kindArg} requires a name or path\n`);
    process.stderr.write(
      "Usage: task-runner show <agent|assignment> <name|path> [--connect <ws-url>] [--output-format json]\n",
    );
    process.exit(3);
  }

  try {
    const result =
      connectUrl === undefined
        ? getDefinition(kindArg, target, process.cwd())
        : await withDaemonClient(connectUrl, (client) =>
            client
              .call<{
                agent?: ReturnType<typeof getDefinition>;
                assignment?: ReturnType<typeof getDefinition>;
              }>(kindArg === "agent" ? "agents.get" : "assignments.get", {
                target,
                cwd: process.cwd(),
              })
              .then((r) => (kindArg === "agent" ? r.agent : r.assignment))
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
      process.stdout.write(
        renderDefinitionDetails({
          kind: kindArg,
          loaded: {
            config: result.config,
            instructions: result.instructions,
            sourcePath: result.sourcePath,
          },
        } as never),
      );
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connectUrl);
  }
}

function unsupportedFlagsForGroupedCommand(
  parsed: ParsedArgs,
  opts: {
    allowFields?: boolean;
    allowIncludeArchived?: boolean;
    allowRunListScope?: boolean;
    allowClear?: boolean;
    allowAttachmentName?: boolean;
    allowAttachmentMimeType?: boolean;
    allowCwdScope?: boolean;
  } = {},
): string[] {
  const unsupported: string[] = [];
  if (parsed.agent !== undefined) unsupported.push("--agent");
  if (parsed.assignment !== undefined) unsupported.push("--assignment");
  if (parsed.resumeRun !== undefined) unsupported.push("--resume-run");
  if (parsed.backendSessionId !== undefined) unsupported.push("--backend-session-id");
  if (Object.keys(parsed.vars).length > 0) unsupported.push("--var");
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
  if (!opts.allowCwdScope && parsed.cwdScope) unsupported.push("--cwd-scope");
  if (parsed.addedTasks.length > 0) unsupported.push("--add-task");
  if (parsed.detach) unsupported.push("--detach");
  if (parsed.listen !== undefined) unsupported.push("--listen");
  if (!opts.allowIncludeArchived && parsed.includeArchived) unsupported.push("--include-archived");
  return unsupported;
}

function resolveRunListFilter(parsed: ParsedArgs): RunListFilter {
  const explicitScopeCount =
    Number(parsed.cwd !== undefined) +
    Number(parsed.repo !== undefined) +
    Number(parsed.global === true);
  if (explicitScopeCount > 1) {
    throw new CommandError("list runs accepts only one of --cwd, --repo, or --global");
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
): Promise<{ runId: string }> {
  return parsed.resumeRun
    ? await client.call<{ runId: string }>("runs.resume", {
        target: normalizeTarget(parsed.resumeRun) ?? parsed.resumeRun,
        overrides: resolvedDaemonOverrides(parsed),
      })
    : await client.call<{ runId: string }>("runs.start", {
        agent: normalizeTarget(parsed.agent),
        assignment: normalizeTarget(parsed.assignment),
        definitionCwd: process.cwd(),
        callerCwd: process.cwd(),
        backendSessionId: parsed.backendSessionId,
        cliVars: parsed.vars,
        overrides: resolvedDaemonOverrides(parsed),
      });
}

async function runTaskCommand(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
  switch (parsed.subcommand) {
    case "list":
      return runTaskList(parsed, connectUrl);
    case "show":
      return runTaskShow(parsed, connectUrl);
    case "set":
      return runTaskSet(parsed, connectUrl);
    case "append-notes":
      return runTaskAppendNotes(parsed, connectUrl);
    case "add":
      return runTaskAdd(parsed, connectUrl);
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
  connectUrl: string,
): Promise<string> {
  if (!isPathArg(target)) {
    return target;
  }
  return await withDaemonClient(connectUrl, (client) =>
    client
      .call<{ run: ReturnType<typeof getRun> }>("runs.get", { target })
      .then((result) => result.run.runId),
  );
}

async function runAttachmentCommand(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      const unsupported = unsupportedFlagsForGroupedCommand(parsed, { allowCwdScope: true });
      if (unsupported.length > 0) {
        process.stderr.write(
          `task-runner: attachment list only supports <run-id-or-path>, --cwd-scope, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
        );
        process.exit(3);
      }

      try {
        const attachments =
          connectUrl === undefined
            ? getAttachmentList(target, { cwdScope: parsed.cwdScope })
            : await daemonListAttachments(
                connectUrl,
                await resolveAttachmentTargetForDaemon(target, connectUrl),
                { cwdScope: parsed.cwdScope },
              );
        if (parsed.outputFormat === "json") {
          writeJson(attachments);
        } else {
          process.stdout.write(
            renderAttachmentList(attachments, { showOwnerRunId: parsed.cwdScope === true }),
          );
        }
        return process.exit(0);
      } catch (err) {
        return exitCommandFailure(err, connectUrl);
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
        const attachment =
          connectUrl === undefined
            ? await addRunAttachmentFromFile(target, {
                sourcePath,
                name: parsed.attachmentName,
                mimeType: parsed.attachmentMimeType,
              })
            : await daemonAddAttachment(
                connectUrl,
                await resolveAttachmentTargetForDaemon(target, connectUrl),
                {
                  sourcePath,
                  name,
                  mimeType: parsed.attachmentMimeType,
                },
              );
        if (parsed.outputFormat === "json") {
          writeJson(attachment);
        } else {
          const runId =
            connectUrl === undefined
              ? target
              : await resolveAttachmentTargetForDaemon(target, connectUrl);
          process.stdout.write(renderAttachmentAdded(runId, attachment));
        }
        return process.exit(0);
      } catch (err) {
        return exitCommandFailure(err, connectUrl);
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
          connectUrl === undefined
            ? removeRunAttachment(target, attachmentId)
            : await daemonRemoveAttachment(
                connectUrl,
                await resolveAttachmentTargetForDaemon(target, connectUrl),
                attachmentId,
              );
        if (parsed.outputFormat === "json") {
          writeJson(result);
        } else {
          process.stdout.write(renderAttachmentRemoved(result));
        }
        return process.exit(0);
      } catch (err) {
        return exitCommandFailure(err, connectUrl);
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
          connectUrl === undefined
            ? downloadRunAttachment(target, attachmentId, outputPath)
            : await (async () => {
                const runId = await resolveAttachmentTargetForDaemon(target, connectUrl);
                const attachment = (await daemonListAttachments(connectUrl, runId)).find(
                  (candidate) => candidate.id === attachmentId,
                );
                if (!attachment) {
                  throw new AttachmentError(
                    `attachment "${attachmentId}" not found in run ${runId}`,
                  );
                }
                return await daemonDownloadAttachment(connectUrl, runId, attachment, outputPath);
              })();
        if (parsed.outputFormat === "json") {
          writeJson(result);
        } else {
          process.stdout.write(renderAttachmentDownloaded(result));
        }
        return process.exit(0);
      } catch (err) {
        return exitCommandFailure(err, connectUrl);
      }
    }
    default:
      process.stderr.write(
        `task-runner: attachment command requires a subcommand: add | list | remove | download (got "${parsed.subcommand ?? ""}")\n`,
      );
      process.exit(3);
  }
}

async function runResetCommand(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? reset(target)
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runDeleteCommand(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? deleteArchivedRun(target)
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runArchiveToggleCommand(
  parsed: ParsedArgs,
  connectUrl: string | undefined,
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
      connectUrl === undefined
        ? verb === "archive"
          ? archive(target)
          : unarchive(target)
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runSetNameCommand(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? await renameRun(target, { name: nextName })
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runBackendSessionCommand(
  parsed: ParsedArgs,
  connectUrl: string | undefined,
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
        connectUrl === undefined
          ? updateRunBackendSession(target, { backendSessionId })
          : await withDaemonClient(connectUrl, (client) =>
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
        connectUrl === undefined
          ? clearBackendSession(target)
          : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runDependencyCommand(
  parsed: ParsedArgs,
  connectUrl: string | undefined,
  verb: "add-dep" | "remove-dep" | "clear-deps",
): Promise<never> {
  const [runArg, dependencyArg, extra] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target) {
    process.stderr.write(
      `task-runner: run ${verb} requires <id-or-path>${verb === "clear-deps" ? "" : " <dependency-run-id>"}\n`,
    );
    process.exit(3);
  }
  if (verb === "clear-deps") {
    if (dependencyArg !== undefined) {
      process.stderr.write(
        `task-runner: run clear-deps takes exactly one positional (<id-or-path>); got extra "${dependencyArg}"\n`,
      );
      process.exit(3);
    }
  } else if (!dependencyArg) {
    process.stderr.write(`task-runner: run ${verb} requires <id-or-path> <dependency-run-id>\n`);
    process.exit(3);
  } else if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run ${verb} takes exactly two positionals (<id-or-path> <dependency-run-id>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }

  const unsupported = unsupportedFlagsForGroupedCommand(parsed);
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run ${verb} only supports ${verb === "clear-deps" ? "<id-or-path>" : "<id-or-path>, <dependency-run-id>"}, --connect, and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    const method =
      verb === "add-dep"
        ? "runs.addDependency"
        : verb === "remove-dep"
          ? "runs.removeDependency"
          : "runs.clearDependencies";
    const params =
      verb === "clear-deps" ? { target } : { target, dependencyRunId: dependencyArg as string };
    const result =
      connectUrl === undefined
        ? method === "runs.addDependency"
          ? addDependency(target, dependencyArg as string)
          : method === "runs.removeDependency"
            ? removeDependency(target, dependencyArg as string)
            : clearDependencies(target)
        : await withDaemonClient(connectUrl, (client) =>
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
      process.stdout.write(renderRunAddDependency(result, dependencyArg as string));
    } else if (verb === "remove-dep") {
      process.stdout.write(renderRunRemoveDependency(result, dependencyArg as string));
    } else {
      process.stdout.write(renderRunClearDependencies(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err, connectUrl);
  }
}

async function runTaskList(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? getTaskList(target)
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runTaskShow(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? getTask(target, taskId)
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runTaskSet(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
  const [runArg, taskId] = parsed.positionals;
  const target = normalizeTarget(runArg);
  if (!target || !taskId) {
    process.stderr.write("task-runner: task set requires <run-id> <task-id>\n");
    process.exit(3);
  }

  try {
    const task =
      connectUrl === undefined
        ? updateTask(target, taskId, {
            status: parsed.taskStatus,
            notes: parsed.taskNotes,
          })
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runTaskAppendNotes(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? appendNotes(target, taskId, parsed.taskAppendText)
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
  }
}

async function runTaskAdd(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
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
      connectUrl === undefined
        ? createTask(target, { title: parsed.taskTitle, body: parsed.taskBody })
        : await withDaemonClient(connectUrl, (client) =>
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
    exitCommandFailure(err, connectUrl);
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
    if (isInitCommand) {
      const run = await initRun({
        agent: normalizeTarget(parsed.agent),
        assignment: normalizeTarget(parsed.assignment),
        definitionCwd: process.cwd(),
        backendSessionId: parsed.backendSessionId,
        cliVars: parsed.vars,
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
          backendSessionId: parsed.backendSessionId,
          cliVars: parsed.vars,
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
      err instanceof VarResolutionError ||
      err instanceof LockedFieldError ||
      err instanceof ResumeError ||
      err instanceof InvalidAddedTaskError ||
      err instanceof InvalidRunNameError ||
      err instanceof EmptyPromptError ||
      err instanceof RecursionDepthError ||
      err instanceof InvalidBackendSessionError
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

async function runExecuteCommandDaemon(parsed: ParsedArgs, connectUrl: string): Promise<never> {
  const isInitCommand = parsed.command === "init";
  const isJson = parsed.outputFormat === "json";

  await withDaemonClient(connectUrl, async (client) => {
    if (isInitCommand) {
      const result = await client.call<{ run: ReturnType<typeof getRun> }>("runs.init", {
        agent: normalizeTarget(parsed.agent),
        assignment: normalizeTarget(parsed.assignment),
        definitionCwd: process.cwd(),
        callerCwd: process.cwd(),
        backendSessionId: parsed.backendSessionId,
        cliVars: parsed.vars,
        overrides: resolvedDaemonOverrides(parsed),
      });
      if (isJson) {
        writeJson(result.run);
      } else {
        renderInitializedRun(result.run);
      }
      process.exit(0);
    }

    if (parsed.detach) {
      const startResult = await startOrResumeDaemonRun(client, parsed);
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
      const startResult = await startOrResumeDaemonRun(client, parsed);
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

  let connectUrl: string | undefined;
  try {
    connectUrl = resolveHostMode(parsed.connect).connectUrl;
  } catch (err) {
    process.stderr.write(`task-runner: ${errorMessage(err)}\n`);
    process.exit(3);
  }

  if (parsed.detach && parsed.command === "run" && parsed.subcommand === undefined && !connectUrl) {
    process.stderr.write(
      "task-runner: --detach requires daemon-connected run execution (--connect or TASK_RUNNER_CONNECT)\n",
    );
    process.exit(3);
  }

  if (parsed.command === "status") {
    await runSystemStatus(parsed, connectUrl);
  }

  if (parsed.command === "run") {
    if (parsed.subcommand === "status") {
      await runRunStatus(parsed, connectUrl);
    }
    if (parsed.subcommand === "brief") {
      await runRunBrief(parsed, connectUrl);
    }
    if (parsed.subcommand === "reset") {
      await runResetCommand(parsed, connectUrl);
    }
    if (parsed.subcommand === "archive") {
      await runArchiveToggleCommand(parsed, connectUrl, "archive");
    }
    if (parsed.subcommand === "unarchive") {
      await runArchiveToggleCommand(parsed, connectUrl, "unarchive");
    }
    if (parsed.subcommand === "delete") {
      await runDeleteCommand(parsed, connectUrl);
    }
    if (parsed.subcommand === "set-name") {
      await runSetNameCommand(parsed, connectUrl);
    }
    if (parsed.subcommand === "set-backend-session") {
      await runBackendSessionCommand(parsed, connectUrl, "set-backend-session");
    }
    if (parsed.subcommand === "clear-backend-session") {
      await runBackendSessionCommand(parsed, connectUrl, "clear-backend-session");
    }
    if (parsed.subcommand === "add-dep") {
      await runDependencyCommand(parsed, connectUrl, "add-dep");
    }
    if (parsed.subcommand === "remove-dep") {
      await runDependencyCommand(parsed, connectUrl, "remove-dep");
    }
    if (parsed.subcommand === "clear-deps") {
      await runDependencyCommand(parsed, connectUrl, "clear-deps");
    }
  }

  if (parsed.command === "task") {
    await runTaskCommand(parsed, connectUrl);
  }

  if (parsed.command === "attachment") {
    await runAttachmentCommand(parsed, connectUrl);
  }

  if (parsed.command === "list") {
    await runListCommand(parsed, connectUrl);
  }

  if (parsed.command === "show") {
    await runShowCommand(parsed, connectUrl);
  }

  if (parsed.command !== "run" && parsed.command !== "init") {
    process.stderr.write(`task-runner: unknown command "${parsed.command}"\n`);
    process.stderr.write(HELP);
    process.exit(3);
  }

  if (connectUrl) {
    await runExecuteCommandDaemon(parsed, connectUrl);
  } else {
    await runExecuteCommandEmbedded(parsed);
  }
}

main().catch((err) => {
  process.stderr.write(`task-runner: ${errorMessage(err)}\n`);
  process.exit(4);
});
