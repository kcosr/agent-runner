#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { mergeUpdates } from "./assignment/merge.js";
import { type TaskState, VALID_STATUSES, isValidStatus } from "./assignment/model.js";
import { parseAssignment } from "./assignment/parser.js";
import { renderAssignment } from "./assignment/writer.js";
import { UnknownBackendError, resolveBackend } from "./backends/registry.js";
import { type ParsedArgs, overridesFromParsedArgs, parseArgs } from "./cli/parse-args.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  type LoadedAgent,
  type LoadedAssignment,
  loadAgentConfig,
  loadAssignmentConfig,
} from "./config/loader.js";
import {
  ResumeError,
  type RunManifest,
  resolveResumeTarget,
  snapshotTasks,
  writeManifest,
} from "./runner/manifest.js";
import { type LiveTaskOverlay, applyLiveOverlay, renderManifestStatus } from "./runner/output.js";
import {
  EmptyPromptError,
  InvalidAddedTaskError,
  InvalidBackendSessionError,
  LockedFieldError,
  RecursionDepthError,
  VarResolutionError,
  runAgent,
} from "./runner/run-loop.js";
import { shortId } from "./util/short-id.js";

const HELP = `Usage: task-runner <run|init|status|task> [options] [args]

Commands:
  run                     Execute an agent. Either a fresh run, a resume,
                          or execute-after-init (when --resume-run points
                          at an initialized run).
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
  task set <id> <task>    Update a task's status and/or notes on a run
                          without invoking the backend. Requires at least
                          one of --status / --notes. Rewrites the
                          workspace assignment.md and persists the
                          manifest. Rejected while status=running.
  task add <id>           Append a new task to a run's task list. Requires
                          --title. Generates a \`cli-<short-id>\` task id.
                          Respects the \`tasks\` locked field. Rejected
                          while status=running.

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
  --title <text>          (task add) Title for the new task.

Options:
  --agent <name|path>     Agent name (resolved against ./agents/<name>/agent.md
                          or $TASK_RUNNER_HOME/agents/<name>/agent.md) or a
                          direct path to an agent.md file. Required for fresh
                          runs and init; optional for --resume-run (taken from
                          the prior manifest if omitted).
  --assignment <n|path>   Assignment name (resolved against
                          ./assignments/<n>/assignment.md or
                          $TASK_RUNNER_HOME/assignments/<n>/assignment.md) or
                          a direct path to an assignment.md file. Assignments
                          supply tasks, vars, and optional work instructions.
                          Forbidden on --resume-run.
  --backend-session-id    Adopt an existing backend session id (claude session
                          UUID, codex thread id) instead of starting a fresh
                          one. Cannot be combined with --resume-run. Validated
                          via the backend's read-only check before any
                          workspace creation; the cwd must match the cwd the
                          session was originally created under.
  --resume-run <id|path>  Continue an existing run by its short id or path
                          to its workspace / run.json. Reads the prior
                          manifest, reloads the agent, normalizes
                          non-completed tasks to pending, and starts a new
                          session. Requires a follow-up message OR
                          --add-task, unless the prior manifest has
                          status=initialized (in which case the stored
                          pendingPrompt is executed as session 0). Cannot
                          be combined with --assignment.
  --var <key>=<value>     Set an input variable (repeatable). Validated
                          against the assignment's var schema.
  --add-task <title>      Append a task to the run's task list with the
                          given title (repeatable). IDs are auto-generated
                          as \`cli-<short-id>\`. Rejected if \`tasks\` is
                          listed in the run's locked fields.
  --cwd <path>            Override the agent's cwd.
  --backend <id>          Override the agent's backend (claude or codex).
                          Forbidden with --resume-run. The agent's model is
                          dropped on backend override unless --model is also
                          passed (model strings are backend-specific).
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

  if (parsed.command === "status") {
    runStatus(parsed);
  }

  if (parsed.command === "task") {
    runTaskCommand(parsed);
  }

  if (parsed.command !== "run" && parsed.command !== "init") {
    process.stderr.write(`task-runner: unknown command "${parsed.command}"\n`);
    process.stderr.write(HELP);
    process.exit(3);
  }

  const isInitCommand = parsed.command === "init";

  if (isInitCommand && parsed.resumeRun !== undefined) {
    process.stderr.write("task-runner: init cannot be combined with --resume-run\n");
    process.exit(3);
  }
  if (parsed.resumeRun !== undefined && parsed.assignment !== undefined) {
    process.stderr.write("task-runner: --assignment cannot be combined with --resume-run\n");
    process.exit(3);
  }
  if (parsed.resumeRun !== undefined && parsed.backend !== undefined) {
    process.stderr.write(
      "task-runner: --backend cannot be combined with --resume-run (backend is locked to the run that created the session)\n",
    );
    process.exit(3);
  }
  if (parsed.resumeRun !== undefined && parsed.backendSessionId !== undefined) {
    process.stderr.write(
      "task-runner: --backend-session-id cannot be combined with --resume-run (the resume target already carries a backend session id)\n",
    );
    process.exit(3);
  }

  let resumeTarget: ReturnType<typeof resolveResumeTarget> | undefined;
  if (parsed.resumeRun !== undefined) {
    try {
      resumeTarget = resolveResumeTarget(parsed.resumeRun);
    } catch (err) {
      if (err instanceof ResumeError) {
        process.stderr.write(`task-runner: ${err.message}\n`);
      } else {
        process.stderr.write(`task-runner: ${(err as Error).message}\n`);
      }
      process.exit(3);
    }

    const priorInitialized = resumeTarget.manifest.status === "initialized";
    if (priorInitialized) {
      const forbidden: string[] = [];
      if (parsed.message && parsed.message.trim().length > 0) forbidden.push("message");
      if (parsed.addedTasks.length > 0) forbidden.push("--add-task");
      if (Object.keys(parsed.vars).length > 0) forbidden.push("--var");
      if (parsed.cwd !== undefined) forbidden.push("--cwd");
      if (parsed.model !== undefined) forbidden.push("--model");
      if (parsed.effort !== undefined) forbidden.push("--effort");
      if (parsed.timeoutSec !== undefined) forbidden.push("--timeout-sec");
      if (parsed.maxRetries !== undefined) forbidden.push("--max-retries");
      if (parsed.unrestricted !== undefined) forbidden.push("--unrestricted");
      if (forbidden.length > 0) {
        process.stderr.write(
          `task-runner: resuming an initialized run does not accept ${forbidden.join(", ")}\n`,
        );
        process.exit(3);
      }
    } else {
      const hasMessage = Boolean(parsed.message && parsed.message.trim().length > 0);
      const hasAddedTasks = parsed.addedTasks.length > 0;
      if (!hasMessage && !hasAddedTasks) {
        process.stderr.write(
          "task-runner: --resume-run requires a follow-up message or at least one --add-task\n",
        );
        process.exit(3);
      }
    }
  }

  const agentRef = parsed.agent ?? resumeTarget?.manifest.agent.sourcePath;
  if (!agentRef) {
    process.stderr.write("task-runner: --agent is required for fresh runs\n");
    process.stderr.write(HELP);
    process.exit(3);
  }

  let loaded: LoadedAgent;
  try {
    loaded = loadAgentConfig(agentRef);
  } catch (err) {
    if (err instanceof AgentNotFoundError || err instanceof AgentConfigError) {
      process.stderr.write(`task-runner: ${err.message}\n`);
    } else {
      process.stderr.write(`task-runner: ${(err as Error).message}\n`);
    }
    process.exit(3);
  }

  let loadedAssignment: LoadedAssignment | undefined;
  if (parsed.assignment !== undefined) {
    try {
      loadedAssignment = loadAssignmentConfig(parsed.assignment);
    } catch (err) {
      if (err instanceof AssignmentNotFoundError || err instanceof AssignmentConfigError) {
        process.stderr.write(`task-runner: ${err.message}\n`);
      } else {
        process.stderr.write(`task-runner: ${(err as Error).message}\n`);
      }
      process.exit(3);
    }
  }

  // Resolution order for which backend to use:
  //   1. CLI --backend override (fresh runs only)
  //   2. The prior manifest's `backend` (resume — must match what
  //      created the run, since session ids aren't portable across
  //      backends)
  //   3. The reloaded agent's `backend` field
  //
  // For execute-after-init the prior manifest's backend wins for the
  // same reason — init froze it.
  const backendId = parsed.backend ?? resumeTarget?.manifest.backend ?? loaded.config.backend;

  let backend: ReturnType<typeof resolveBackend>;
  try {
    backend = resolveBackend(backendId);
  } catch (err) {
    if (err instanceof UnknownBackendError) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  const isJson = parsed.outputFormat === "json";
  const noop = (_text: string): void => {};

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
    const outcome = await runAgent({
      loaded,
      loadedAssignment,
      cliVars: parsed.vars,
      backend,
      resume: resumeTarget,
      initialize: isInitCommand,
      bootstrapBackendSessionId: parsed.backendSessionId,
      abortSignal: abortController.signal,
      overrides: overridesFromParsedArgs(parsed),
      stderr: isJson ? noop : (text) => process.stderr.write(text),
      stdout: isJson ? noop : (text) => process.stdout.write(text),
    });
    if (isJson) {
      process.stdout.write(`${JSON.stringify(outcome.manifest, null, 2)}\n`);
    }
    process.exit(outcome.exitCode);
  } catch (err) {
    if (
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

function runStatus(parsed: ParsedArgs): never {
  // The positional run id/path lands in `parsed.message` because the
  // parser collects positionals into a single string. The status command
  // expects exactly one positional.
  const target = parsed.message?.trim();
  if (!target || target.length === 0) {
    process.stderr.write("task-runner: status requires a run id or workspace path\n");
    process.stderr.write(
      "Usage: task-runner status <id-or-path> [--output-format json] [--field name]...\n",
    );
    process.exit(3);
  }

  let resolved: ReturnType<typeof resolveResumeTarget>;
  try {
    resolved = resolveResumeTarget(target);
  } catch (err) {
    if (err instanceof ResumeError) {
      process.stderr.write(`task-runner: ${err.message}\n`);
    } else {
      process.stderr.write(`task-runner: ${(err as Error).message}\n`);
    }
    process.exit(3);
  }

  // For a `running` manifest, parse the workspace assignment.md so the
  // checklist reflects the agent's mid-attempt edits instead of the
  // last-persisted snapshot. Read-only — never written back. Failures
  // (file missing, parse errors) silently fall through to the manifest
  // snapshot.
  let liveOverlay: LiveTaskOverlay | undefined;
  if (resolved.manifest.status === "running") {
    try {
      const raw = readFileSync(resolved.manifest.assignmentPath, "utf8");
      const updates = parseAssignment(raw);
      if (updates.length > 0) {
        liveOverlay = new Map();
        for (const u of updates) {
          liveOverlay.set(u.taskId, { status: u.status, notes: u.notes });
        }
      }
    } catch {
      // workspace file missing or unreadable — fall back to manifest snapshot
    }
  }

  // Build the manifest view used for both text and JSON output. When a
  // live overlay applies, clone `finalTasks` and recompute the
  // completed count so JSON consumers see the live numbers too. The
  // original `resolved.manifest` is never mutated.
  const manifestView =
    liveOverlay !== undefined
      ? applyLiveOverlay(resolved.manifest, liveOverlay)
      : resolved.manifest;

  if (parsed.outputFormat === "json") {
    if (parsed.fields.length > 0) {
      const projection: Record<string, unknown> = {};
      const manifest = manifestView as unknown as Record<string, unknown>;
      const missing: string[] = [];
      for (const field of parsed.fields) {
        if (field in manifest) {
          projection[field] = manifest[field];
        } else {
          missing.push(field);
        }
      }
      if (missing.length > 0) {
        process.stderr.write(`task-runner: unknown manifest field(s): ${missing.join(", ")}\n`);
        process.exit(3);
      }
      process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(manifestView, null, 2)}\n`);
    }
  } else {
    if (parsed.fields.length > 0) {
      process.stderr.write("task-runner: --field requires --output-format json\n");
      process.exit(3);
    }
    process.stdout.write(renderManifestStatus(manifestView, { isLive: liveOverlay !== undefined }));
  }

  process.exit(0);
}

function runTaskCommand(parsed: ParsedArgs): never {
  if (parsed.subcommand === "set") {
    runTaskSet(parsed);
  }
  if (parsed.subcommand === "add") {
    runTaskAdd(parsed);
  }
  process.stderr.write(
    `task-runner: task command requires a subcommand: set | add (got "${parsed.subcommand ?? ""}")\n`,
  );
  process.stderr.write("Usage: task-runner task set <run-id> <task-id> [--status s] [--notes n]\n");
  process.stderr.write('       task-runner task add <run-id> --title "..."\n');
  process.exit(3);
}

// States in which `task set` / `task add` are allowed. Everything else is
// either `running` (live agent would race us) or an unreachable value.
const MUTATION_ALLOWED_STATUSES = new Set([
  "initialized",
  "success",
  "blocked",
  "exhausted",
  "aborted",
  "error",
]);

function resolveRunOrExit(target: string): ReturnType<typeof resolveResumeTarget> {
  try {
    return resolveResumeTarget(target);
  } catch (err) {
    if (err instanceof ResumeError) {
      process.stderr.write(`task-runner: ${err.message}\n`);
    } else {
      process.stderr.write(`task-runner: ${(err as Error).message}\n`);
    }
    process.exit(3);
  }
}

function requireMutableStatus(manifest: RunManifest): void {
  if (!MUTATION_ALLOWED_STATUSES.has(manifest.status)) {
    process.stderr.write(
      `task-runner: cannot mutate tasks on a ${manifest.status} run (task-runner task set/add is rejected while a run is in-flight)\n`,
    );
    process.exit(3);
  }
}

// Build a task Map from the manifest snapshot, then overlay any live
// status/notes edits present in the workspace assignment.md. Object
// insertion order on `finalTasks` preserves the run's original task
// order; live overlay can only modify status/notes on known ids.
function buildTaskMapFromManifest(manifest: RunManifest): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();
  for (const [id, snap] of Object.entries(manifest.finalTasks)) {
    tasks.set(id, {
      id: snap.id,
      title: snap.title,
      body: snap.body,
      status: snap.status,
      notes: snap.notes,
    });
  }

  try {
    const raw = readFileSync(manifest.assignmentPath, "utf8");
    const updates = parseAssignment(raw);
    if (updates.length > 0) mergeUpdates(tasks, updates);
  } catch {
    // workspace file missing or unreadable — fall back to manifest snapshot
  }

  return tasks;
}

function persistTaskMap(
  resolved: ReturnType<typeof resolveResumeTarget>,
  tasks: Map<string, TaskState>,
): void {
  const ordered = Array.from(tasks.values());
  writeFileSync(resolved.manifest.assignmentPath, renderAssignment(ordered), "utf8");
  resolved.manifest.finalTasks = snapshotTasks(tasks);
  resolved.manifest.tasksCompleted = ordered.filter((t) => t.status === "completed").length;
  resolved.manifest.tasksTotal = ordered.length;
  writeManifest(resolved.workspaceDir, resolved.manifest);
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

  if (parsed.taskStatus === undefined && parsed.taskNotes === undefined) {
    process.stderr.write("task-runner: task set requires at least one of --status / --notes\n");
    process.exit(3);
  }

  if (parsed.taskStatus !== undefined && !isValidStatus(parsed.taskStatus)) {
    process.stderr.write(
      `task-runner: invalid --status "${parsed.taskStatus}" — expected one of: ${VALID_STATUSES.join(", ")}\n`,
    );
    process.exit(3);
  }

  const resolved = resolveRunOrExit(runArg);
  requireMutableStatus(resolved.manifest);

  const tasks = buildTaskMapFromManifest(resolved.manifest);
  const target = tasks.get(taskId);
  if (!target) {
    process.stderr.write(
      `task-runner: task "${taskId}" not found in run ${resolved.manifest.runId}\n`,
    );
    process.exit(3);
  }

  if (parsed.taskStatus !== undefined) {
    target.status = parsed.taskStatus as TaskState["status"];
  }
  if (parsed.taskNotes !== undefined) {
    target.notes = parsed.taskNotes;
  }

  persistTaskMap(resolved, tasks);

  if (parsed.outputFormat === "json") {
    process.stdout.write(`${JSON.stringify(resolved.manifest.finalTasks[taskId], null, 2)}\n`);
  } else {
    process.stdout.write(
      `task-runner: updated ${taskId} (status=${target.status}) in run ${resolved.manifest.runId}\n`,
    );
  }
  process.exit(0);
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
  const title = parsed.taskTitle.trim();
  if (title.length === 0) {
    process.stderr.write("task-runner: task add: --title cannot be empty\n");
    process.exit(3);
  }
  if (title.length > 200) {
    process.stderr.write(
      `task-runner: task add: --title exceeds 200 characters (${title.length})\n`,
    );
    process.exit(3);
  }

  const resolved = resolveRunOrExit(runArg);
  requireMutableStatus(resolved.manifest);

  // Reload the run's agent (and assignment if present) so we can check
  // lockedFields. `tasks` in the union forbids any mutation that adds
  // new entries. We intentionally do NOT check this for `task set` —
  // status/notes are never a locked field.
  try {
    const agent = loadAgentConfig(resolved.manifest.agent.sourcePath);
    const assignment = resolved.manifest.assignment
      ? loadAssignmentConfig(resolved.manifest.assignment.sourcePath)
      : undefined;
    const locked = new Set<string>([
      ...agent.config.lockedFields,
      ...(assignment?.config.lockedFields ?? []),
    ]);
    if (locked.has("tasks")) {
      process.stderr.write(
        "task-runner: task add: the `tasks` field is locked for this run — cannot add tasks\n",
      );
      process.exit(3);
    }
  } catch (err) {
    if (
      err instanceof AgentNotFoundError ||
      err instanceof AgentConfigError ||
      err instanceof AssignmentNotFoundError ||
      err instanceof AssignmentConfigError
    ) {
      process.stderr.write(`task-runner: task add: cannot verify locked fields — ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  const tasks = buildTaskMapFromManifest(resolved.manifest);
  let newId: string;
  do {
    newId = `cli-${shortId()}`;
  } while (tasks.has(newId));

  tasks.set(newId, {
    id: newId,
    title,
    body: "",
    status: "pending",
    notes: "",
  });

  persistTaskMap(resolved, tasks);

  if (parsed.outputFormat === "json") {
    process.stdout.write(`${JSON.stringify(resolved.manifest.finalTasks[newId], null, 2)}\n`);
  } else {
    process.stdout.write(
      `task-runner: added task ${newId} "${title}" to run ${resolved.manifest.runId}\n`,
    );
  }
  process.exit(0);
}

main();
