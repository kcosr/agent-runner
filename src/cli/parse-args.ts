export type OutputFormat = "text" | "json";

export interface ParsedArgs {
  command: string;
  agent?: string;
  resumeRun?: string;
  vars: Record<string, string>;
  cwd?: string;
  model?: string;
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutSec?: number;
  unrestricted?: boolean;
  maxRetries?: number;
  outputFormat: OutputFormat;
  message?: string;
  addedTasks: string[];
  showHelp: boolean;
}

const EFFORT_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const OUTPUT_FORMATS = ["text", "json"] as const;

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = {
    command: "",
    vars: {},
    outputFormat: "text",
    addedTasks: [],
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
    } else if (arg === "--resume-run") {
      const next = args.shift();
      if (next === undefined) throw new Error("--resume-run requires a value");
      result.resumeRun = next;
    } else if (arg === "--var") {
      const pair = args.shift();
      if (pair === undefined) throw new Error("--var requires key=value");
      const eq = pair.indexOf("=");
      if (eq < 0) throw new Error(`--var expected key=value, got "${pair}"`);
      result.vars[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg === "--add-task") {
      const next = args.shift();
      if (next === undefined) throw new Error("--add-task requires a task title");
      result.addedTasks.push(next);
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

export function overridesFromParsedArgs(parsed: ParsedArgs) {
  return {
    cwd: parsed.cwd,
    model: parsed.model,
    effort: parsed.effort,
    message: parsed.message,
    timeoutSec: parsed.timeoutSec,
    unrestricted: parsed.unrestricted,
    maxRetries: parsed.maxRetries,
    addedTasks: parsed.addedTasks.length > 0 ? parsed.addedTasks : undefined,
  };
}
