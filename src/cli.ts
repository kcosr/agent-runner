#!/usr/bin/env node
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
import { ResumeError, resolveResumeTarget } from "./runner/manifest.js";
import {
  EmptyPromptError,
  InvalidAddedTaskError,
  LockedFieldError,
  VarResolutionError,
  runAgent,
} from "./runner/run-loop.js";

const HELP = `Usage: task-runner <run|init> [--agent <name-or-path>] [--assignment <name-or-path>] [options] [message]

Commands:
  run                     Execute an agent. Either a fresh run, a resume,
                          or execute-after-init (when --resume-run points
                          at an initialized run).
  init                    Prepare a run without invoking the backend. Writes
                          the workspace, seeds assignment.md from tasks, and
                          stores a manifest with status=initialized and a
                          frozen pendingPrompt. Resume later with
                          \`task-runner run --resume-run <id>\`.

Arguments:
  [message]               Positional text. For a fresh run or init,
                          appended as the "specific ask" at the end of the
                          prompt. For a resume run, sent as (part of) the
                          sole follow-up prompt for the new session.
                          Forbidden when resuming an initialized run.

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
  --model <id>            Override the agent's model.
  --effort <level>        Override effort level (off, minimal, low, medium,
                          high, xhigh, max).
  --timeout-sec <n>       Override the per-attempt timeout.
  --max-retries <n>       Override the max number of retries (default 3).
  --unrestricted          Bypass the backend's approval prompts.
  --output-format <fmt>   Output format: "text" (default) or "json".
  --help, -h              Print this message.

Exit codes:
  0  All tasks completed successfully (or 0-task run succeeded)
  1  Retries exhausted with incomplete tasks
  2  One or more tasks reported as blocked
  3  Config / validation / resume error before any run started
  4  Backend invocation error
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

  let backend: ReturnType<typeof resolveBackend>;
  try {
    backend = resolveBackend(loaded.config.backend);
  } catch (err) {
    if (err instanceof UnknownBackendError) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  const isJson = parsed.outputFormat === "json";
  const noop = (_text: string): void => {};
  try {
    const outcome = await runAgent({
      loaded,
      loadedAssignment,
      cliVars: parsed.vars,
      backend,
      resume: resumeTarget,
      initialize: isInitCommand,
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
      err instanceof EmptyPromptError
    ) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`task-runner: ${(err as Error).message}\n`);
    process.exit(4);
  }
}

main();
