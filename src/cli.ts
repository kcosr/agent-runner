#!/usr/bin/env node
import { claudeBackend } from "./backends/claude.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  type LoadedAgent,
  loadAgentConfig,
} from "./config/loader.js";
import { LockedFieldError, VarResolutionError, runAgent } from "./runner/run-loop.js";

type OutputFormat = "text" | "json";

interface ParsedArgs {
  command: string;
  agent?: string;
  vars: Record<string, string>;
  cwd?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  timeoutSec?: number;
  unrestricted?: boolean;
  maxRetries?: number;
  outputFormat: OutputFormat;
  message?: string;
  showHelp: boolean;
}

const EFFORT_VALUES = ["low", "medium", "high", "max"] as const;
const OUTPUT_FORMATS = ["text", "json"] as const;

const HELP = `Usage: task-runner run --agent <name-or-path> [options] [message]

Arguments:
  [message]               Optional positional text appended to the agent's
                          instructions. Overrides the agent's default
                          \`message\` field if present, unless \`message\` is
                          listed in the agent's \`lockedFields\`.

Options:
  --agent <name|path>     Agent name (resolved against ./agents/<name>/agent.md
                          or $TASK_RUNNER_HOME/agents/<name>/agent.md) or a
                          direct path to an agent.md file.
  --var <key>=<value>     Set an input variable (repeatable).
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
  3  Config or validation error before any run started
  4  Backend invocation error
`;

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = {
    command: "",
    vars: {},
    outputFormat: "text",
    showHelp: false,
  };

  if (args.length === 0) {
    result.showHelp = true;
    return result;
  }
  if (args[0] === "-h" || args[0] === "--help") {
    result.showHelp = true;
    return result;
  }

  result.command = args.shift() ?? "";
  const positional: string[] = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === undefined) break;

    if (arg === "--help" || arg === "-h") {
      result.showHelp = true;
    } else if (arg === "--agent") {
      const next = args.shift();
      if (next === undefined) throw new Error("--agent requires a value");
      result.agent = next;
    } else if (arg === "--var") {
      const pair = args.shift();
      if (pair === undefined) throw new Error("--var requires key=value");
      const eq = pair.indexOf("=");
      if (eq < 0) throw new Error(`--var expected key=value, got "${pair}"`);
      result.vars[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg === "--cwd") {
      const next = args.shift();
      if (next === undefined) throw new Error("--cwd requires a value");
      result.cwd = next;
    } else if (arg === "--model") {
      const next = args.shift();
      if (next === undefined) throw new Error("--model requires a value");
      result.model = next;
    } else if (arg === "--effort") {
      const next = args.shift();
      if (next === undefined) throw new Error("--effort requires a value");
      if (!(EFFORT_VALUES as readonly string[]).includes(next)) {
        throw new Error(`--effort must be one of: ${EFFORT_VALUES.join(", ")}`);
      }
      result.effort = next as (typeof EFFORT_VALUES)[number];
    } else if (arg === "--timeout-sec") {
      const next = args.shift();
      if (next === undefined) throw new Error("--timeout-sec requires a number");
      const n = Number(next);
      if (Number.isNaN(n) || n <= 0) throw new Error("--timeout-sec must be a positive number");
      result.timeoutSec = n;
    } else if (arg === "--max-retries") {
      const next = args.shift();
      if (next === undefined) throw new Error("--max-retries requires a number");
      const n = Number(next);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error("--max-retries must be a non-negative integer");
      }
      result.maxRetries = n;
    } else if (arg === "--unrestricted") {
      result.unrestricted = true;
    } else if (arg === "--output-format") {
      const next = args.shift();
      if (next === undefined) throw new Error("--output-format requires a value");
      if (!(OUTPUT_FORMATS as readonly string[]).includes(next)) {
        throw new Error(`--output-format must be one of: ${OUTPUT_FORMATS.join(", ")}`);
      }
      result.outputFormat = next as OutputFormat;
    } else if (arg === "--") {
      positional.push(...args);
      break;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    result.message = positional.join(" ");
  }

  return result;
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

  if (parsed.command !== "run") {
    process.stderr.write(`task-runner: unknown command "${parsed.command}"\n`);
    process.stderr.write(HELP);
    process.exit(3);
  }
  if (!parsed.agent) {
    process.stderr.write("task-runner: --agent is required\n");
    process.stderr.write(HELP);
    process.exit(3);
  }

  let loaded: LoadedAgent;
  try {
    loaded = loadAgentConfig(parsed.agent);
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
      overrides: {
        cwd: parsed.cwd,
        model: parsed.model,
        effort: parsed.effort,
        message: parsed.message,
        timeoutSec: parsed.timeoutSec,
        unrestricted: parsed.unrestricted,
        maxRetries: parsed.maxRetries,
      },
      stderr: isJson ? noop : (text) => process.stderr.write(text),
      stdout: isJson ? noop : (text) => process.stdout.write(text),
    });
    if (isJson) {
      process.stdout.write(`${JSON.stringify(outcome.manifest, null, 2)}\n`);
    }
    process.exit(outcome.exitCode);
  } catch (err) {
    if (err instanceof VarResolutionError || err instanceof LockedFieldError) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`task-runner: ${(err as Error).message}\n`);
    process.exit(4);
  }
}

main();
