#!/usr/bin/env node
import { type ParsedArgs, overridesFromParsedArgs, parseArgs } from "./cli/parse-args.js";
import { renderRunEvent } from "./cli/render-run.js";
import {
  renderDefinitionDetails,
  renderDefinitionList,
  renderRunArchive,
  renderRunList,
  renderRunReset,
  renderRunUnarchive,
  renderStatus,
  renderTaskAdded,
  renderTaskDetails,
  renderTaskList,
  renderTaskMutation,
} from "./commands/render.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  DefinitionListError,
} from "./config/loader.js";
import {
  CommandError,
  addTask,
  appendTaskNotes,
  archiveRun,
  isCommandError,
  listDefinitions,
  listRuns,
  listTasks,
  readStatus,
  resetRun,
  setTask,
  showDefinition,
  showTask,
  unarchiveRun,
} from "./core/commands/service.js";
import { ResumeError, UnknownBackendError, executeRunCommand } from "./core/run/execute-command.js";
import {
  EmptyPromptError,
  InvalidAddedTaskError,
  InvalidBackendSessionError,
  LockedFieldError,
  RecursionDepthError,
  VarResolutionError,
} from "./core/run/run-loop.js";

const HELP = `Usage: task-runner <run|init|status|task|list|show> [options] [args]

Commands:
  run                     Execute an agent. Either a fresh run, a resume,
                          or execute-after-init (when --resume-run points
                          at an initialized run).
  run reset <id|path>     Restore a non-running run to initialized state.
                          Rewrites run.json and assignment.md, clears old
                          execution history, and rejects in-flight runs.
  run archive <id|path>   Mark a non-running run as archived. Archived
                          runs stay visible via list/status but are
                          rejected by --resume-run until unarchived.
  run unarchive <id|path> Clear a run's archive marker so it can be
                          resumed again.
  init                    Prepare a run without invoking the backend. Writes
                          the workspace, seeds assignment.md from tasks, and
                          stores a manifest with status=initialized and a
                          frozen pendingPrompt. Resume later with
                          \`task-runner run --resume-run <id>\`.
  status <id|path>        Read a run's persisted manifest and print its
                          current status, agent/assignment/backend, task
                          checklist with statuses and notes, and a hint
                          for resuming. Read-only — touches no state.
                          Supports --output-format json and --field for
                          selective JSON output.
  task list <id>          List tasks for a run in stable task order.
                          Read-only. Supports --output-format json.
  task show <id> <task>   Show one task snapshot for a run.
                          Read-only. Supports --output-format json.
  task set <id> <task>    Update a task's status and/or notes on a run
                          without invoking the backend. Requires at least
                          one of --status / --notes. Rewrites the
                          workspace assignment.md and persists the
                          manifest. Running non-passive runs only allow
                          this in \`taskMode=cli\`.
  task append-notes <id> <task>
                          Append text to a task's notes with a single
                          newline separator. Requires --text. Rewrites the
                          workspace assignment.md and persists the
                          manifest. Running non-passive runs only allow
                          this in \`taskMode=cli\`.
  task add <id>           Append a new task to a run's task list. Requires
                          --title. Accepts optional --body. Generates a
                          \`cli-<short-id>\` task id.
                          Respects the \`tasks\` locked field. Rejected
                          while status=running.
  list <agents|assignments>
                          Enumerate available definitions from the
                          config root (\${TASK_RUNNER_CONFIG_DIR},
                          XDG fallback, or ~/.config/task-runner).
                          Read-only.
                          Supports --output-format json.
  list runs               Enumerate known current-generation runs across
                          all state-dir repo buckets. Archived runs are
                          hidden unless --include-archived is supplied.
                          Supports --output-format json.
  show <agent|assignment> <name|path>
                          Print details of a specific definition.
                          Read-only. Supports --output-format json.

Arguments:
  [message]               Positional text. For a fresh run or init,
                          appended as the "specific ask" at the end of the
                          prompt. For a resume run, sent as (part of) the
                          sole follow-up prompt for the new session.
                          Forbidden when resuming an initialized run.

Task command options:
  --status <s>            (task set) Target status: pending, in_progress,
                          completed, or blocked.
  --notes <text>          (task set) Replacement notes body.
  --text <text>           (task append-notes) Text to append.
  --title <text>          (task add) Title for the new task.
  --body <text>           (task add) Optional task body.

Options:
  --agent <name|path>     Agent bare name (resolved only from
                          \${TASK_RUNNER_CONFIG_DIR}/agents/<name>/agent.md,
                          with XDG fallback) or a direct path to an
                          agent.md file. Optional on fresh runs and init
                          — when omitted, task-runner synthesizes an
                          ad-hoc agent from CLI overrides (in that case
                          --backend is required; every other field gets a
                          default). Forbidden with --resume-run: the agent
                          config is reconstructed from the frozen manifest
                          (no agent.md re-read).
  --assignment <n|path>   Assignment bare name (resolved only from
                          \${TASK_RUNNER_CONFIG_DIR}/assignments/<n>/assignment.md,
                          with XDG fallback) or a direct path to an
                          assignment.md file. Assignments supply tasks,
                          vars, and optional work instructions. Forbidden
                          on --resume-run.
  --backend-session-id    Adopt an existing backend session id (claude session
                          UUID, codex thread id) instead of starting a fresh
                          one. Cannot be combined with --resume-run. Validated
                          via the backend's read-only check before any
                          workspace creation; the cwd must match the cwd the
                          session was originally created under.
  --resume-run <id|path>  Continue an existing run by short id or by direct
                          path to its workspace / run.json. Short ids are
                          resolved from \${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/
                          first, then runs/unknown/ (with XDG fallback).
                          Reads the prior manifest and reconstructs the
                          agent from its frozen fields (no re-read of the
                          source agent.md under the manifest-canonical
                          design). Normalizes non-completed tasks to
                          pending and starts a new session. Requires a
                          follow-up message OR --add-task, unless the
                          prior manifest has status=initialized (in which
                          case the stored pendingPrompt is executed as
                          session 0 with NO overrides — init deliberately
                          froze them).

                          Regular resume accepts these overrides (all still
                          vetted against manifest.lockedFields): --model,
                          --effort, --timeout-sec, --max-retries,
                          --unrestricted, --session-name. The following
                          are REJECTED on any resume: --agent, --assignment,
                          --backend, --backend-session-id, --cwd (sessions
                          are cwd-bound), --var (vars are frozen into the
                          manifest at first write, not re-resolved).
  --var <key>=<value>     Set an input variable (repeatable). Validated
                          against the assignment's var schema. Forbidden
                          with --resume-run — vars are resolved once at
                          first write and frozen into the manifest.
  --add-task <title>      Append a task to the run's task list with the
                          given title (repeatable). IDs are auto-generated
                          as \`cli-<short-id>\`. Rejected if \`tasks\` is
                          listed in the run's locked fields.
  --cwd <path>            Override the agent's cwd. Forbidden with
                          --resume-run (backend sessions are cwd-bound;
                          a new cwd would invalidate the captured session
                          id). Create a fresh run if you need a different
                          cwd.
  --backend <id>          Override the agent's backend (claude, codex, or passive).
                          Forbidden with --resume-run. The agent's model is
                          dropped on backend override unless --model is also
                          passed (model strings are backend-specific).
  --task-mode <m>         Override the assignment task workflow mode
                          ("file" or "cli"). Forbidden with --resume-run;
                          the chosen mode is frozen into the manifest at
                          first write.
  --model <id>            Override the agent's model.
  --effort <level>        Override effort level (off, minimal, low, medium,
                          high, xhigh, max).
  --timeout-sec <n>       Override the per-attempt timeout.
  --max-retries <n>       Override the max number of retries (default 3).
  --unrestricted          Bypass the backend's approval prompts.
  --session-name <name>   Override the assignment's sessionName (the
                          backend display label — claude --name / codex
                          thread/name/set). Vars are interpolated.
  --output-format <fmt>   Output format: "text" (default) or "json".
  --field <name>          (status only, repeatable) When --output-format
                          is json, restrict output to these top-level
                          manifest fields.
  --include-archived      (list runs only) Include archived runs in the
                          listing. Archived rows include their timestamp.
  --help, -h              Print this message.

Exit codes:
  0    All tasks completed successfully (or 0-task run succeeded)
  1    Retries exhausted with incomplete tasks
  2    One or more tasks reported as blocked
  3    Config / validation / resume error before any run started
  4    Backend invocation error
  130  Run interrupted by user (Ctrl+C) or external cancellation
`;

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

  if (parsed.includeArchived && !(parsed.command === "list" && parsed.subcommand === "runs")) {
    process.stderr.write("task-runner: --include-archived is only valid with `list runs`\n");
    process.exit(3);
  }

  if (parsed.command === "status") {
    runStatus(parsed);
  }

  if (parsed.command === "run") {
    if (parsed.subcommand === "reset") {
      runResetCommand(parsed);
    }
    if (parsed.subcommand === "archive") {
      runArchiveCommand(parsed);
    }
    if (parsed.subcommand === "unarchive") {
      runUnarchiveCommand(parsed);
    }
  }

  if (parsed.command === "task") {
    runTaskCommand(parsed);
  }

  if (parsed.command === "list") {
    runListCommand(parsed);
  }

  if (parsed.command === "show") {
    runShowCommand(parsed);
  }

  if (parsed.command !== "run" && parsed.command !== "init") {
    process.stderr.write(`task-runner: unknown command "${parsed.command}"\n`);
    process.stderr.write(HELP);
    process.exit(3);
  }

  const isInitCommand = parsed.command === "init";

  if (
    parsed.resumeRun === undefined &&
    parsed.agent === undefined &&
    parsed.backend === undefined
  ) {
    process.stderr.write(
      "task-runner: --agent was omitted — --backend is required to synthesize an ad-hoc agent\n",
    );
    process.stderr.write(HELP);
    process.exit(3);
  }

  const isJson = parsed.outputFormat === "json";

  // Install a SIGINT handler that aborts the in-flight backend invocation
  // on the first Ctrl+C and force-exits on the second. The first Ctrl+C
  // gives the run loop a chance to send `turn/interrupt` to codex (or
  // SIGINT to the claude child) and persist the manifest as `aborted`.
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
    const outcome = await executeRunCommand({
      initialize: isInitCommand,
      agent: parsed.agent,
      assignment: parsed.assignment,
      resumeRun: parsed.resumeRun,
      backendSessionId: parsed.backendSessionId,
      cliVars: parsed.vars,
      overrides: overridesFromParsedArgs(parsed),
      abortSignal: abortController.signal,
      emitEvent: isJson
        ? undefined
        : (event) => {
            for (const chunk of renderRunEvent(event)) {
              if (chunk.stream === "stdout") {
                process.stdout.write(chunk.text);
              } else {
                process.stderr.write(chunk.text);
              }
            }
          },
    });
    if (isJson) {
      process.stdout.write(`${JSON.stringify(outcome.manifest, null, 2)}\n`);
    }
    process.exit(outcome.exitCode);
  } catch (err) {
    if (
      err instanceof UnknownBackendError ||
      err instanceof AgentNotFoundError ||
      err instanceof AgentConfigError ||
      err instanceof AssignmentNotFoundError ||
      err instanceof AssignmentConfigError ||
      err instanceof VarResolutionError ||
      err instanceof LockedFieldError ||
      err instanceof ResumeError ||
      err instanceof InvalidAddedTaskError ||
      err instanceof EmptyPromptError ||
      err instanceof RecursionDepthError ||
      err instanceof InvalidBackendSessionError
    ) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`task-runner: ${(err as Error).message}\n`);
    process.exit(4);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function exitCommandFailure(err: unknown): never {
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
  process.stderr.write(`task-runner: ${errorMessage(err)}\n`);
  process.exit(4);
}

function projectStatus(
  detail: ReturnType<typeof readStatus>,
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

function runStatus(parsed: ParsedArgs): never {
  const target = parsed.message?.trim();
  if (!target || target.length === 0) {
    process.stderr.write("task-runner: status requires a run id or workspace path\n");
    process.stderr.write(
      "Usage: task-runner status <id-or-path> [--output-format json] [--field name]...\n",
    );
    process.exit(3);
  }

  try {
    const result = readStatus(target);
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
    exitCommandFailure(err);
  }
}

function runListCommand(parsed: ParsedArgs): never {
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
          `task-runner: list runs only supports --include-archived and --output-format (got ${unsupported.join(", ")})\n`,
        );
        process.exit(3);
      }
      const result = listRuns({ includeArchived: parsed.includeArchived });
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
        `task-runner: list ${kindArg} only supports --output-format (got ${unsupported.join(", ")})\n`,
      );
      process.exit(3);
    }
    const result = listDefinitions(kindArg === "agents" ? "agent" : "assignment");
    if (parsed.outputFormat === "json") {
      writeJson(result.entries);
    } else {
      process.stdout.write(renderDefinitionList(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err);
  }
}

function runShowCommand(parsed: ParsedArgs): never {
  const kindArg = parsed.subcommand;
  if (kindArg !== "agent" && kindArg !== "assignment") {
    process.stderr.write(
      `task-runner: show requires a kind: agent or assignment${kindArg ? ` (got "${kindArg}")` : ""}\n`,
    );
    process.stderr.write(
      "Usage: task-runner show <agent|assignment> <name|path> [--output-format json]\n",
    );
    process.exit(3);
  }

  const target = parsed.positionals[0];
  if (!target || target.length === 0) {
    process.stderr.write(`task-runner: show ${kindArg} requires a name or path\n`);
    process.stderr.write(
      "Usage: task-runner show <agent|assignment> <name|path> [--output-format json]\n",
    );
    process.exit(3);
  }

  try {
    const result = showDefinition(kindArg, target);
    if (parsed.outputFormat === "json") {
      writeJson({
        config: result.loaded.config,
        instructions: result.loaded.instructions,
        sourcePath: result.loaded.sourcePath,
      });
    } else {
      process.stdout.write(renderDefinitionDetails(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err);
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
  if (!opts.allowIncludeArchived && parsed.includeArchived) unsupported.push("--include-archived");
  return unsupported;
}

function runTaskCommand(parsed: ParsedArgs): never {
  switch (parsed.subcommand) {
    case "list":
      return runTaskList(parsed);
    case "show":
      return runTaskShow(parsed);
    case "set":
      return runTaskSet(parsed);
    case "append-notes":
      return runTaskAppendNotes(parsed);
    case "add":
      return runTaskAdd(parsed);
    default:
      process.stderr.write(
        `task-runner: task command requires a subcommand: list | show | set | append-notes | add (got "${parsed.subcommand ?? ""}")\n`,
      );
      process.stderr.write("Usage: task-runner task list <run-id> [--output-format text|json]\n");
      process.stderr.write(
        "       task-runner task show <run-id> <task-id> [--output-format text|json]\n",
      );
      process.stderr.write(
        "       task-runner task set <run-id> <task-id> [--status s] [--notes n]\n",
      );
      process.stderr.write(
        '       task-runner task append-notes <run-id> <task-id> --text "..." [--output-format text|json]\n',
      );
      process.stderr.write(
        '       task-runner task add <run-id> --title "..." [--body "..."] [--output-format text|json]\n',
      );
      process.exit(3);
  }
}

function runResetCommand(parsed: ParsedArgs): never {
  const [runArg, extra] = parsed.positionals;
  if (!runArg) {
    process.stderr.write("task-runner: run reset requires <id-or-path>\n");
    process.stderr.write("Usage: task-runner run reset <id-or-path> [--output-format text|json]\n");
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
      `task-runner: run reset only supports <id-or-path> and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    const result = resetRun(runArg);
    if (parsed.outputFormat === "json") {
      writeJson({ runId: result.manifest.runId, status: result.manifest.status });
    } else {
      process.stdout.write(renderRunReset(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err);
  }
}

function runArchiveToggleCommand(
  parsed: ParsedArgs,
  opts: {
    verb: "archive" | "unarchive";
    action: (target: string) => ReturnType<typeof archiveRun>;
    renderText: typeof renderRunArchive | typeof renderRunUnarchive;
  },
): never {
  const [runArg, extra] = parsed.positionals;
  if (!runArg) {
    process.stderr.write(`task-runner: run ${opts.verb} requires <id-or-path>\n`);
    process.stderr.write(
      `Usage: task-runner run ${opts.verb} <id-or-path> [--output-format text|json]\n`,
    );
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: run ${opts.verb} takes exactly one positional (<id-or-path>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }

  const unsupported = unsupportedFlagsForGroupedCommand(parsed);
  if (unsupported.length > 0) {
    process.stderr.write(
      `task-runner: run ${opts.verb} only supports <id-or-path> and --output-format (got ${unsupported.join(", ")})\n`,
    );
    process.exit(3);
  }

  try {
    const result = opts.action(runArg);
    if (parsed.outputFormat === "json") {
      writeJson(result);
    } else {
      process.stdout.write(opts.renderText(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err);
  }
}

function runArchiveCommand(parsed: ParsedArgs): never {
  return runArchiveToggleCommand(parsed, {
    verb: "archive",
    action: archiveRun,
    renderText: renderRunArchive,
  });
}

function runUnarchiveCommand(parsed: ParsedArgs): never {
  return runArchiveToggleCommand(parsed, {
    verb: "unarchive",
    action: unarchiveRun,
    renderText: renderRunUnarchive,
  });
}

function runTaskList(parsed: ParsedArgs): never {
  const [runArg, extra] = parsed.positionals;
  if (!runArg) {
    process.stderr.write("task-runner: task list requires <run-id>\n");
    process.stderr.write("Usage: task-runner task list <run-id> [--output-format text|json]\n");
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: task list takes exactly one positional (<run-id>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }

  try {
    const result = listTasks(runArg);
    if (parsed.outputFormat === "json") {
      writeJson(result.tasks);
    } else {
      process.stdout.write(renderTaskList(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err);
  }
}

function runTaskShow(parsed: ParsedArgs): never {
  const [runArg, taskId, extra] = parsed.positionals;
  if (!runArg || !taskId) {
    process.stderr.write("task-runner: task show requires <run-id> <task-id>\n");
    process.stderr.write(
      "Usage: task-runner task show <run-id> <task-id> [--output-format text|json]\n",
    );
    process.exit(3);
  }
  if (extra !== undefined) {
    process.stderr.write(
      `task-runner: task show takes exactly two positionals (<run-id> <task-id>); got extra "${extra}"\n`,
    );
    process.exit(3);
  }

  try {
    const result = showTask(runArg, taskId);
    if (parsed.outputFormat === "json") {
      writeJson(result.task);
    } else {
      process.stdout.write(renderTaskDetails(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err);
  }
}

function runTaskSet(parsed: ParsedArgs): never {
  const [runArg, taskId] = parsed.positionals;
  if (!runArg || !taskId) {
    process.stderr.write("task-runner: task set requires <run-id> <task-id>\n");
    process.stderr.write(
      "Usage: task-runner task set <run-id> <task-id> [--status s] [--notes n]\n",
    );
    process.exit(3);
  }

  try {
    const result = setTask(runArg, taskId, {
      status: parsed.taskStatus,
      notes: parsed.taskNotes,
    });
    if (parsed.outputFormat === "json") {
      writeJson(result.task);
    } else {
      process.stdout.write(renderTaskMutation(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err);
  }
}

function runTaskAppendNotes(parsed: ParsedArgs): never {
  const [runArg, taskId] = parsed.positionals;
  if (!runArg || !taskId) {
    process.stderr.write("task-runner: task append-notes requires <run-id> <task-id>\n");
    process.stderr.write(
      'Usage: task-runner task append-notes <run-id> <task-id> --text "..." [--output-format text|json]\n',
    );
    process.exit(3);
  }
  if (parsed.taskAppendText === undefined) {
    process.stderr.write("task-runner: task append-notes requires --text\n");
    process.exit(3);
  }

  try {
    const result = appendTaskNotes(runArg, taskId, parsed.taskAppendText);
    if (parsed.outputFormat === "json") {
      writeJson(result.task);
    } else {
      process.stdout.write(renderTaskMutation(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err);
  }
}

function runTaskAdd(parsed: ParsedArgs): never {
  const [runArg, extra] = parsed.positionals;
  if (!runArg) {
    process.stderr.write("task-runner: task add requires <run-id>\n");
    process.stderr.write('Usage: task-runner task add <run-id> --title "..."\n');
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
    const result = addTask(runArg, { title: parsed.taskTitle, body: parsed.taskBody });
    if (parsed.outputFormat === "json") {
      writeJson(result.task);
    } else {
      process.stdout.write(renderTaskAdded(result));
    }
    process.exit(0);
  } catch (err) {
    exitCommandFailure(err);
  }
}

main().catch((err) => {
  process.stderr.write(`task-runner: ${errorMessage(err)}\n`);
  process.exit(4);
});
