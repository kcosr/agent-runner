#!/usr/bin/env node
import { claudeBackend } from "./backends/claude.js";
import { type ParsedArgs, overridesFromParsedArgs, parseArgs } from "./cli/parse-args.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  type LoadedAgent,
  loadAgentConfig,
} from "./config/loader.js";
import { ResumeError, resolveResumeTarget } from "./runner/manifest.js";
import {
  EmptyTaskListError,
  InvalidAddedTaskError,
  LockedFieldError,
  VarResolutionError,
  runAgent,
} from "./runner/run-loop.js";

const HELP = `Usage: task-runner run [--agent <name-or-path>] [options] [message]

Arguments:
  [message]               Positional text. For a fresh run, appended to
                          the agent's instructions (or used in place of
                          the agent's default \`message\` field). For a
                          resume run, required — sent as the sole prompt
                          for the new session.

Options:
  --agent <name|path>     Agent name (resolved against ./agents/<name>/agent.md
                          or $TASK_RUNNER_HOME/agents/<name>/agent.md) or a
                          direct path to an agent.md file. Required for fresh
                          runs; optional for --resume-run (taken from the
                          prior manifest if omitted).
  --resume-run <id|path>  Continue an existing run by its short id (e.g.
                          "k7m2xq") or a path to a workspace directory or
                          run.json file. Reads the prior manifest, reloads
                          the agent, normalizes non-completed tasks to
                          pending, and starts a new session within the
                          same workspace. Requires a positional message.
  --var <key>=<value>     Set an input variable (repeatable).
  --add-task <title>      Append a task to the agent's task list with the
                          given title (repeatable). IDs are auto-generated
                          as \`cli-<short-id>\`. Rejected if \`tasks\` is
                          listed in the agent's \`lockedFields\`.
  --cwd <path>            Override the agent's cwd.
  --model <id>            Override the agent's model.
  --effort <level>        Override effort level (low, medium, high, max).
  --timeout-sec <n>       Override the per-attempt timeout.
  --max-retries <n>       Override the max number of retries (default 3).
  --unrestricted          Pass --dangerously-skip-permissions to Claude.
  --output-format <fmt>   Output format: "text" (default) streams agent
                          text live to stdout and prints a summary to
                          stderr; "json" suppresses chrome and prints
                          the full run manifest to stdout at the end.
  --help, -h              Print this message.

Exit codes:
  0  All tasks completed successfully
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

  if (parsed.command !== "run") {
    process.stderr.write(`task-runner: unknown command "${parsed.command}"\n`);
    process.stderr.write(HELP);
    process.exit(3);
  }

  let resumeTarget: ReturnType<typeof resolveResumeTarget> | undefined;
  if (parsed.resumeRun !== undefined) {
    if (!parsed.message || parsed.message.trim().length === 0) {
      process.stderr.write("task-runner: --resume-run requires a follow-up message\n");
      process.exit(3);
    }
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

  const isJson = parsed.outputFormat === "json";
  const noop = (_text: string): void => {};
  try {
    const outcome = await runAgent({
      loaded,
      cliVars: parsed.vars,
      backend: claudeBackend,
      resume: resumeTarget,
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
      err instanceof EmptyTaskListError ||
      err instanceof InvalidAddedTaskError
    ) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`task-runner: ${(err as Error).message}\n`);
    process.exit(4);
  }
}

main();
