import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { updateTask as updateTaskViaApp } from "../packages/core/dist/app/service.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import {
  drainQueuedResumeMessages,
  queueResumeMessage,
  readyRun,
  removeQueuedResumeMessage,
} from "../packages/core/dist/core/commands/service.js";
import { resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import {
  appendRunControllerDetachedEvent,
  appendRunControllerReconciledEvent,
  readRunAuditHistory,
  systemRunEventContext,
} from "../packages/core/dist/core/run/run-events.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import {
  completeAllTasksFromPrompt,
  runIdFromPrompt,
  sharedRuntimeEnv,
  updateTasksForPrompt,
  withEnv,
  withSharedRuntimeEnv,
} from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

const ACTIVE_AGENT = `---
schemaVersion: 1
name: audit-active
backend: claude
model: claude-sonnet-4-6
---
Audit active agent.
`;

const PASSIVE_AGENT = `---
schemaVersion: 1
name: audit-passive
backend: passive
---
Audit passive agent.
`;

const ACTIVE_ASSIGNMENT = `---
schemaVersion: 1
name: audit-active-work
maxRetries: 1
tasks:
  - id: t1
    title: First
    body: Do thing one.
  - id: t2
    title: Second
    body: Do thing two.
---
Audit active assignment.
`;

const PASSIVE_ASSIGNMENT = `---
schemaVersion: 1
name: audit-passive-work
tasks:
  - id: t1
    title: First
    body: Do thing one.
  - id: t2
    title: Second
    body: Do thing two.
---
Audit passive assignment.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-audit-log-"));
}

function writeAgent(baseDir, name, body) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), body);
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "assignment.md"), body);
}

function writeNamedHook(baseDir, name, body) {
  const dir = join(baseDir, "hooks", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hook.ts"), body);
}

function writeAuditBundle(baseDir) {
  writeAgent(baseDir, "audit-active", ACTIVE_AGENT);
  writeAgent(baseDir, "audit-passive", PASSIVE_AGENT);
  writeAssignment(baseDir, "audit-active-work", ACTIVE_ASSIGNMENT);
  writeAssignment(baseDir, "audit-passive-work", PASSIVE_ASSIGNMENT);
}

function mockBackend(handler, id = "mock") {
  return {
    id,
    invoke: handler,
  };
}

async function runIn(baseDir, opts) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(opts.agentName, baseDir);
    const loadedAssignment = opts.resume
      ? undefined
      : loadAssignmentConfig(opts.assignmentName, baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: opts.backend,
        initialize: opts.initialize,
        resume: opts.resume,
        overrides: opts.overrides,
        bootstrapBackendSessionId: opts.bootstrapBackendSessionId,
        execution: opts.execution,
        resumeFailureDetector: opts.resumeFailureDetector,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

function runCli(args, opts = {}) {
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCliResult(args, opts = {}) {
  return spawnSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()) },
    encoding: "utf8",
  });
}

function readAuditPath(workspaceDir) {
  return join(workspaceDir, "run-events.jsonl");
}

function readAuditRaw(workspaceDir) {
  return readFileSync(readAuditPath(workspaceDir), "utf8");
}

function readAuditRecords(workspaceDir) {
  const raw = readAuditRaw(workspaceDir).trim();
  if (raw.length === 0) {
    return [];
  }
  return raw.split("\n").map((line) => JSON.parse(line));
}

function readAuditHistory(workspaceDir, runId, options = {}) {
  return readRunAuditHistory({
    workspaceDir,
    runId,
    limit: options.limit,
  });
}

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("audit log is created lazily for a logless run and task updates stay compact", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const init = await runIn(dir, {
    agentName: "audit-passive",
    assignmentName: "audit-passive-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }, "passive"),
    initialize: true,
  });

  const auditPath = readAuditPath(init.workspaceDir);
  assert.ok(existsSync(auditPath));
  unlinkSync(auditPath);
  assert.equal(existsSync(auditPath), false);

  runCli(["task", "set", init.runId, "t1", "--status", "in_progress"], { cwd: dir });

  const records = readAuditRecords(init.workspaceDir);
  assert.equal(records.length, 1);
  assert.equal(records[0].schemaVersion, 2);
  assert.equal(records[0].cursor, 1);
  assert.equal(records[0].runId, init.runId);
  assert.equal(records[0].eventType, "task.updated");
  assert.equal(records[0].source, "task_command");
  assert.equal(records[0].hostMode, "embedded");
  assert.equal(records[0].taskId, "t1");
  assert.equal(records[0].taskTitle, "First");
  assert.equal(records[0].command, "set");
  assert.equal(records[0].statusBefore, "pending");
  assert.equal(records[0].statusAfter, "in_progress");
  assert.equal(records[0].notesChanged, false);
  const history = readAuditHistory(init.workspaceDir, init.runId);
  assert.equal(history.lastCursor, 1);
  assert.equal(history.malformedCount, 0);
  assert.deepEqual(history.events, [
    {
      runId: init.runId,
      cursor: 1,
      event: {
        type: "task.updated",
        recordedAt: records[0].recordedAt,
        source: "task_command",
        hostMode: "embedded",
        fields: {
          taskId: "t1",
          taskTitle: "First",
          command: "set",
          statusBefore: "pending",
          statusAfter: "in_progress",
          notesChanged: false,
        },
      },
    },
  ]);
  assert.equal(readAuditRaw(init.workspaceDir).includes("Do thing one."), false);
});

test("terminal non-passive status edits emit normal task.updated audit records", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const init = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }),
    initialize: true,
  });
  patchManifest(init.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.endedAt = "2026-04-20T10:00:00.000Z";
    manifest.exitCode = 0;
  });

  runCli(["task", "set", init.runId, "t1", "--status", "in_progress"], { cwd: dir });

  const records = readAuditRecords(init.workspaceDir);
  const updated = records.at(-1);
  assert.equal(updated.eventType, "task.updated");
  assert.equal(updated.source, "task_command");
  assert.equal(updated.taskId, "t1");
  assert.equal(updated.taskTitle, "First");
  assert.equal(updated.command, "set");
  assert.equal(updated.statusBefore, "pending");
  assert.equal(updated.statusAfter, "in_progress");
  assert.equal(updated.notesChanged, false);

  const history = readAuditHistory(init.workspaceDir, init.runId, { limit: 1 });
  assert.equal(history.events[0]?.event.type, "task.updated");
  assert.deepEqual(history.events[0]?.event.fields, {
    taskId: "t1",
    taskTitle: "First",
    command: "set",
    statusBefore: "pending",
    statusAfter: "in_progress",
    notesChanged: false,
  });
});

test("audit history uses last persisted cursor and skips malformed rows", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const init = await runIn(dir, {
    agentName: "audit-passive",
    assignmentName: "audit-passive-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }, "passive"),
    initialize: true,
  });

  runCli(["task", "set", init.runId, "t1", "--status", "in_progress"], { cwd: dir });
  runCli(["task", "append-notes", init.runId, "t1", "--text", "waiting"], { cwd: dir });
  writeFileSync(
    readAuditPath(init.workspaceDir),
    `${readAuditRaw(init.workspaceDir)}{"schemaVersion":1}\nnot-json\n`,
  );

  const history = readAuditHistory(init.workspaceDir, init.runId, { limit: 1 });
  assert.equal(history.lastCursor, 3);
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0]?.cursor, 3);
  assert.equal(history.events[0]?.event.type, "task.updated");
  assert.equal(history.events[0]?.event.fields.command, "append_notes");
  assert.equal(history.malformedCount, 2);
});

test("execute-after-init appends ordered created/started/attempt/finished records and omits transcripts", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const init = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }),
    initialize: true,
    bootstrapBackendSessionId: "bootstrap-thread",
  });
  withSharedRuntimeEnv(dir, () => readyRun(init.runId));

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(init.runId));
  const resumed = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async (ctx) => {
      assert.equal(ctx.resumeSessionId, "bootstrap-thread");
      completeAllTasksFromPrompt(ctx.prompt, dir);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "bootstrap-thread",
        transcript: "secret transcript",
        rawStdout: "stdout-secret",
        rawStderr: "stderr-secret",
      };
    }),
    resume: target,
  });

  const records = readAuditRecords(resumed.workspaceDir);
  assert.deepEqual(
    records.map((record) => record.eventType),
    [
      "run.created",
      "run.backend_session_updated",
      "run.ready",
      "run.started",
      "run.attempt_recorded",
      "run.finished",
    ],
  );
  assert.deepEqual(
    records.map((record) => record.cursor),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(records[0].initialStatus, "initialized");
  assert.equal(records[1].reason, "bootstrap_import");
  assert.equal(records[2].previousStatus, "initialized");
  assert.equal(records[3].backendSessionIdAtStart, "bootstrap-thread");
  assert.equal(records[4].backendSessionIdCaptured, "bootstrap-thread");
  assert.equal(records[5].terminalStatus, "success");
  const raw = readAuditRaw(resumed.workspaceDir);
  assert.equal(raw.includes("secret transcript"), false);
  assert.equal(raw.includes("stdout-secret"), false);
  assert.equal(raw.includes("stderr-secret"), false);
  const attemptLog = JSON.parse(
    readFileSync(join(resumed.workspaceDir, resumed.manifest.attemptRecords[0].logPath), "utf8"),
  );
  assert.equal("stdout" in attemptLog, false);
  assert.equal(attemptLog.stderr, "stderr-secret");
});

test("stdout sidecars stay out of compact audit records and attempt JSON", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);

  const outcome = await withEnv({ AGENT_RUNNER_CAPTURE_BACKEND_STDOUT: "true" }, () =>
    runIn(dir, {
      agentName: "audit-active",
      assignmentName: "audit-active-work",
      backend: mockBackend(async (ctx) => {
        completeAllTasksFromPrompt(ctx.prompt, dir);
        ctx.onRawStdoutLine?.("stdout-secret\n");
        ctx.onRawStdoutLine?.("stdout-partial-secret");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "session-with-stdout",
          transcript: "secret transcript",
          rawStdout: "returned-stdout-secret",
          rawStderr: "stderr-secret",
        };
      }),
    }),
  );

  const attemptLog = JSON.parse(
    readFileSync(join(outcome.workspaceDir, outcome.manifest.attemptRecords[0].logPath), "utf8"),
  );
  assert.equal("stdout" in attemptLog, false);
  assert.equal(attemptLog.stderr, "stderr-secret");
  assert.equal(
    readFileSync(join(outcome.workspaceDir, "attempts", "01.stdout.log"), "utf8"),
    "stdout-secret\nstdout-partial-secret",
  );
  const rawAudit = readAuditRaw(outcome.workspaceDir);
  assert.equal(rawAudit.includes("stdout-secret"), false);
  assert.equal(rawAudit.includes("stdout-partial-secret"), false);
  assert.equal(rawAudit.includes("returned-stdout-secret"), false);
});

test("hook executions append compact run.hook_recorded records for prepare and attempt phases", async () => {
  const dir = tempDir();
  writeAgent(dir, "audit-active", ACTIVE_AGENT);
  writeAssignment(
    dir,
    "audit-active-work",
    `---
schemaVersion: 1
name: audit-active-work
maxRetries: 1
hooks:
  prepare:
    - name: audit-prepare
  beforeAttempt:
    - name: audit-before
  afterAttempt:
    - name: audit-after
tasks:
  - id: t1
    title: First
---
Audit active assignment.
`,
  );
  writeNamedHook(
    dir,
    "audit-prepare",
    `export default {
  name: "audit-prepare",
  prepare() {
    return {
      action: "continue",
      mutate: { note: "prepared-for-audit" },
    };
  },
};
`,
  );
  writeNamedHook(
    dir,
    "audit-before",
    `export default {
  name: "audit-before",
  beforeAttempt() {
    return { action: "continue" };
  },
};
`,
  );
  writeNamedHook(
    dir,
    "audit-after",
    `export default {
  name: "audit-after",
  afterAttempt() {
    return { action: "continue" };
  },
};
`,
  );

  const outcome = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt, dir);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "hook-audit-thread",
        transcript: "",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const hookEvents = readAuditRecords(outcome.workspaceDir).filter(
    (record) => record.eventType === "run.hook_recorded",
  );
  assert.equal(hookEvents.length, 3);
  assert.deepEqual(
    hookEvents.map((record) => ({
      phase: record.phase,
      hookId: record.hookId,
      outcome: record.outcome,
      sessionIndex: record.sessionIndex ?? null,
      attemptNumber: record.attemptNumber ?? null,
      taskId: record.taskId ?? null,
      summary: record.summary ?? null,
    })),
    [
      {
        phase: "prepare",
        hookId: "prepare:0:audit-prepare",
        outcome: "continue",
        sessionIndex: null,
        attemptNumber: null,
        taskId: null,
        summary: null,
      },
      {
        phase: "beforeAttempt",
        hookId: "beforeAttempt:0:audit-before",
        outcome: "continue",
        sessionIndex: 0,
        attemptNumber: 1,
        taskId: null,
        summary: null,
      },
      {
        phase: "afterAttempt",
        hookId: "afterAttempt:0:audit-after",
        outcome: "continue",
        sessionIndex: 0,
        attemptNumber: 1,
        taskId: null,
        summary: null,
      },
    ],
  );
  for (const record of hookEvents) {
    assert.equal(typeof record.startedAt, "string");
    assert.equal(typeof record.endedAt, "string");
    assert.equal(record.source, "system");
    assert.equal(record.hostMode, "embedded");
  }
});

test("fresh run and later resume append backend capture and resumed-session audit records", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const first = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async (ctx) => {
      updateTasksForPrompt(
        ctx.prompt,
        {
          t1: { status: "completed" },
          t2: { status: "blocked", notes: "db is down" },
        },
        dir,
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "captured-thread",
        transcript: "blocked transcript",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const firstRecords = readAuditRecords(first.workspaceDir);
  assert.deepEqual(
    firstRecords.map((record) => record.eventType),
    [
      "run.created",
      "run.started",
      "run.attempt_recorded",
      "run.backend_session_updated",
      "run.finished",
    ],
  );
  assert.equal(firstRecords[3].reason, "backend_capture");
  assert.equal(firstRecords[4].terminalStatus, "blocked");

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId));
  const second = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async (ctx) => {
      assert.equal(ctx.resumeSessionId, "captured-thread");
      patchManifest(first.workspaceDir, (manifest) => {
        manifest.finalTasks.t1.status = "completed";
        manifest.finalTasks.t2.status = "completed";
        manifest.finalTasks.t2.notes = "done";
        manifest.tasksCompleted = 2;
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "captured-thread",
        transcript: "fixed transcript",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    resume: target,
    overrides: { message: "db is back" },
  });

  const records = readAuditRecords(second.workspaceDir);
  assert.deepEqual(
    records.slice(-3).map((record) => record.eventType),
    ["run.resumed", "run.attempt_recorded", "run.finished"],
  );
  assert.equal(records.at(-3).backendSessionIdAtStart, "captured-thread");
  assert.equal(records.at(-2).backendSessionIdCaptured, "captured-thread");
  assert.equal(records.at(-1).terminalStatus, "success");
  assert.equal(readAuditRaw(second.workspaceDir).includes("fixed transcript"), false);
});

test("retrying events are recorded before a successful second attempt", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  let invocationCount = 0;

  const outcome = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async (ctx) => {
      invocationCount += 1;
      if (invocationCount === 1) {
        updateTasksForPrompt(
          ctx.prompt,
          {
            t1: { status: "completed" },
          },
          dir,
        );
      } else {
        completeAllTasksFromPrompt(ctx.prompt, dir);
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "retry-thread",
        transcript: "",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const records = readAuditRecords(outcome.workspaceDir);
  assert.deepEqual(
    records.map((record) => record.eventType),
    [
      "run.created",
      "run.started",
      "run.attempt_recorded",
      "run.backend_session_updated",
      "run.retrying",
      "run.attempt_recorded",
      "run.finished",
    ],
  );
  assert.equal(records[4].sessionIndex, 0);
  assert.equal(records[4].incompleteCount, 1);
  assert.equal(records[4].invalidStatusCount, 0);
});

test("resume rejection and abort append dedicated audit records before run.finished", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const first = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async (ctx) => {
      updateTasksForPrompt(
        ctx.prompt,
        {
          t1: { status: "completed" },
          t2: { status: "blocked" },
        },
        dir,
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "resume-thread",
        transcript: "",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId));
  await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "new-thread",
      transcript: "",
      rawStdout: "",
      rawStderr: "",
    })),
    resume: target,
    overrides: { message: "retry" },
    resumeFailureDetector: () => true,
  });

  const rejectedRecords = readAuditRecords(first.workspaceDir);
  assert.deepEqual(
    rejectedRecords.slice(-4).map((record) => record.eventType),
    ["run.resumed", "run.attempt_recorded", "run.resume_rejected", "run.finished"],
  );
  assert.equal(rejectedRecords.at(-1).terminalStatus, "error");

  const aborted = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async () => ({
      aborted: true,
      exitCode: null,
      signal: null,
      timedOut: false,
      sessionId: "abort-thread",
      transcript: "",
      rawStdout: "",
      rawStderr: "",
    })),
  });

  const abortedRecords = readAuditRecords(aborted.workspaceDir);
  assert.deepEqual(
    abortedRecords.slice(-4).map((record) => record.eventType),
    ["run.attempt_recorded", "run.backend_session_updated", "run.aborted", "run.finished"],
  );
  assert.equal(abortedRecords.at(-1).terminalStatus, "aborted");
});

test("command and task mutations append compact records, preserve history on reset, and delete removes the workspace", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const init = await runIn(dir, {
    agentName: "audit-passive",
    assignmentName: "audit-passive-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }, "passive"),
    initialize: true,
  });

  runCli(["run", "set-name", init.runId, "Audit Name"], { cwd: dir });
  runCli(["run", "set-name", init.runId, "Audit Name"], { cwd: dir });
  runCli(["run", "set-backend-session", init.runId, "thread-1"], { cwd: dir });
  runCli(["run", "set-backend-session", init.runId, "thread-1"], { cwd: dir });
  runCli(["run", "clear-backend-session", init.runId], { cwd: dir });
  runCli(["run", "archive", init.runId], { cwd: dir });
  runCli(["run", "unarchive", init.runId], { cwd: dir });
  const addedText = runCli(["task", "add", init.runId, "--title", "Third"], { cwd: dir });
  const addedTaskId = addedText.match(/added task (\S+)/)?.[1];
  assert.ok(addedTaskId);
  runCli(["task", "append-notes", init.runId, "t1", "--text", "top-secret-note"], { cwd: dir });
  runCli(["task", "set", init.runId, "t1", "--status", "completed"], { cwd: dir });
  runCli(["task", "set", init.runId, "t2", "--status", "completed"], { cwd: dir });
  runCli(["task", "set", init.runId, addedTaskId, "--status", "blocked"], { cwd: dir });
  runCli(["run", "set-backend-session", init.runId, "thread-2"], { cwd: dir });

  const beforeResetRaw = readAuditRaw(init.workspaceDir);
  runCli(["run", "reset", init.runId], { cwd: dir });

  const records = readAuditRecords(init.workspaceDir);
  const eventTypes = records.map((record) => record.eventType);
  assert.equal(
    eventTypes.filter((eventType) => eventType === "run.renamed").length,
    1,
    "no-op rename should not append a second event",
  );
  assert.equal(
    eventTypes.filter((eventType) => eventType === "run.backend_session_updated").length,
    4,
    "expected passive_set, passive_clear, passive_set, and reset_clear only",
  );
  assert.deepEqual(eventTypes.slice(-2), ["run.backend_session_updated", "run.reset"]);
  assert.equal(records.at(-2).reason, "reset_clear");
  assert.equal(records.at(-1).previousStatus, "blocked");
  assert.equal(beforeResetRaw.endsWith("\n"), true);
  assert.equal(readAuditRaw(init.workspaceDir).startsWith(beforeResetRaw), true);
  assert.equal(readAuditRaw(init.workspaceDir).includes("top-secret-note"), false);
  const finishedIndex = eventTypes.lastIndexOf("run.finished");
  assert.ok(finishedIndex > 0);
  assert.equal(eventTypes[finishedIndex - 1], "task.updated");
  assert.equal(records[finishedIndex - 1].command, "set");
  assert.equal(records[finishedIndex].source, "system");
  assert.equal(records[finishedIndex].terminalStatus, "blocked");
  assert.equal(records[finishedIndex].sessionIndex, undefined);
  assert.equal(records[finishedIndex].attemptNumber, undefined);

  runCli(["run", "archive", init.runId], { cwd: dir });
  runCli(["run", "delete", init.runId], { cwd: dir });
  assert.equal(existsSync(init.workspaceDir), false);
});

test("queued resume message mutations append compact audit records without message text", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const init = await runIn(dir, {
    agentName: "audit-passive",
    assignmentName: "audit-passive-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }, "passive"),
    initialize: true,
  });
  patchManifest(init.workspaceDir, (manifest) => {
    manifest.status = "running";
  });

  await withSharedRuntimeEnv(dir, async () => {
    const first = queueResumeMessage({
      target: init.runId,
      message: "secret queued text one",
    });
    const second = queueResumeMessage({
      target: init.runId,
      message: "secret queued text two",
    });
    removeQueuedResumeMessage({
      target: init.runId,
      messageId: first.queuedResumeMessage.id,
    });
    drainQueuedResumeMessages({
      target: init.runId,
      messageIds: [second.queuedResumeMessage.id],
    });
  });

  const records = readAuditRecords(init.workspaceDir);
  const queueRecords = records.filter((record) => record.eventType.startsWith("run.queued_"));
  assert.deepEqual(
    queueRecords.map((record) => record.eventType),
    [
      "run.queued_resume_message_added",
      "run.queued_resume_message_added",
      "run.queued_resume_message_removed",
      "run.queued_resume_messages_drained",
    ],
  );
  assert.equal(typeof queueRecords[0].messageId, "string");
  assert.equal(typeof queueRecords[0].messageCreatedAt, "string");
  assert.deepEqual(queueRecords[2].messageId, queueRecords[0].messageId);
  assert.deepEqual(queueRecords[3].messageIds, [queueRecords[1].messageId]);
  assert.equal(queueRecords[3].messageCount, 1);
  assert.equal(readAuditRaw(init.workspaceDir).includes("secret queued text"), false);
});

test("task-transition hooks skip unmatched transitions and append compact run.hook_recorded records with task ids once matched", async () => {
  const dir = tempDir();
  writeAgent(dir, "audit-passive", PASSIVE_AGENT);
  writeAssignment(
    dir,
    "audit-passive-work",
    `---
schemaVersion: 1
name: audit-passive-work
hooks:
  taskTransition:
    - name: audit-task-transition
      when:
        taskId: t1
        toStatus: ["completed"]
tasks:
  - id: t1
    title: First
    body: Do thing one.
---
Audit passive assignment.
`,
  );
  writeNamedHook(
    dir,
    "audit-task-transition",
    `export default {
  name: "audit-task-transition",
  taskTransition() {
    return { accept: true };
  },
};
`,
  );

  const init = await runIn(dir, {
    agentName: "audit-passive",
    assignmentName: "audit-passive-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }, "passive"),
    initialize: true,
  });

  runCli(["task", "set", init.runId, "t1", "--status", "in_progress"], { cwd: dir });
  let hookEvents = readAuditRecords(init.workspaceDir).filter(
    (record) => record.eventType === "run.hook_recorded",
  );
  assert.equal(hookEvents.length, 0);

  runCli(["task", "set", init.runId, "t1", "--status", "completed"], { cwd: dir });

  hookEvents = readAuditRecords(init.workspaceDir).filter(
    (record) => record.eventType === "run.hook_recorded",
  );
  assert.equal(hookEvents.length, 1);
  assert.deepEqual(
    {
      phase: hookEvents[0].phase,
      hookId: hookEvents[0].hookId,
      outcome: hookEvents[0].outcome,
      sessionIndex: hookEvents[0].sessionIndex ?? null,
      attemptNumber: hookEvents[0].attemptNumber ?? null,
      taskId: hookEvents[0].taskId ?? null,
      summary: hookEvents[0].summary ?? null,
      source: hookEvents[0].source,
    },
    {
      phase: "taskTransition",
      hookId: "taskTransition:0:audit-task-transition",
      outcome: "accepted",
      sessionIndex: null,
      attemptNumber: null,
      taskId: "t1",
      summary: null,
      source: "task_command",
    },
  );
});

test("audit append failure after attempt persistence does not duplicate the attempt record", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  let workspaceDir = "";

  await assert.rejects(
    runIn(dir, {
      agentName: "audit-active",
      assignmentName: "audit-active-work",
      backend: mockBackend(async (ctx) => {
        completeAllTasksFromPrompt(ctx.prompt, dir);
        workspaceDir = withSharedRuntimeEnv(dir, () => {
          const resolved = resolveResumeTarget(runIdFromPrompt(ctx.prompt));
          return resolved.workspaceDir;
        });
        unlinkSync(readAuditPath(workspaceDir));
        mkdirSync(readAuditPath(workspaceDir));
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "broken-audit-thread",
          transcript: "",
          rawStdout: "",
          rawStderr: "",
        };
      }),
    }),
  );

  const manifest = JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
  assert.equal(manifest.attemptRecords.length, 1);
  assert.equal(manifest.totalAttemptCount, 1);
  assert.equal(manifest.attemptRecords[0].exitCode, 0);
});

test("daemon execution records controller metadata on lifecycle events", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const outcome = await runIn(dir, {
    agentName: "audit-active",
    assignmentName: "audit-active-work",
    backend: mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt, dir);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "daemon-thread",
        transcript: "",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    execution: {
      hostMode: "daemon",
      controller: {
        kind: "daemon",
        daemonInstanceId: "daemon-audit-test",
      },
    },
  });

  const records = readAuditRecords(outcome.workspaceDir);
  assert.deepEqual(
    records.map((record) => record.eventType),
    [
      "run.created",
      "run.started",
      "run.attempt_recorded",
      "run.backend_session_updated",
      "run.finished",
    ],
  );
  for (const record of records) {
    assert.equal(record.hostMode, "daemon");
    assert.equal(record.controllerInstanceId, "daemon-audit-test");
    assert.equal(record.source, "daemon");
  }
});

test("daemon-context task commands append one task event with daemon host metadata", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const init = await runIn(dir, {
    agentName: "audit-passive",
    assignmentName: "audit-passive-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }, "passive"),
    initialize: true,
  });

  await withSharedRuntimeEnv(dir, async () => {
    await updateTaskViaApp(
      init.runId,
      "t1",
      { status: "in_progress" },
      {
        hostMode: "daemon",
        controllerInstanceId: "daemon-task-test",
      },
    );
  });

  const records = readAuditRecords(init.workspaceDir);
  const taskUpdates = records.filter((record) => record.eventType === "task.updated");
  assert.equal(taskUpdates.length, 1);
  assert.equal(taskUpdates[0].source, "task_command");
  assert.equal(taskUpdates[0].hostMode, "daemon");
  assert.equal(taskUpdates[0].controllerInstanceId, "daemon-task-test");
});

test("controller recovery audit events round-trip and render compact CLI details", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const init = await runIn(dir, {
    agentName: "audit-passive",
    assignmentName: "audit-passive-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }, "passive"),
    initialize: true,
  });
  patchManifest(init.workspaceDir, (manifest) => {
    manifest.backend = "codex";
    manifest.backendSessionId = "thread-recovery";
  });
  const manifest = withSharedRuntimeEnv(dir, () => resolveResumeTarget(init.runId).manifest);
  const context = systemRunEventContext({
    hostMode: "daemon",
    controllerInstanceId: "daemon-recovery-test",
  });

  appendRunControllerDetachedEvent({
    manifest,
    context,
    transportType: "ws",
    reason: "daemon_shutdown",
  });
  appendRunControllerReconciledEvent({
    manifest,
    context,
    transportType: "ws",
    decision: "adopted_aborted",
    reason: "aborted_after_recovery",
    remoteStatus: "Active",
    error: null,
  });

  const records = readAuditRecords(init.workspaceDir).slice(-2);
  assert.deepEqual(
    records.map((record) => record.eventType),
    ["run.controller_detached", "run.controller_reconciled"],
  );
  assert.equal(records[0].transportType, "ws");
  assert.equal(records[0].reason, "daemon_shutdown");
  assert.equal(records[1].decision, "adopted_aborted");
  assert.equal(records[1].reason, "aborted_after_recovery");

  const text = runCli(["run", "audit", init.runId], { cwd: dir });
  assert.match(text, /run\.controller_detached/);
  assert.match(text, /transportType="ws"/);
  assert.match(text, /reason="daemon_shutdown"/);
  assert.match(text, /run\.controller_reconciled/);
  assert.match(text, /decision="adopted_aborted"/);
  assert.match(text, /remoteStatus="Active"/);
});

test("run audit CLI renders empty, text, json, and not-found responses", async () => {
  const dir = tempDir();
  writeAuditBundle(dir);
  const init = await runIn(dir, {
    agentName: "audit-passive",
    assignmentName: "audit-passive-work",
    backend: mockBackend(async () => {
      throw new Error("backend should not be invoked during init");
    }, "passive"),
    initialize: true,
  });

  unlinkSync(readAuditPath(init.workspaceDir));
  assert.equal(runCli(["run", "audit", init.runId], { cwd: dir }), "No audit events found.\n");

  runCli(["task", "set", init.runId, "t1", "--status", "completed"], { cwd: dir });

  const text = runCli(["run", "audit", init.runId], { cwd: dir });
  assert.match(text, /task\.updated/);
  assert.match(text, /statusBefore="pending"/);
  assert.match(text, /statusAfter="completed"/);

  const json = JSON.parse(
    runCli(["run", "audit", init.runId, "--output-format", "json", "--limit", "1"], {
      cwd: dir,
    }),
  );
  assert.equal(json.lastCursor, 1);
  assert.equal(json.events.length, 1);
  assert.equal(json.events[0].cursor, 1);
  assert.equal(json.events[0].event.type, "task.updated");

  const missingId = runCliResult(["run", "audit"], { cwd: dir });
  assert.equal(missingId.status, 1);
  assert.match(missingId.stderr, /run audit requires a run id/);

  const notFound = runCliResult(["run", "audit", "run-missing"], { cwd: dir });
  assert.equal(notFound.status, 2);
  assert.match(notFound.stderr, /could not find run manifest for "run-missing"/);
});
