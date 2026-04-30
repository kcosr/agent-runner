import type { AttachmentScope } from "@task-runner/core/contracts/attachments.js";
import type { BackendName } from "@task-runner/core/core/backends/types.js";
import { trimRunName } from "@task-runner/core/util/run-name.js";

type OutputFormat = "text" | "json";

export interface ParsedArgs {
  command: string;
  // Populated when `command` is a grouped command (e.g. "task"). Taken
  // from the token immediately after `command`.
  subcommand?: string;
  agent?: string;
  assignment?: string;
  resumeRun?: string;
  parentRun?: string;
  groupId?: string;
  runId?: string;
  dependencyRun?: string;
  dependencyGroupId?: string;
  backendSessionId?: string;
  vars: Record<string, string>;
  cwd?: string;
  backend?: BackendName;
  launcher?: string;
  model?: string;
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutSec?: number;
  unrestricted?: boolean;
  maxRetries?: number;
  name?: string;
  scheduleAt?: string;
  scheduleDelay?: string;
  scheduleCron?: string;
  scheduleTimezone?: string;
  scheduleMode?: "reuse" | "reset" | "clone";
  scheduleContinueOnFailure?: boolean;
  at?: string;
  delay?: string;
  cron?: string;
  timezone?: string;
  mode?: "reuse" | "reset" | "clone";
  continueOnFailure?: boolean;
  clear?: boolean;
  detach?: boolean;
  outputFormat: OutputFormat;
  outputFormatExplicit: boolean;
  message?: string;
  messageFile?: string;
  positionals: string[];
  addedTasks: string[];
  fields: string[];
  taskStatus?: string;
  taskNotes?: string;
  taskAppendText?: string;
  taskTitle?: string;
  taskBody?: string;
  attachmentName?: string;
  attachmentMimeType?: string;
  attachmentScope?: AttachmentScope;
  connect?: string;
  connectHost?: string;
  connectLocalPort?: string;
  listen?: string;
  includeArchived?: boolean;
  limit?: number;
  repo?: string;
  global?: boolean;
  showHelp: boolean;
}

const EFFORT_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const OUTPUT_FORMATS = ["text", "json"] as const;
const ATTACHMENT_SCOPE_VALUES = ["run", "group"] as const;
const SCHEDULE_MODE_VALUES = ["reuse", "reset", "clone"] as const;
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = {
    command: "",
    vars: {},
    outputFormat: "text",
    outputFormatExplicit: false,
    positionals: [],
    addedTasks: [],
    fields: [],
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

  // Grouped commands shift one more token as their subcommand so that
  // `task set <run> <task>` parses cleanly without colliding with the
  // positional collector below. Plain `run ...` keeps its existing
  // positional behavior unless the next token is one of the explicit
  // grouped run-management subcommands.
  if (
    result.command === "task" ||
    result.command === "list" ||
    result.command === "show" ||
    result.command === "attachment"
  ) {
    const next = args[0];
    if (next !== undefined && !next.startsWith("-")) {
      result.subcommand = args.shift();
    }
  } else if (
    result.command === "run" &&
    (args[0] === "status" ||
      args[0] === "audit" ||
      args[0] === "brief" ||
      args[0] === "reconfigure" ||
      args[0] === "ready" ||
      args[0] === "queue-message" ||
      args[0] === "queued-messages" ||
      args[0] === "remove-queued-message" ||
      args[0] === "schedule" ||
      args[0] === "reset" ||
      args[0] === "archive" ||
      args[0] === "unarchive" ||
      args[0] === "delete" ||
      args[0] === "set-name" ||
      args[0] === "set-note" ||
      args[0] === "clear-note" ||
      args[0] === "pin" ||
      args[0] === "unpin" ||
      args[0] === "set-group" ||
      args[0] === "clear-group" ||
      args[0] === "set-backend-session" ||
      args[0] === "clear-backend-session" ||
      args[0] === "add-dep" ||
      args[0] === "remove-dep" ||
      args[0] === "clear-deps")
  ) {
    result.subcommand = args.shift();
  }

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
    } else if (arg === "--parent-run") {
      const next = args.shift();
      if (next === undefined) throw new Error("--parent-run requires a value");
      if (next.trim().length === 0) throw new Error("--parent-run cannot be empty");
      result.parentRun = next;
    } else if (arg === "--group-id") {
      const next = args.shift();
      if (next === undefined) throw new Error("--group-id requires a value");
      if (next.trim().length === 0) throw new Error("--group-id cannot be empty");
      result.groupId = next;
    } else if (arg === "--run-id") {
      const next = args.shift();
      if (next === undefined) throw new Error("--run-id requires a value");
      if (next.trim().length === 0) throw new Error("--run-id cannot be empty");
      result.runId = next;
    } else if (arg === "--run") {
      const next = args.shift();
      if (next === undefined) throw new Error("--run requires a value");
      if (next.trim().length === 0) throw new Error("--run cannot be empty");
      result.dependencyRun = next;
    } else if (arg === "--group") {
      const next = args.shift();
      if (next === undefined) throw new Error("--group requires a value");
      if (next.trim().length === 0) throw new Error("--group cannot be empty");
      result.dependencyGroupId = next;
    } else if (arg === "--backend-session-id") {
      const next = args.shift();
      if (next === undefined) throw new Error("--backend-session-id requires a value");
      if (next.trim().length === 0) throw new Error("--backend-session-id cannot be empty");
      result.backendSessionId = next;
    } else if (arg === "--assignment") {
      const next = args.shift();
      if (next === undefined) throw new Error("--assignment requires a value");
      result.assignment = next;
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
    } else if (arg === "--message-file") {
      const next = args.shift();
      if (next === undefined) throw new Error("--message-file requires a value");
      if (next.trim().length === 0) throw new Error("--message-file cannot be empty");
      result.messageFile = next;
    } else if (arg === "--cwd") {
      const next = args.shift();
      if (next === undefined) throw new Error("--cwd requires a value");
      result.cwd = next;
    } else if (arg === "--repo") {
      const next = args.shift();
      if (next === undefined) throw new Error("--repo requires a value");
      result.repo = next;
    } else if (arg === "--global") {
      result.global = true;
    } else if (arg === "--backend") {
      const next = args.shift();
      if (next === undefined) throw new Error("--backend requires a value");
      if (next.trim().length === 0) throw new Error("--backend cannot be empty");
      result.backend = next;
    } else if (arg === "--launcher") {
      const next = args.shift();
      if (next === undefined) throw new Error("--launcher requires a value");
      if (next.trim().length === 0) throw new Error("--launcher cannot be empty");
      result.launcher = next;
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
    } else if (arg === "--name") {
      const next = args.shift();
      if (next === undefined) throw new Error("--name requires a value");
      if (result.command === "attachment") {
        if (next.trim().length === 0) {
          throw new Error("--name cannot be empty");
        }
        result.attachmentName = next;
      } else {
        try {
          result.name = trimRunName(next);
        } catch {
          throw new Error("--name cannot be empty");
        }
      }
    } else if (arg === "--schedule-at") {
      const next = args.shift();
      if (next === undefined) throw new Error("--schedule-at requires a value");
      result.scheduleAt = next;
    } else if (arg === "--schedule-delay") {
      const next = args.shift();
      if (next === undefined) throw new Error("--schedule-delay requires a value");
      result.scheduleDelay = next;
    } else if (arg === "--schedule-cron") {
      const next = args.shift();
      if (next === undefined) throw new Error("--schedule-cron requires a value");
      result.scheduleCron = next;
    } else if (arg === "--schedule-timezone") {
      const next = args.shift();
      if (next === undefined) throw new Error("--schedule-timezone requires a value");
      result.scheduleTimezone = next;
    } else if (arg === "--schedule-mode") {
      const next = args.shift();
      if (next === undefined) throw new Error("--schedule-mode requires a value");
      if (!(SCHEDULE_MODE_VALUES as readonly string[]).includes(next)) {
        throw new Error(`--schedule-mode must be one of: ${SCHEDULE_MODE_VALUES.join(", ")}`);
      }
      result.scheduleMode = next as (typeof SCHEDULE_MODE_VALUES)[number];
    } else if (arg === "--schedule-continue-on-failure") {
      result.scheduleContinueOnFailure = true;
    } else if (arg === "--at") {
      const next = args.shift();
      if (next === undefined) throw new Error("--at requires a value");
      result.at = next;
    } else if (arg === "--delay") {
      const next = args.shift();
      if (next === undefined) throw new Error("--delay requires a value");
      result.delay = next;
    } else if (arg === "--cron") {
      const next = args.shift();
      if (next === undefined) throw new Error("--cron requires a value");
      result.cron = next;
    } else if (arg === "--timezone") {
      const next = args.shift();
      if (next === undefined) throw new Error("--timezone requires a value");
      result.timezone = next;
    } else if (arg === "--mode") {
      const next = args.shift();
      if (next === undefined) throw new Error("--mode requires a value");
      if (!(SCHEDULE_MODE_VALUES as readonly string[]).includes(next)) {
        throw new Error(`--mode must be one of: ${SCHEDULE_MODE_VALUES.join(", ")}`);
      }
      result.mode = next as (typeof SCHEDULE_MODE_VALUES)[number];
    } else if (arg === "--continue-on-failure") {
      result.continueOnFailure = true;
    } else if (arg === "--mime-type") {
      const next = args.shift();
      if (next === undefined) throw new Error("--mime-type requires a value");
      if (next.trim().length === 0) throw new Error("--mime-type cannot be empty");
      result.attachmentMimeType = next;
    } else if (arg === "--scope") {
      const next = args.shift();
      if (next === undefined) throw new Error("--scope requires a value");
      if (!(ATTACHMENT_SCOPE_VALUES as readonly string[]).includes(next)) {
        throw new Error(`--scope must be one of: ${ATTACHMENT_SCOPE_VALUES.join(", ")}`);
      }
      result.attachmentScope = next as AttachmentScope;
    } else if (arg === "--clear") {
      result.clear = true;
    } else if (arg === "--detach") {
      result.detach = true;
    } else if (arg === "--field") {
      const next = args.shift();
      if (next === undefined) throw new Error("--field requires a value");
      if (next.trim().length === 0) throw new Error("--field cannot be empty");
      result.fields.push(next);
    } else if (arg === "--status") {
      const next = args.shift();
      if (next === undefined) throw new Error("--status requires a value");
      result.taskStatus = next;
    } else if (arg === "--notes") {
      const next = args.shift();
      if (next === undefined) throw new Error("--notes requires a value");
      result.taskNotes = next;
    } else if (arg === "--text") {
      const next = args.shift();
      if (next === undefined) throw new Error("--text requires a value");
      result.taskAppendText = next;
    } else if (arg === "--title") {
      const next = args.shift();
      if (next === undefined) throw new Error("--title requires a value");
      result.taskTitle = next;
    } else if (arg === "--body") {
      const next = args.shift();
      if (next === undefined) throw new Error("--body requires a value");
      result.taskBody = next;
    } else if (arg === "--output-format") {
      const next = args.shift();
      if (next === undefined) throw new Error("--output-format requires a value");
      if (!(OUTPUT_FORMATS as readonly string[]).includes(next)) {
        throw new Error(`--output-format must be one of: ${OUTPUT_FORMATS.join(", ")}`);
      }
      result.outputFormatExplicit = true;
      result.outputFormat = next as OutputFormat;
    } else if (arg === "--connect") {
      const next = args.shift();
      if (next === undefined) throw new Error("--connect requires a value");
      result.connect = next;
    } else if (arg === "--connect-host") {
      const next = args.shift();
      if (next === undefined) throw new Error("--connect-host requires a value");
      result.connectHost = next;
    } else if (arg === "--connect-local-port") {
      const next = args.shift();
      if (next === undefined) throw new Error("--connect-local-port requires a value");
      result.connectLocalPort = next;
    } else if (arg === "--listen") {
      const next = args.shift();
      if (next === undefined) throw new Error("--listen requires a value");
      result.listen = next;
    } else if (arg === "--include-archived") {
      result.includeArchived = true;
    } else if (arg === "--limit") {
      const next = args.shift();
      if (next === undefined) throw new Error("--limit requires a value");
      const n = Number(next);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      result.limit = n;
    } else if (arg === "--") {
      positional.push(...args);
      break;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  result.positionals = positional;
  if (
    result.command === "run" &&
    (result.subcommand === "reconfigure" || result.subcommand === "queue-message")
  ) {
    if (positional.length > 1) {
      result.message = positional.slice(1).join(" ");
    }
  } else if (positional.length > 0) {
    result.message = positional.join(" ");
  }

  return result;
}

export function overridesFromParsedArgs(parsed: ParsedArgs) {
  return {
    cwd: parsed.cwd,
    backend: parsed.backend,
    launcher: parsed.launcher,
    model: parsed.model,
    effort: parsed.effort,
    message: parsed.message,
    name: parsed.name,
    timeoutSec: parsed.timeoutSec,
    unrestricted: parsed.unrestricted,
    maxRetries: parsed.maxRetries,
    addedTasks: parsed.addedTasks.length > 0 ? parsed.addedTasks : undefined,
    schedule:
      parsed.scheduleAt !== undefined ||
      parsed.scheduleDelay !== undefined ||
      parsed.scheduleCron !== undefined ||
      parsed.scheduleTimezone !== undefined ||
      parsed.scheduleMode !== undefined ||
      parsed.scheduleContinueOnFailure !== undefined
        ? {
            at: parsed.scheduleAt,
            delay: parsed.scheduleDelay,
            cron: parsed.scheduleCron,
            timezone: parsed.scheduleTimezone,
            mode: parsed.scheduleMode,
            continueOnFailure: parsed.scheduleContinueOnFailure,
          }
        : undefined,
  };
}
