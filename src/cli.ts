#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { type TaskState, VALID_STATUSES, isValidStatus } from "./assignment/model.js";
import { parseAssignment } from "./assignment/parser.js";
import { UnknownBackendError, resolveBackend } from "./backends/registry.js";
import { type ParsedArgs, overridesFromParsedArgs, parseArgs } from "./cli/parse-args.js";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  type DefinitionKind,
  DefinitionListError,
  type LoadedAgent,
  type LoadedAssignment,
  listAgents,
  listAssignments,
  loadAgentConfig,
  loadAssignmentConfig,
  loadedAgentFromManifest,
  synthesizeAdHocAgent,
} from "./config/loader.js";
import {
  type ManifestStatus,
  ResumeError,
  type RunManifest,
  resolveResumeTarget,
  workspaceAssignmentPath,
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
import { loadWorkspaceTaskMap, persistWorkspaceTaskState } from "./runner/workspace-state.js";
import { shortId } from "./util/short-id.js";

const HELP = `Usage: task-runner <run|init|status|task|list|show> [options] [args]

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
  list <agents|assignments>
                          Enumerate available definitions from local
                          (./agents/ or ./assignments/) and global
                          ($TASK_RUNNER_HOME) roots. Read-only.
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
  --title <text>          (task add) Title for the new task.

Options:
  --agent <name|path>     Agent name (resolved against ./agents/<name>/agent.md
                          or $TASK_RUNNER_HOME/agents/<name>/agent.md) or a
                          direct path to an agent.md file. Optional on fresh
                          runs and init — when omitted, task-runner synthesizes
                          an ad-hoc agent from CLI overrides (in that case
                          --backend is required; every other field gets a
                          default). Forbidden with --resume-run: the agent
                          config is reconstructed from the frozen manifest
                          (no agent.md re-read).
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
                          manifest and reconstructs the agent from its
                          frozen fields (no re-read of the source agent.md
                          under the manifest-canonical design). Normalizes
                          non-completed tasks to pending and starts a new
                          session. Requires a follow-up message OR
                          --add-task, unless the prior manifest has
                          status=initialized (in which case the stored
                          pendingPrompt is executed as session 0 with NO
                          overrides — init deliberately froze them).

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

  if (isInitCommand && parsed.resumeRun !== undefined) {
    process.stderr.write("task-runner: init cannot be combined with --resume-run\n");
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

    // All override-validation for resume lives in one place so the
    // rules stay consistent and new fields get a single place to be
    // classified. See the override matrix in docs/design.md.
    const violation = validateResumeOverrides(resumeTarget.manifest, parsed);
    if (violation !== null) {
      process.stderr.write(`task-runner: ${violation}\n`);
      process.exit(3);
    }
  }

  // Agent resolution has three paths:
  //   1. Resume — reconstruct the LoadedAgent from the frozen
  //      manifest. `agent.md` is never re-read on resume, so a moved
  //      or edited source file has no effect on a resumed run.
  //   2. `--agent <name|path>` — load the on-disk agent file.
  //   3. No `--agent` flag, no resume target — synthesize an ad-hoc
  //      agent from CLI overrides. Requires `--backend`.
  let loaded: LoadedAgent;
  if (resumeTarget !== undefined) {
    loaded = loadedAgentFromManifest(resumeTarget.manifest);
  } else if (parsed.agent !== undefined) {
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
  } else {
    // Ad-hoc synthesis: --agent omitted on a fresh run or init.
    // Require --backend so we know which backend to dispatch to;
    // every other field gets a sensible default.
    if (parsed.backend === undefined) {
      process.stderr.write(
        "task-runner: --agent was omitted — --backend is required to synthesize an ad-hoc agent\n",
      );
      process.stderr.write(HELP);
      process.exit(3);
    }
    loaded = synthesizeAdHocAgent({
      backend: parsed.backend,
      model: parsed.model,
      effort: parsed.effort,
      timeoutSec: parsed.timeoutSec,
      unrestricted: parsed.unrestricted,
      cwd: parsed.cwd,
    });
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

  // Passive agents are never executed: task-runner acts as a sidecar
  // checklist service, and the agent is driven externally through
  // `task set` / `task add`. `init` is allowed (prepares the
  // workspace and prints the bootstrap). `run` — fresh or resume — is
  // rejected with a clear pointer to the right commands.
  if (parsed.command === "run" && backendId === "passive") {
    const runId = resumeTarget?.manifest.runId;
    const hint = runId
      ? `task-runner task set ${runId} <task-id> --status in_progress\n  task-runner status ${runId}`
      : "task-runner init --agent <passive-agent> --assignment <...>\n  task-runner task set <run-id> <task-id> --status in_progress";
    process.stderr.write(
      `task-runner: cannot run passive agent "${loaded.config.name}" — passive agents are driven externally via task commands. Use:\n  ${hint}\n`,
    );
    process.exit(3);
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

// Resume-time override policy. The manifest is the source of truth
// post-creation, so the rules here reflect what can legitimately
// change between sessions without corrupting the backend session or
// bypassing a frozen lock.
//
//   Regular resume (prior terminal state):
//     ALWAYS rejected:
//       --agent               — the manifest is the source of truth;
//                               passing it silently ignored would
//                               mislead users about whether their
//                               agent.md edits are taking effect
//       --assignment          — assignment is baked into the workspace
//       --backend             — backend is bound to the captured
//                               session id; can't change underneath
//       --backend-session-id  — the run already has one
//       --cwd                 — backend sessions are cwd-bound; a
//                               new cwd would invalidate the session
//                               id stored in the manifest. Create a
//                               fresh run if you need a different cwd
//       --var                 — prompts aren't re-composed from
//                               assignment vars on resume, so --var
//                               is silently a no-op today. Reject
//                               loudly instead.
//     Allowed (but still lock-checked via checkLockedFields):
//       --model, --effort, --timeout-sec, --max-retries,
//       --unrestricted, --session-name, --add-task, [message]
//     Required:
//       [message] OR at least one --add-task
//
//   Execute-after-init (prior status=initialized):
//     No overrides allowed, full stop. Init deliberately froze
//     everything; any subsequent change should be a fresh init.
//     The only valid call is `task-runner run --resume-run <id>`.
function validateResumeOverrides(manifest: RunManifest, parsed: ParsedArgs): string | null {
  const priorInitialized = manifest.status === "initialized";

  // Fields that are never valid with --resume-run regardless of
  // whether the prior state was initialized or terminal.
  if (parsed.agent !== undefined) {
    return "--agent cannot be combined with --resume-run (the agent is fixed on the run; under the manifest-canonical design, resume reads it from run.json instead of reloading agent.md)";
  }
  if (parsed.assignment !== undefined) {
    return "--assignment cannot be combined with --resume-run (the assignment is baked into the workspace; use --add-task to extend the task list)";
  }
  if (parsed.backend !== undefined) {
    return "--backend cannot be combined with --resume-run (backend is locked to the run that created the session)";
  }
  if (parsed.backendSessionId !== undefined) {
    return "--backend-session-id cannot be combined with --resume-run (the resume target already carries a backend session id)";
  }
  if (parsed.cwd !== undefined) {
    return "--cwd cannot be combined with --resume-run — backend sessions are bound to the cwd they were created in, so a different cwd would invalidate the captured session id. If you need a different cwd, create a fresh run instead.";
  }
  if (Object.keys(parsed.vars).length > 0) {
    return "--var cannot be combined with --resume-run — runtime vars are resolved from the assignment at first write and frozen into the manifest; they are not re-resolved on resume, so passing --var would silently no-op. Edit the assignment and create a fresh run if vars need to change.";
  }

  if (priorInitialized) {
    // Execute-after-init: no overrides allowed. Init deliberately
    // froze every resolvable field.
    const forbidden: string[] = [];
    if (parsed.message && parsed.message.trim().length > 0) forbidden.push("message");
    if (parsed.addedTasks.length > 0) forbidden.push("--add-task");
    if (parsed.model !== undefined) forbidden.push("--model");
    if (parsed.effort !== undefined) forbidden.push("--effort");
    if (parsed.timeoutSec !== undefined) forbidden.push("--timeout-sec");
    if (parsed.maxRetries !== undefined) forbidden.push("--max-retries");
    if (parsed.unrestricted !== undefined) forbidden.push("--unrestricted");
    if (parsed.sessionName !== undefined) forbidden.push("--session-name");
    if (forbidden.length > 0) {
      return `resuming an initialized run does not accept ${forbidden.join(", ")} — init froze these at creation. If you need different values, create a fresh run.`;
    }
    return null;
  }

  // Regular resume (non-initialized terminal state): at least one of
  // a follow-up message or an --add-task is required; the other
  // allowed overrides (model, effort, etc.) are vetted by
  // checkLockedFields downstream against manifest.lockedFields.
  const hasMessage = Boolean(parsed.message && parsed.message.trim().length > 0);
  const hasAddedTasks = parsed.addedTasks.length > 0;
  if (!hasMessage && !hasAddedTasks) {
    return "--resume-run requires a follow-up message or at least one --add-task";
  }
  return null;
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
      const raw = readFileSync(workspaceAssignmentPath(resolved.workspaceDir), "utf8");
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

const DEFINITION_KINDS: Record<string, DefinitionKind> = {
  agents: "agent",
  assignments: "assignment",
  agent: "agent",
  assignment: "assignment",
};

function runListCommand(parsed: ParsedArgs): never {
  const kindArg = parsed.subcommand;
  if (!kindArg || !(kindArg in DEFINITION_KINDS)) {
    process.stderr.write(
      `task-runner: list requires a kind: agents or assignments${kindArg ? ` (got "${kindArg}")` : ""}\n`,
    );
    process.stderr.write("Usage: task-runner list <agents|assignments> [--output-format json]\n");
    process.exit(3);
  }

  const kind = DEFINITION_KINDS[kindArg];
  let entries: ReturnType<typeof listAgents>;
  try {
    entries = kind === "agent" ? listAgents() : listAssignments();
  } catch (err) {
    if (err instanceof DefinitionListError) {
      process.stderr.write(`task-runner: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  if (parsed.outputFormat === "json") {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  } else {
    if (entries.length === 0) {
      process.stdout.write(`No ${kind} definitions found.\n`);
    } else {
      for (const entry of entries) {
        const tag = entry.root === "global" ? " (global)" : "";
        process.stdout.write(`  ${entry.name}${tag}\n`);
      }
    }
  }
  process.exit(0);
}

function runShowCommand(parsed: ParsedArgs): never {
  const kindArg = parsed.subcommand;
  if (!kindArg || (kindArg !== "agent" && kindArg !== "assignment")) {
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

  if (kindArg === "agent") {
    let loaded: LoadedAgent;
    try {
      loaded = loadAgentConfig(target);
    } catch (err) {
      if (err instanceof AgentNotFoundError || err instanceof AgentConfigError) {
        process.stderr.write(`task-runner: ${err.message}\n`);
      } else {
        process.stderr.write(`task-runner: ${(err as Error).message}\n`);
      }
      process.exit(3);
    }

    if (parsed.outputFormat === "json") {
      process.stdout.write(
        `${JSON.stringify({ config: loaded.config, instructions: loaded.instructions, sourcePath: loaded.sourcePath }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`Agent: ${loaded.config.name}\n`);
      process.stdout.write(`  backend:      ${loaded.config.backend}\n`);
      if (loaded.config.model) process.stdout.write(`  model:        ${loaded.config.model}\n`);
      if (loaded.config.effort) process.stdout.write(`  effort:       ${loaded.config.effort}\n`);
      process.stdout.write(`  timeoutSec:   ${loaded.config.timeoutSec}\n`);
      process.stdout.write(`  unrestricted: ${loaded.config.unrestricted}\n`);
      process.stdout.write(`  cwd:          ${loaded.config.cwd}\n`);
      if (loaded.config.lockedFields.length > 0) {
        process.stdout.write(`  lockedFields: ${loaded.config.lockedFields.join(", ")}\n`);
      }
      process.stdout.write(`  source:       ${loaded.sourcePath}\n`);
      if (loaded.instructions) {
        process.stdout.write(`\n${loaded.instructions}\n`);
      }
    }
  } else {
    let loaded: LoadedAssignment;
    try {
      loaded = loadAssignmentConfig(target);
    } catch (err) {
      if (err instanceof AssignmentNotFoundError || err instanceof AssignmentConfigError) {
        process.stderr.write(`task-runner: ${err.message}\n`);
      } else {
        process.stderr.write(`task-runner: ${(err as Error).message}\n`);
      }
      process.exit(3);
    }

    if (parsed.outputFormat === "json") {
      process.stdout.write(
        `${JSON.stringify({ config: loaded.config, instructions: loaded.instructions, sourcePath: loaded.sourcePath }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`Assignment: ${loaded.config.name}\n`);
      if (loaded.config.sessionName) {
        process.stdout.write(`  sessionName:  ${loaded.config.sessionName}\n`);
      }
      process.stdout.write(`  maxRetries:   ${loaded.config.maxRetries}\n`);
      if (loaded.config.tasks.length > 0) {
        process.stdout.write(`  tasks:        ${loaded.config.tasks.length}\n`);
        for (const t of loaded.config.tasks) {
          process.stdout.write(`    - ${t.id}: ${t.title}\n`);
        }
      }
      const varNames = Object.keys(loaded.config.vars);
      if (varNames.length > 0) {
        process.stdout.write(`  vars:         ${varNames.join(", ")}\n`);
      }
      if (loaded.config.lockedFields.length > 0) {
        process.stdout.write(`  lockedFields: ${loaded.config.lockedFields.join(", ")}\n`);
      }
      process.stdout.write(`  source:       ${loaded.sourcePath}\n`);
      if (loaded.instructions) {
        process.stdout.write(`\n${loaded.instructions}\n`);
      }
    }
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

const TERMINAL_MUTATION_STATUSES = new Set<ManifestStatus>([
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

function isTerminalNonPassiveRun(manifest: RunManifest): boolean {
  return manifest.backend !== "passive" && TERMINAL_MUTATION_STATUSES.has(manifest.status);
}

function persistTaskMap(
  resolved: ReturnType<typeof resolveResumeTarget>,
  tasks: Map<string, TaskState>,
): void {
  persistWorkspaceTaskState(resolved.manifest, tasks, {
    // Passive runs self-finalize: after any mutation, re-derive the
    // manifest status from the task map so scripts driving a passive
    // run can check `status == "success"` instead of computing the
    // counts themselves. Non-passive runs are untouched — their state
    // machine is still owned by the run-loop.
    beforeManifestWrite: (ordered, manifest) => {
      if (manifest.backend === "passive") {
        applyPassiveFinalization(manifest, ordered);
      }
    },
  });
}

// For a passive run, derive the next state from the task map:
//   - 0 tasks, or any pending / in_progress → "initialized"
//   - all terminal, at least one blocked      → "blocked" (exit code 2)
//   - all completed                           → "success" (exit code 0)
//
// Only stamp endedAt / exitCode on an **actual transition**. A
// notes-only edit on an already-terminal run must preserve the
// existing endedAt so the manifest's audit trail stays accurate
// (a post-hoc notes correction is not "the run finished again").
// Self-healing is still supported: reopening a completed task
// transitions back from a terminal state and clears endedAt/exitCode.
function applyPassiveFinalization(manifest: RunManifest, ordered: TaskState[]): void {
  let hasOpen = false;
  let hasBlocked = false;
  for (const t of ordered) {
    if (t.status === "pending" || t.status === "in_progress") hasOpen = true;
    if (t.status === "blocked") hasBlocked = true;
  }

  let derived: ManifestStatus;
  if (ordered.length === 0 || hasOpen) {
    derived = "initialized";
  } else if (hasBlocked) {
    derived = "blocked";
  } else {
    derived = "success";
  }

  // No-op on same-state calls (e.g. notes-only edit after the run
  // was already finalized). Preserves endedAt + exitCode.
  if (manifest.status === derived) {
    return;
  }

  manifest.status = derived;
  if (derived === "initialized") {
    manifest.endedAt = null;
    manifest.exitCode = null;
  } else if (derived === "blocked") {
    manifest.endedAt = new Date().toISOString();
    manifest.exitCode = 2;
  } else {
    manifest.endedAt = new Date().toISOString();
    manifest.exitCode = 0;
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

  const tasks = loadWorkspaceTaskMap(resolved.manifest, {
    // Terminal non-passive runs allow notes-only task edits; keep
    // preserving workspace note changes, but never import workspace
    // status drift back into the canonical manifest on those runs.
    applyStatus: !isTerminalNonPassiveRun(resolved.manifest),
  });
  const target = tasks.get(taskId);
  if (!target) {
    process.stderr.write(
      `task-runner: task "${taskId}" not found in run ${resolved.manifest.runId}\n`,
    );
    process.exit(3);
  }

  if (
    parsed.taskStatus !== undefined &&
    parsed.taskStatus !== target.status &&
    isTerminalNonPassiveRun(resolved.manifest)
  ) {
    process.stderr.write(
      "task-runner: cannot change task status on a terminal non-passive run; use task-runner run --resume-run <id> with a follow-up message instead\n",
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
  if (/[\r\n]/.test(title)) {
    process.stderr.write("task-runner: task add: --title must be a single line\n");
    process.exit(3);
  }

  const resolved = resolveRunOrExit(runArg);
  requireMutableStatus(resolved.manifest);

  if (isTerminalNonPassiveRun(resolved.manifest)) {
    process.stderr.write(
      'task-runner: cannot add tasks to a terminal non-passive run; use task-runner run --resume-run <id> --add-task "..." instead\n',
    );
    process.exit(3);
  }

  // Check the frozen manifest-level lockedFields instead of re-reading
  // the agent + assignment source files. Under the manifest-canonical
  // design, `manifest.lockedFields` is the authoritative union of
  // agent + assignment locks captured at first write. We intentionally
  // do NOT check this for `task set` — status/notes are never locked.
  if (resolved.manifest.lockedFields.includes("tasks")) {
    process.stderr.write(
      "task-runner: task add: the `tasks` field is locked for this run — cannot add tasks\n",
    );
    process.exit(3);
  }

  const tasks = loadWorkspaceTaskMap(resolved.manifest);
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
