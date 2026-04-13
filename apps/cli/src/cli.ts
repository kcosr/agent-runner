#!/usr/bin/env node
import {
  appendNotes,
  archive,
  createTask,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunList,
  getTask,
  getTaskList,
  initRun,
  reset,
  resumeRun,
  startRun,
  unarchive,
  updateTask,
} from "@task-runner/core/app/service.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  DefinitionListError,
} from "@task-runner/core/config/loader.js";
import { isPathArg, resolveInputPath } from "@task-runner/core/config/runtime-paths.js";
import { CommandError, isCommandError } from "@task-runner/core/core/commands/service.js";
import {
  EmptyPromptError,
  InvalidAddedTaskError,
  InvalidBackendSessionError,
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
import { type ParsedArgs, overridesFromParsedArgs, parseArgs } from "./cli/parse-args.js";
import { renderRunEvent } from "./cli/render-run.js";
import {
  renderDefinitionDetails,
  renderDefinitionList,
  renderRunArchive,
  renderRunList,
  renderRunUnarchive,
  renderStatus,
  renderTaskDetails,
  renderTaskList,
} from "./commands/render.js";
import { DaemonClient, DaemonConnectionError, DaemonRpcError } from "./daemon/client.js";
import { resolveHostMode, resolveListenUrl } from "./daemon/config.js";
import { RPC_ERROR_COMMAND } from "./daemon/protocol.js";
import { serveDaemon } from "./daemon/server.js";

const HELP = `Usage: task-runner <run|init|serve|status|task|list|show> [options] [args]

Commands:
  run                     Execute an agent. Either a fresh run, a resume,
                          or execute-after-init (when --resume-run points
                          at an initialized run).
  run reset <id|path>     Restore a non-running run to initialized state.
  run archive <id|path>   Mark a non-running run as archived.
  run unarchive <id|path> Clear a run's archive marker.
  init                    Prepare a run without invoking the backend.
  serve                   Start the local daemon server on loopback.
  status <id|path>        Read a run and print its current status.
  task list <id>          List tasks for a run in stable task order.
  task show <id> <task>   Show one task snapshot for a run.
  task set <id> <task>    Update a task's status and/or notes.
  task append-notes <id> <task>
                          Append text to a task's notes.
  task add <id>           Append a new task to a run's task list.
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

Host selection:
  --connect <ws-url>      Route the command through the daemon host.
                          Also honored from TASK_RUNNER_CONNECT.
  --listen <ws-url>       (serve only) Listen URL for the daemon host.
                          Also honored from TASK_RUNNER_LISTEN. The same
                          loopback listener serves HTTP/SSE under /api/.

Execution options:
  --agent <name|path>     Agent bare name or direct path to agent.md.
  --assignment <n|path>   Assignment bare name or direct path to assignment.md.
  --backend-session-id    Adopt an existing backend session id.
  --resume-run <id|path>  Continue an existing run by short id or path.
  --var <key>=<value>     Set an input variable (repeatable).
  --add-task <title>      Append a task to the run's task list.
  --cwd <path>            Override the agent's cwd.
  --backend <id>          Override the agent's backend.
  --task-mode <m>         Override the assignment task workflow mode.
  --model <id>            Override the agent's model.
  --effort <level>        Override effort level.
  --timeout-sec <n>       Override the per-attempt timeout.
  --max-retries <n>       Override the max number of retries.
  --unrestricted          Bypass the backend's approval prompts.
  --session-name <name>   Override the assignment's session name.
  --output-format <fmt>   Output format: "text" (default) or "json".
  --field <name>          (status only, repeatable) Restrict JSON output.
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

function resolvedOverrides(parsed: ParsedArgs) {
  return {
    ...overridesFromParsedArgs(parsed),
    cwd: parsed.cwd ? resolveInputPath(parsed.cwd, process.cwd()) : undefined,
  };
}

function renderInitializedRun(detail: ReturnType<typeof getRun>): void {
  emitRenderedEvent({
    type: "run_initialized",
    runId: detail.runId,
    agentName: detail.agent.name,
    assignmentSourcePath: detail.assignment?.sourcePath ?? null,
    assignmentPath: detail.assignmentPath,
    sessionName: detail.sessionName,
    cwd: detail.cwd,
    passive: detail.backend === "passive",
    pendingPrompt: detail.pendingPrompt ?? "",
  });
  if (detail.callerInstructions) {
    emitRenderedEvent({
      type: "caller_instructions",
      text: detail.callerInstructions,
    });
  }
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

async function runStatus(parsed: ParsedArgs, connectUrl?: string): Promise<never> {
  const target = normalizeTarget(parsed.message?.trim());
  if (!target) {
    process.stderr.write("task-runner: status requires a run id or workspace path\n");
    process.stderr.write(
      "Usage: task-runner status <id-or-path> [--output-format json] [--field name]...\n",
    );
    process.exit(3);
  }

  try {
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
      process.stdout.write(renderStatus(result));
    }
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
      "Usage: task-runner list <agents|assignments|runs> [--include-archived] [--output-format json]\n",
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
      });
      if (unsupported.length > 0) {
        process.stderr.write(
          `task-runner: list runs only supports --connect, --include-archived, and --output-format (got ${unsupported.join(", ")})\n`,
        );
        process.exit(3);
      }
      const result =
        connectUrl === undefined
          ? getRunList({ includeArchived: parsed.includeArchived })
          : await withDaemonClient(connectUrl, (client) =>
              client
                .call<{ runs: ReturnType<typeof getRunList> }>("runs.list", {
                  includeArchived: parsed.includeArchived,
                })
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
  opts: { allowFields?: boolean; allowIncludeArchived?: boolean } = {},
): string[] {
  const unsupported: string[] = [];
  if (parsed.agent !== undefined) unsupported.push("--agent");
  if (parsed.assignment !== undefined) unsupported.push("--assignment");
  if (parsed.resumeRun !== undefined) unsupported.push("--resume-run");
  if (parsed.backendSessionId !== undefined) unsupported.push("--backend-session-id");
  if (Object.keys(parsed.vars).length > 0) unsupported.push("--var");
  if (parsed.cwd !== undefined) unsupported.push("--cwd");
  if (parsed.backend !== undefined) unsupported.push("--backend");
  if (parsed.model !== undefined) unsupported.push("--model");
  if (parsed.effort !== undefined) unsupported.push("--effort");
  if (parsed.taskMode !== undefined) unsupported.push("--task-mode");
  if (parsed.timeoutSec !== undefined) unsupported.push("--timeout-sec");
  if (parsed.unrestricted !== undefined) unsupported.push("--unrestricted");
  if (parsed.maxRetries !== undefined) unsupported.push("--max-retries");
  if (parsed.sessionName !== undefined) unsupported.push("--session-name");
  if (!opts.allowFields && parsed.fields.length > 0) unsupported.push("--field");
  if (parsed.taskStatus !== undefined) unsupported.push("--status");
  if (parsed.taskNotes !== undefined) unsupported.push("--notes");
  if (parsed.taskAppendText !== undefined) unsupported.push("--text");
  if (parsed.taskTitle !== undefined) unsupported.push("--title");
  if (parsed.taskBody !== undefined) unsupported.push("--body");
  if (parsed.addedTasks.length > 0) unsupported.push("--add-task");
  if (parsed.listen !== undefined) unsupported.push("--listen");
  if (!opts.allowIncludeArchived && parsed.includeArchived) unsupported.push("--include-archived");
  return unsupported;
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
        overrides: resolvedOverrides(parsed),
      });
      if (isJson) {
        writeJson(result.run);
      } else {
        renderInitializedRun(result.run);
      }
      process.exit(0);
    }

    const bufferedEvents: Array<{ runId: string; event: RunEvent }> = [];
    let activeRunId: string | undefined;
    let terminalStatus: string | undefined;
    let abortRequested = false;
    const onSigint = (): void => {
      if (activeRunId) {
        abortRequested = true;
        void client.call("runs.abort", { target: activeRunId }).catch(() => undefined);
        return;
      }
      abortRequested = true;
    };
    process.on("SIGINT", onSigint);

    const subscriptionId = await client.subscribe({}, ({ runId, event }) => {
      if (!activeRunId) {
        bufferedEvents.push({ runId, event });
        return;
      }
      if (runId !== activeRunId) {
        return;
      }
      if (!isJson) {
        emitRenderedEvent(event);
      }
      if (event.type === "run_finished") {
        terminalStatus = event.summary.status;
      }
    });

    try {
      const startResult = parsed.resumeRun
        ? await client.call<{ runId: string }>("runs.resume", {
            target: normalizeTarget(parsed.resumeRun) ?? parsed.resumeRun,
            overrides: resolvedOverrides(parsed),
          })
        : await client.call<{ runId: string }>("runs.start", {
            agent: normalizeTarget(parsed.agent),
            assignment: normalizeTarget(parsed.assignment),
            definitionCwd: process.cwd(),
            callerCwd: process.cwd(),
            backendSessionId: parsed.backendSessionId,
            cliVars: parsed.vars,
            overrides: resolvedOverrides(parsed),
          });
      activeRunId = startResult.runId;
      for (const buffered of bufferedEvents) {
        if (buffered.runId !== activeRunId) {
          continue;
        }
        if (!isJson) {
          emitRenderedEvent(buffered.event);
        }
        if (buffered.event.type === "run_finished") {
          terminalStatus = buffered.event.summary.status;
        }
      }
      if (abortRequested) {
        await client.call("runs.abort", { target: activeRunId });
      }
      while (!terminalStatus) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const finalRun = await client.call<{ run: ReturnType<typeof getRun> }>("runs.get", {
        target: activeRunId,
      });
      if (isJson) {
        writeJson(finalRun.run);
      }
      process.exit(terminalExitCode(terminalStatus));
    } finally {
      process.off("SIGINT", onSigint);
      await client.unsubscribe(subscriptionId);
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

  if (parsed.command === "status") {
    await runStatus(parsed, connectUrl);
  }

  if (parsed.command === "run") {
    if (parsed.subcommand === "reset") {
      await runResetCommand(parsed, connectUrl);
    }
    if (parsed.subcommand === "archive") {
      await runArchiveToggleCommand(parsed, connectUrl, "archive");
    }
    if (parsed.subcommand === "unarchive") {
      await runArchiveToggleCommand(parsed, connectUrl, "unarchive");
    }
  }

  if (parsed.command === "task") {
    await runTaskCommand(parsed, connectUrl);
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
