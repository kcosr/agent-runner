import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { getRunTimelineHistory } from "../packages/core/dist/app/service.js";
import { encodePiSessionDir } from "../packages/core/dist/backends/pi.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import {
  CommandError,
  addAttachmentFromFile,
  addRunDependency,
  addTask,
  appendTaskNotes,
  archiveRun,
  clearRunBackendSession,
  clearRunDependencies,
  clearRunGroup,
  clearRunSchedule,
  downloadAttachment,
  isCommandError,
  listAttachments,
  listDefinitions,
  listRuns,
  listTasks,
  readStatus,
  readyRun,
  removeAttachment,
  removeRunDependency,
  setRunBackendSession,
  setRunGroup,
  setRunName,
  setRunNote,
  setRunPinned,
  setRunSchedule,
  setRunScheduleEnabled,
  setTask,
  showDefinition,
  showTask,
  unarchiveRun,
} from "../packages/core/dist/core/commands/service.js";
import { LockedFieldError, runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { withEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SHARED_REVIEW_TASK_IDS = [
  "review/architecture",
  "review/concurrency",
  "review/error-handling",
  "review/state-machine",
  "review/resources",
  "review/security",
  "review/types-schema",
  "review/simplification-and-duplication",
  "review/test-coverage",
  "review/docs-drift",
  "review/surface-completeness",
];

const AGENT = `---
schemaVersion: 1
name: svc-agent
backend: claude
model: claude-sonnet-4-6
---
Service test agent.
`;

const PASSIVE_AGENT = `---
schemaVersion: 1
name: svc-passive-agent
backend: passive
---
Passive service test agent.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: svc-work
maxRetries: 1
tasks:
  - id: t1
    title: First
    body: Do the first thing.
  - id: t2
    title: Second
    body: Do the second thing.
---
Service test assignment.
`;

const LOCKED_ASSIGNMENT = `---
schemaVersion: 1
name: svc-locked-work
maxRetries: 1
lockedFields:
  - tasks
tasks:
  - id: t1
    title: Only
---
Locked service test assignment.
`;

const LOCKED_SCHEDULE_ASSIGNMENT = `---
schemaVersion: 1
name: svc-locked-schedule-work
maxRetries: 1
lockedFields:
  - schedule
schedule:
  delay: 30m
tasks:
  - id: t1
    title: Only
---
Locked schedule service test assignment.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-command-services-"));
}

function writeFakePiRenameAgent(baseDir) {
  const path = join(baseDir, "fake-pi-rename.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const sessionFlagIndex = args.indexOf("--session");
const sessionPath = sessionFlagIndex >= 0 ? args[sessionFlagIndex + 1] : null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "set_session_name") {
    return;
  }
  if (sessionPath) {
    appendFileSync(
      sessionPath,
      JSON.stringify({
        type: "session_info",
        id: "session-info-1",
        parentId: null,
        timestamp: "2026-04-17T12:02:00.000Z",
        name: message.name,
      }) + "\\n",
    );
  }
  send({
    id: message.id,
    type: "response",
    command: "set_session_name",
    success: true,
  });
});

rl.on("close", () => {
  process.exit(0);
});
`,
  );
  chmodSync(path, 0o755);
  return path;
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

function writeLauncher(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${ext}`), body);
}

function writeBundle(baseDir, assignmentBody = ASSIGNMENT, assignmentName = "svc-work") {
  writeAgent(baseDir, "svc-agent", AGENT);
  writeAgent(baseDir, "svc-passive-agent", PASSIVE_AGENT);
  writeAssignment(baseDir, assignmentName, assignmentBody);
}

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = readManifest(workspaceDir);
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function moveRunToRepoBucket(baseDir, workspaceDir, repo) {
  const nextWorkspaceDir = join(baseDir, "runs", repo, readManifest(workspaceDir).runId);
  mkdirSync(join(baseDir, "runs", repo), { recursive: true });
  renameSync(workspaceDir, nextWorkspaceDir);
  patchManifest(nextWorkspaceDir, (manifest) => {
    manifest.repo = repo;
    manifest.workspaceDir = nextWorkspaceDir;
  });
  return nextWorkspaceDir;
}

async function initRun(
  baseDir,
  assignmentName = "svc-work",
  agentName = "svc-agent",
  options = {},
) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
    const loadedAssignment = loadAssignmentConfig(assignmentName, baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        parentRunId: options.parentRunId ?? null,
        backend: {
          id: loaded.config.backend,
          async invoke() {
            throw new Error("backend should not be invoked during init");
          },
        },
        initialize: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("command services: passive backend session mutations update only metadata and reject non-passive runs", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const passiveRun = await initRun(dir, "svc-work", "svc-passive-agent");
  const nonPassiveRun = await initRun(dir);

  patchManifest(passiveRun.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.archivedAt = "2026-04-17T10:00:00.000Z";
    manifest.endedAt = "2026-04-17T09:59:00.000Z";
    manifest.exitCode = 0;
    manifest.totalAttemptCount = 2;
    manifest.totalSessionCount = 1;
    manifest.backendSessionId = "thread-original";
    manifest.sessions = [
      {
        sessionIndex: 0,
        startedAt: "2026-04-17T09:00:00.000Z",
        endedAt: "2026-04-17T09:30:00.000Z",
        status: "success",
        exitCode: 0,
        message: "seed message",
        brief: "seed brief",
        firstAttemptNumber: 1,
        lastAttemptNumber: 2,
        maxAttemptsPerSession: 3,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: "thread-original",
      },
    ];
    manifest.attemptRecords = [
      {
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-17T09:00:00.000Z",
        endedAt: "2026-04-17T09:10:00.000Z",
        prompt: "prompt 1",
        sessionIdAtStart: null,
        sessionIdCaptured: "thread-original",
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "transcript 1",
        logPath: "attempts/01.json",
        invalidStatuses: [],
      },
    ];
  });

  const before = readManifest(passiveRun.workspaceDir);
  const preservedBefore = {
    status: before.status,
    archivedAt: before.archivedAt,
    endedAt: before.endedAt,
    exitCode: before.exitCode,
    totalAttemptCount: before.totalAttemptCount,
    totalSessionCount: before.totalSessionCount,
    sessions: before.sessions,
    attemptRecords: before.attemptRecords,
    finalTasks: before.finalTasks,
    tasksCompleted: before.tasksCompleted,
    tasksTotal: before.tasksTotal,
    resetSeed: before.resetSeed,
  };

  await withSharedRuntimeEnv(dir, async () => {
    assert.deepEqual(setRunBackendSession(passiveRun.runId, { backendSessionId: "thread-42" }), {
      runId: passiveRun.runId,
      backendSessionId: "thread-42",
      changed: true,
    });
    assert.deepEqual(setRunBackendSession(passiveRun.runId, { backendSessionId: " thread-42 " }), {
      runId: passiveRun.runId,
      backendSessionId: "thread-42",
      changed: false,
    });
    assert.deepEqual(clearRunBackendSession(passiveRun.runId), {
      runId: passiveRun.runId,
      backendSessionId: null,
      changed: true,
    });
    assert.deepEqual(clearRunBackendSession(passiveRun.runId), {
      runId: passiveRun.runId,
      backendSessionId: null,
      changed: false,
    });

    assert.throws(
      () => setRunBackendSession(nonPassiveRun.runId, { backendSessionId: "thread-9" }),
      (err) =>
        err instanceof CommandError &&
        /post-creation backend session mutation is only allowed for passive runs/.test(err.message),
    );
    assert.throws(
      () => clearRunBackendSession(nonPassiveRun.runId),
      (err) =>
        err instanceof CommandError &&
        /post-creation backend session mutation is only allowed for passive runs/.test(err.message),
    );
    assert.throws(
      () => setRunBackendSession(passiveRun.runId, { backendSessionId: "   " }),
      (err) =>
        err instanceof CommandError &&
        /run set-backend-session: <session-id> cannot be empty/.test(err.message),
    );
  });

  const after = readManifest(passiveRun.workspaceDir);
  assert.equal(after.backendSessionId, null);
  assert.deepEqual(
    {
      status: after.status,
      archivedAt: after.archivedAt,
      endedAt: after.endedAt,
      exitCode: after.exitCode,
      totalAttemptCount: after.totalAttemptCount,
      totalSessionCount: after.totalSessionCount,
      sessions: after.sessions,
      attemptRecords: after.attemptRecords,
      finalTasks: after.finalTasks,
      tasksCompleted: after.tasksCompleted,
      tasksTotal: after.tasksTotal,
      resetSeed: after.resetSeed,
    },
    preservedBefore,
  );
});

async function startCodexRenameServer(options = {}) {
  const renameCalls = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "initialize" && message.id !== undefined) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        return;
      }
      if (message.method === "initialized") {
        return;
      }
      if (message.method === "thread/name/set" && message.id !== undefined) {
        renameCalls.push(message.params);
        if (options.invalidFrameOnRename === true) {
          socket._socket.write(Buffer.from([0x88, 0x7e, 0xff, 0xff]));
          return;
        }
        if (options.failRename === true) {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32001, message: "rename failed" },
            }),
          );
          return;
        }
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      }
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind codex rename test server");
  }

  return {
    renameCalls,
    url: `ws://127.0.0.1:${address.port}/`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

test("command services: getRunTimelineHistory reads schema v2 attempt logs", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const attemptsDir = join(outcome.workspaceDir, "attempts");
  mkdirSync(attemptsDir, { recursive: true });

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.sessions = [
      {
        sessionIndex: 0,
        startedAt: "2026-04-15T01:00:00.000Z",
        endedAt: "2026-04-15T01:05:00.000Z",
        status: "success",
        exitCode: 0,
        message: null,
        brief: manifest.brief,
        firstAttemptNumber: 1,
        lastAttemptNumber: 3,
        maxAttemptsPerSession: manifest.maxAttemptsPerSession,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: null,
      },
    ];
    manifest.totalSessionCount = 1;
    manifest.attemptRecords = [
      {
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-15T01:00:00.000Z",
        endedAt: "2026-04-15T01:01:00.000Z",
        prompt: "Attempt one",
        sessionIdAtStart: null,
        sessionIdCaptured: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "First output",
        logPath: "attempts/01.json",
        invalidStatuses: [],
      },
      {
        attemptNumber: 2,
        sessionIndex: 0,
        attemptIndexInSession: 1,
        startedAt: "2026-04-15T01:02:00.000Z",
        endedAt: "2026-04-15T01:03:00.000Z",
        prompt: "Attempt two",
        sessionIdAtStart: null,
        sessionIdCaptured: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "Second output",
        logPath: "attempts/02.json",
        invalidStatuses: [],
      },
      {
        attemptNumber: 3,
        sessionIndex: 0,
        attemptIndexInSession: 2,
        startedAt: "2026-04-15T01:04:00.000Z",
        endedAt: "2026-04-15T01:05:00.000Z",
        prompt: "Attempt three",
        sessionIdAtStart: null,
        sessionIdCaptured: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "Third output",
        logPath: "attempts/03.json",
        invalidStatuses: [],
      },
    ];
    manifest.totalAttemptCount = manifest.attemptRecords.length;
  });
  for (const attemptNumber of [1, 2, 3]) {
    writeFileSync(
      join(attemptsDir, `${String(attemptNumber).padStart(2, "0")}.json`),
      `${JSON.stringify({
        schemaVersion: 2,
        runId: outcome.runId,
        attemptNumber,
        sessionIndex: 0,
        attemptIndexInSession: attemptNumber - 1,
        prompt: `Attempt ${["one", "two", "three"][attemptNumber - 1]}`,
        stdout: "",
        stderr: "",
        transcript: `${["First", "Second", "Third"][attemptNumber - 1]} output`,
        notices: "",
      })}\n`,
    );
  }

  await withSharedRuntimeEnv(dir, async () => {
    const history = getRunTimelineHistory(outcome.runId);
    assert.equal(history.runId, outcome.runId);
    assert.equal(history.attempts.length, 3);
    assert.equal(history.attempts[0]?.transcript, "First output");
    assert.equal(history.attempts[0]?.notices, "");
    assert.equal(history.attempts[1]?.transcript, "Second output");
    assert.equal(history.attempts[1]?.notices, "");
    assert.equal(history.attempts[2]?.transcript, "Third output");
    assert.equal(history.attempts[2]?.notices, "");
  });
});

test("command services: getRunTimelineHistory degrades malformed attempt logs per attempt", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const attemptsDir = join(outcome.workspaceDir, "attempts");
  mkdirSync(attemptsDir, { recursive: true });

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.sessions = [
      {
        sessionIndex: 0,
        startedAt: "2026-04-15T01:00:00.000Z",
        endedAt: "2026-04-15T01:03:00.000Z",
        status: "success",
        exitCode: 0,
        message: null,
        brief: manifest.brief,
        firstAttemptNumber: 1,
        lastAttemptNumber: 3,
        maxAttemptsPerSession: manifest.maxAttemptsPerSession,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: null,
      },
    ];
    manifest.totalSessionCount = 1;
    manifest.attemptRecords = [
      {
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-15T01:00:00.000Z",
        endedAt: "2026-04-15T01:01:00.000Z",
        prompt: "Missing log",
        sessionIdAtStart: null,
        sessionIdCaptured: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "Missing transcript",
        logPath: "attempts/01.json",
        invalidStatuses: [],
      },
      {
        attemptNumber: 2,
        sessionIndex: 0,
        attemptIndexInSession: 1,
        startedAt: "2026-04-15T01:01:00.000Z",
        endedAt: "2026-04-15T01:02:00.000Z",
        prompt: "Corrupt log",
        sessionIdAtStart: null,
        sessionIdCaptured: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "Corrupt transcript",
        logPath: "attempts/02.json",
        invalidStatuses: [],
      },
      {
        attemptNumber: 3,
        sessionIndex: 0,
        attemptIndexInSession: 2,
        startedAt: "2026-04-15T01:02:00.000Z",
        endedAt: "2026-04-15T01:03:00.000Z",
        prompt: "Escaping log",
        sessionIdAtStart: null,
        sessionIdCaptured: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "Escaping transcript",
        logPath: "../outside.json",
        invalidStatuses: [],
      },
    ];
    manifest.totalAttemptCount = manifest.attemptRecords.length;
  });
  writeFileSync(join(attemptsDir, "02.json"), "{not valid json");

  await withSharedRuntimeEnv(dir, async () => {
    const history = getRunTimelineHistory(outcome.runId);
    assert.equal(history.runId, outcome.runId);
    assert.equal(history.attempts.length, 3);
    assert.deepEqual(
      history.attempts.map((attempt) => [
        attempt.attemptNumber,
        attempt.transcript,
        attempt.notices,
      ]),
      [
        [1, "Missing transcript", ""],
        [2, "Corrupt transcript", ""],
        [3, "Escaping transcript", ""],
      ],
    );
  });
});

test("command services: listDefinitions and showDefinition return typed config results", async () => {
  const dir = tempDir();
  writeBundle(dir);
  writeLauncher(
    dir,
    "ssh-docker",
    `schemaVersion: 1
name: ssh-docker
command: ssh
args: [worker]
`,
  );

  await withSharedRuntimeEnv(dir, async () => {
    const agents = listDefinitions("agent");
    const assignments = listDefinitions("assignment");
    const launchers = listDefinitions("launcher");
    const assignment = showDefinition("assignment", "svc-work");
    const launcher = showDefinition("launcher", "ssh-docker");

    assert.equal(agents.kind, "agent");
    assert.equal(assignments.kind, "assignment");
    assert.equal(launchers.kind, "launcher");
    assert.ok(agents.entries.some((entry) => entry.name === "svc-agent"));
    assert.ok(assignments.entries.some((entry) => entry.name === "svc-work"));
    assert.deepEqual(
      launchers.entries.map((entry) => entry.name),
      ["direct", "ssh-docker"],
    );
    assert.deepEqual(launchers.warnings, []);
    assert.equal(assignment.kind, "assignment");
    assert.equal(assignment.loaded.config.name, "svc-work");
    assert.match(assignment.loaded.instructions, /Service test assignment/);
    assert.equal(launcher.kind, "launcher");
    assert.equal(launcher.loaded.name, "ssh-docker");
    assert.equal(launcher.loaded.kind, "prefix");
  });
});

test("command services: showDefinition resolves built-in code-review named task refs", () =>
  withEnv(
    {
      TASK_RUNNER_CONFIG_DIR: REPO_ROOT,
      TASK_RUNNER_CONNECT: undefined,
      TASK_RUNNER_LISTEN: undefined,
    },
    () => {
      const implementationReview = showDefinition("assignment", "code-review");
      const directReview = showDefinition("assignment", "code-review-direct");

      assert.deepEqual(
        implementationReview.loaded.config.tasks.map((task) => task.id),
        ["orient", ...SHARED_REVIEW_TASK_IDS, "plan_coverage", "synthesis", "approval"],
      );
      assert.deepEqual(
        directReview.loaded.config.tasks.map((task) => task.id),
        ["orient", ...SHARED_REVIEW_TASK_IDS, "synthesis", "approval"],
      );
    },
  ));

test("command services: readStatus reads canonical task state for running runs", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
    manifest.finalTasks.t1.status = "pending";
    manifest.finalTasks.t2.status = "pending";
    manifest.tasksCompleted = 0;
  });
  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.finalTasks.t1.status = "completed";
    manifest.finalTasks.t2.status = "in_progress";
    manifest.tasksCompleted = 1;
  });

  await withSharedRuntimeEnv(dir, async () => {
    const result = readStatus(outcome.runId);
    assert.equal(result.isLive, false);
    assert.equal(result.tasks[0].status, "completed");
    assert.equal(result.tasks[1].status, "in_progress");
    assert.equal(result.tasksCompleted, 1);
    assert.deepEqual(result.capabilities, {
      canArchive: false,
      canUnarchive: false,
      canReset: false,
      canDelete: false,
      canReady: false,
      canResume: false,
      canAbort: false,
      abortReason: "not_active_in_daemon",
      canReconfigure: false,
      reconfigureReason: "not_initialized",
      taskMutation: {
        canSetStatus: true,
        canEditNotes: true,
        canAdd: false,
      },
    });
  });
});

test("command services: readStatus and timeline history resolve bare run ids across repo buckets", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const relocatedWorkspaceDir = moveRunToRepoBucket(dir, outcome.workspaceDir, "assistant");

  patchManifest(relocatedWorkspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
    manifest.attemptRecords = [
      {
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-15T01:00:00.000Z",
        endedAt: "2026-04-15T01:01:00.000Z",
        prompt: "Attempt one",
        sessionIdAtStart: null,
        sessionIdCaptured: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "First output",
        logPath: "attempts/01.json",
        invalidStatuses: [],
      },
    ];
    manifest.totalAttemptCount = 1;
    manifest.sessions = [
      {
        sessionIndex: 0,
        startedAt: "2026-04-15T01:00:00.000Z",
        endedAt: "2026-04-15T01:01:00.000Z",
        status: "success",
        exitCode: 0,
        message: null,
        brief: manifest.brief,
        firstAttemptNumber: 1,
        lastAttemptNumber: 1,
        maxAttemptsPerSession: manifest.maxAttemptsPerSession,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: null,
      },
    ];
    manifest.totalSessionCount = 1;
  });
  mkdirSync(join(relocatedWorkspaceDir, "attempts"), { recursive: true });
  writeFileSync(
    join(relocatedWorkspaceDir, "attempts", "01.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      runId: outcome.runId,
      attemptNumber: 1,
      sessionIndex: 0,
      attemptIndexInSession: 0,
      prompt: "Attempt one",
      stdout: "",
      stderr: "",
      transcript: "First output",
      notices: "",
    })}\n`,
  );

  await withSharedRuntimeEnv(dir, async () => {
    const status = readStatus(outcome.runId);
    const history = getRunTimelineHistory(outcome.runId);

    assert.equal(status.runId, outcome.runId);
    assert.equal(status.repo, "assistant");
    assert.equal(status.workspaceDir, relocatedWorkspaceDir);
    assert.equal(history.runId, outcome.runId);
    assert.equal(history.attempts.length, 1);
    assert.equal(history.attempts[0]?.transcript, "First output");
  });
});

test("command services: listRuns reflects canonical task state for running summaries", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
    manifest.finalTasks.t1.status = "pending";
    manifest.finalTasks.t2.status = "pending";
    manifest.tasksCompleted = 0;
  });
  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.finalTasks.t1.status = "completed";
    manifest.finalTasks.t2.status = "in_progress";
    manifest.tasksCompleted = 1;
  });

  await withSharedRuntimeEnv(dir, async () => {
    const run = listRuns({ includeArchived: true }).find((entry) => entry.runId === outcome.runId);
    assert.ok(run);
    assert.equal(run.tasksCompleted, 1);
    assert.equal(run.tasksTotal, 2);
    assert.equal(run.status, "running");
    assert.equal(run.effectiveStatus, "running");
    assert.deepEqual(run.dependencyState, {
      ready: true,
      total: 0,
      satisfied: 0,
      unsatisfied: 0,
    });
  });
});

test("command services: readStatus and listRuns project hook detail and hook counts", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.resolvedHooks = [
      {
        hookId: "prepare:0:freeze",
        phase: "prepare",
        source: { name: "freeze" },
        resolvedPath: "/tmp/hooks/freeze/hook.ts",
        when: null,
        config: { mode: "json" },
      },
    ];
    manifest.hookState = { prepared: true };
    manifest.hookAudits = [
      {
        phase: "prepare",
        hookId: "prepare:0:freeze",
        startedAt: "2026-04-20T10:00:00.000Z",
        endedAt: "2026-04-20T10:00:01.000Z",
        outcome: "continue",
        sessionIndex: null,
        attemptNumber: null,
        taskId: null,
        summary: null,
      },
    ];
  });

  await withSharedRuntimeEnv(dir, async () => {
    const detail = readStatus(outcome.runId);
    const summary = listRuns({ includeArchived: true }).find(
      (entry) => entry.runId === outcome.runId,
    );

    assert.ok(summary);
    assert.equal(summary.hookCount, 1);
    assert.equal(detail.resolvedHooks?.length, 1);
    assert.deepEqual(detail.hookState, { prepared: true });
    assert.equal(detail.hookAudits?.length, 1);
    assert.equal(detail.resolvedHooks?.[0]?.hookId, "prepare:0:freeze");
  });
});

test("command services: listRuns keeps persisted progress for terminal and running runs", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const terminal = await initRun(dir);
  const nonFile = await initRun(dir);

  patchManifest(terminal.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.finalTasks.t1.status = "pending";
    manifest.finalTasks.t2.status = "pending";
    manifest.tasksCompleted = 0;
  });
  patchManifest(nonFile.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
    manifest.finalTasks.t1.status = "pending";
    manifest.finalTasks.t2.status = "pending";
    manifest.tasksCompleted = 0;
  });

  await withSharedRuntimeEnv(dir, async () => {
    const runs = listRuns({ includeArchived: true });
    const terminalSummary = runs.find((entry) => entry.runId === terminal.runId);
    const nonFileSummary = runs.find((entry) => entry.runId === nonFile.runId);

    assert.ok(terminalSummary);
    assert.ok(nonFileSummary);
    assert.equal(terminalSummary.tasksCompleted, 0);
    assert.equal(nonFileSummary.tasksCompleted, 0);
  });
});

test("command services: listRuns tolerates workspace assignment seed artifacts", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
    manifest.finalTasks.t1.status = "pending";
    manifest.finalTasks.t2.status = "pending";
    manifest.tasksCompleted = 0;
  });
  assert.equal(existsSync(join(outcome.workspaceDir, "assignment-seed.md")), true);

  await withSharedRuntimeEnv(dir, async () => {
    const run = listRuns({ includeArchived: true }).find((entry) => entry.runId === outcome.runId);
    assert.ok(run);
    assert.equal(run.tasksCompleted, 0);
    assert.equal(run.tasksTotal, 2);
  });
});

test("command services: setTask, listTasks, showTask, and appendTaskNotes persist canonical task state", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const updated = await setTask(outcome.runId, "t1", {
      status: "in_progress",
      notes: "Investigating.",
    });
    assert.equal(updated.task.status, "in_progress");
    assert.equal(updated.task.notes, "Investigating.");

    const appended = await appendTaskNotes(outcome.runId, "t1", "Waiting on confirmation.");
    assert.equal(appended.task.notes, "Investigating.\nWaiting on confirmation.");

    const list = listTasks(outcome.runId);
    const single = showTask(outcome.runId, "t1");

    assert.equal(list.tasks.length, 2);
    assert.equal(list.tasks[0].id, "t1");
    assert.equal(single.task.id, "t1");
    assert.equal(single.task.status, "in_progress");
    assert.equal(single.task.notes, "Investigating.\nWaiting on confirmation.");
  });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t1.status, "in_progress");
  assert.equal(manifest.finalTasks.t1.notes, "Investigating.\nWaiting on confirmation.");
});

test("command services: addTask returns the new snapshot and persists it", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const added = await addTask(outcome.runId, {
      title: "CLI follow-up",
      body: "Track the extra work.",
    });

    assert.match(added.task.id, /^cli-/);
    assert.equal(added.task.title, "CLI follow-up");
    assert.equal(added.task.body, "Track the extra work.");
    assert.equal(added.task.status, "pending");
  });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.tasksTotal, 3);
  assert.ok(Object.values(manifest.finalTasks).some((task) => task.title === "CLI follow-up"));
});

test("command services: add/remove/clear dependency mutations validate graph state and projection", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const target = await initRun(dir);
  const dependency = await initRun(dir);

  patchManifest(dependency.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.endedAt = "2026-04-12T10:05:00.000Z";
    manifest.exitCode = 0;
  });

  await withSharedRuntimeEnv(dir, async () => {
    const added = addRunDependency(target.runId, { type: "run", runId: dependency.runId });
    assert.deepEqual(added, {
      runId: target.runId,
      dependencies: [{ type: "run", runId: dependency.runId }],
      changed: true,
    });

    const detail = readStatus(target.runId);
    assert.deepEqual(detail.dependencies, [
      {
        type: "run",
        runId: dependency.runId,
        name: "svc-work",
        status: "success",
        effectiveStatus: "success",
        archivedAt: null,
        satisfied: true,
        missing: false,
      },
    ]);
    assert.deepEqual(detail.dependents, []);

    const removed = removeRunDependency(target.runId, { type: "run", runId: dependency.runId });
    assert.deepEqual(removed, {
      runId: target.runId,
      dependencies: [],
      changed: true,
    });

    const cleared = clearRunDependencies(target.runId);
    assert.deepEqual(cleared, {
      runId: target.runId,
      dependencies: [],
      changed: false,
    });
  });

  const manifest = readManifest(target.workspaceDir);
  assert.deepEqual(manifest.dependencies, []);
  assert.deepEqual(manifest.resetSeed.dependencies, []);
});

test("command services: set/clear run group mutations persist manifest and reset seed", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const grouped = setRunGroup(outcome.runId, { runGroupId: "shared-group" });
    assert.deepEqual(grouped, {
      runId: outcome.runId,
      runGroupId: "shared-group",
      previousRunGroupId: outcome.runId,
      changed: true,
    });

    const sameGroup = setRunGroup(outcome.runId, { runGroupId: "shared-group" });
    assert.deepEqual(sameGroup, {
      runId: outcome.runId,
      runGroupId: "shared-group",
      previousRunGroupId: "shared-group",
      changed: false,
    });

    const cleared = clearRunGroup(outcome.runId);
    assert.deepEqual(cleared, {
      runId: outcome.runId,
      runGroupId: outcome.runId,
      previousRunGroupId: "shared-group",
      changed: true,
    });
  });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.runGroupId, outcome.runId);
  assert.equal(manifest.resetSeed.runGroupId, outcome.runId);
});

test("command services: group dependencies project aggregate readiness and reverse edges", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const target = await initRun(dir);
  const memberA = await initRun(dir);
  const memberB = await initRun(dir);

  patchManifest(memberA.workspaceDir, (manifest) => {
    manifest.runGroupId = "blocking-group";
    manifest.resetSeed.runGroupId = "blocking-group";
    manifest.status = "success";
    manifest.endedAt = "2026-04-12T10:05:00.000Z";
    manifest.exitCode = 0;
  });
  patchManifest(memberB.workspaceDir, (manifest) => {
    manifest.runGroupId = "blocking-group";
    manifest.resetSeed.runGroupId = "blocking-group";
  });

  await withSharedRuntimeEnv(dir, async () => {
    const added = addRunDependency(target.runId, { type: "group", groupId: "blocking-group" });
    assert.deepEqual(added, {
      runId: target.runId,
      dependencies: [{ type: "group", groupId: "blocking-group" }],
      changed: true,
    });

    const detail = readStatus(target.runId);
    assert.deepEqual(detail.dependencies, [
      {
        type: "group",
        groupId: "blocking-group",
        total: 2,
        successful: 1,
        unsatisfied: 1,
        archivedExcluded: 0,
        satisfied: false,
        missing: false,
      },
    ]);

    const memberDetail = readStatus(memberA.runId);
    assert.deepEqual(memberDetail.dependents, [
      {
        type: "run",
        via: "group",
        dependencyGroupId: "blocking-group",
        runId: target.runId,
        name: "svc-work",
        status: "initialized",
        effectiveStatus: "initialized",
        archivedAt: null,
        satisfied: false,
        missing: false,
      },
    ]);
  });
});

test("command services: dependency mutations reject missing runs, self edges, duplicates, cycles, and non-initialized targets", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const target = await initRun(dir);
  const dependency = await initRun(dir);
  const downstream = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => addRunDependency(target.runId, { type: "run", runId: "missing-run" }),
      (err) =>
        err instanceof CommandError &&
        /run add-dep: dependency run missing-run was not found/.test(err.message),
    );

    assert.throws(
      () => addRunDependency(target.runId, { type: "run", runId: target.runId }),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`run add-dep: run ${target.runId} cannot depend on itself`).test(err.message),
    );

    addRunDependency(target.runId, { type: "run", runId: dependency.runId });
    assert.throws(
      () => addRunDependency(target.runId, { type: "run", runId: dependency.runId }),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`dependency ${dependency.runId} already exists on run ${target.runId}`).test(
          err.message,
        ),
    );

    addRunDependency(dependency.runId, { type: "run", runId: downstream.runId });
    assert.throws(
      () => addRunDependency(downstream.runId, { type: "run", runId: target.runId }),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`adding dependency ${target.runId} would create a dependency cycle`).test(
          err.message,
        ),
    );

    patchManifest(target.workspaceDir, (manifest) => {
      manifest.status = "success";
      manifest.endedAt = "2026-04-12T10:15:00.000Z";
      manifest.exitCode = 0;
    });

    assert.throws(
      () => addRunDependency(target.runId, { type: "run", runId: downstream.runId }),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`cannot add dependencies unless run ${target.runId} is initialized`).test(
          err.message,
        ),
    );
    assert.throws(
      () => removeRunDependency(target.runId, { type: "run", runId: dependency.runId }),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`cannot remove dependencies unless run ${target.runId} is initialized`).test(
          err.message,
        ),
    );
    assert.throws(
      () => clearRunDependencies(target.runId),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`cannot clear dependencies unless run ${target.runId} is initialized`).test(
          err.message,
        ),
    );
  });
});

test("command services: readyRun promotes initialized runs and tightens task and dependency mutations", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const target = await initRun(dir);
  const dependency = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const ready = readyRun(target.runId);
    assert.equal(ready.status, "ready");
    assert.equal(ready.capabilities.canReady, false);
    assert.equal(ready.capabilities.canResume, true);
    assert.deepEqual(ready.capabilities.taskMutation, {
      canSetStatus: false,
      canEditNotes: true,
      canAdd: false,
    });

    await assert.rejects(
      () =>
        setTask(target.runId, "t1", {
          status: "in_progress",
        }),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`cannot change task status while run ${target.runId} is ready`).test(
          err.message,
        ),
    );

    const appended = await appendTaskNotes(target.runId, "t1", "Ready notes");
    assert.equal(appended.task.notes, "Ready notes");

    assert.throws(
      () => addRunDependency(target.runId, { type: "run", runId: dependency.runId }),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`cannot add dependencies unless run ${target.runId} is initialized`).test(
          err.message,
        ),
    );
  });
});

test("command services: schedule mutations persist schedule state and audit through ready", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const target = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const scheduled = setRunSchedule(target.runId, {
      at: "2099-04-25T12:00:00.000Z",
    });
    assert.equal(scheduled.schedule.runAt, "2099-04-25T12:00:00.000Z");
    assert.equal(scheduled.scheduleState, "future");

    const disabled = setRunScheduleEnabled(target.runId, false);
    assert.equal(disabled.schedule.enabled, false);
    assert.equal(disabled.scheduleState, "paused");

    const cleared = clearRunSchedule(target.runId);
    assert.equal(cleared.schedule, null);
    assert.equal(cleared.scheduleState, "none");

    const ready = readyRun(target.runId, {
      cron: "0 9 * * *",
      timezone: "UTC",
      mode: "reset",
      continueOnFailure: true,
    });
    assert.equal(ready.status, "ready");
    assert.equal(ready.schedule.recurrence.schedule.expression, "0 9 * * *");
    assert.equal(ready.schedule.recurrence.mode, "reset");
    assert.equal(ready.schedule.recurrence.continueOnFailure, true);

    const manifest = readManifest(target.workspaceDir);
    assert.deepEqual(manifest.schedule, ready.schedule);
  });
});

test("command services: schedule mutation rules honor locks and allow recurring clears", async () => {
  const dir = tempDir();
  writeBundle(dir);
  writeAssignment(dir, "svc-locked-schedule-work", LOCKED_SCHEDULE_ASSIGNMENT);
  const locked = await initRun(dir, "svc-locked-schedule-work");
  const recurring = await initRun(dir);
  const terminal = await initRun(dir);
  patchManifest(terminal.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.endedAt = "2026-04-25T12:00:00.000Z";
    manifest.exitCode = 0;
  });

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => setRunSchedule(locked.runId, { at: "2099-04-25T12:00:00.000Z" }),
      (err) =>
        err instanceof LockedFieldError &&
        isCommandError(err) &&
        /cannot override locked field: schedule/.test(err.message),
    );

    const disabled = setRunScheduleEnabled(locked.runId, false);
    assert.equal(disabled.schedule.enabled, false);

    const enabled = setRunScheduleEnabled(locked.runId, true);
    assert.equal(enabled.schedule.enabled, true);

    assert.throws(
      () => clearRunSchedule(locked.runId),
      (err) =>
        err instanceof LockedFieldError &&
        isCommandError(err) &&
        /cannot override locked field: schedule/.test(err.message),
    );

    setRunSchedule(recurring.runId, {
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    const recurringCleared = clearRunSchedule(recurring.runId);
    assert.equal(recurringCleared.schedule, null);
    assert.equal(recurringCleared.scheduleState, "none");

    assert.throws(
      () =>
        setRunSchedule(terminal.runId, {
          cron: "0 9 * * *",
          timezone: "UTC",
        }),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`cannot set recurring schedule for terminal run ${terminal.runId}`).test(
          err.message,
        ),
    );

    const oneTime = setRunSchedule(terminal.runId, {
      at: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(oneTime.schedule.recurrence, null);
  });
});

test("command services: enabling a paused recurring schedule re-arms the next run time", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const target = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    setRunSchedule(target.runId, {
      cron: "0 * * * *",
      timezone: "UTC",
      mode: "reuse",
    });

    patchManifest(target.workspaceDir, (manifest) => {
      manifest.schedule = {
        ...manifest.schedule,
        enabled: false,
        runAt: "2026-04-25T13:23:00.000Z",
      };
    });

    const enabled = setRunScheduleEnabled(target.runId, true);
    assert.equal(enabled.schedule.enabled, true);
    assert.equal(enabled.schedule.recurrence.mode, "reuse");
    assert.notEqual(enabled.schedule.runAt, "2026-04-25T13:23:00.000Z");
    assert.equal(enabled.scheduleState, "future");

    const manifest = readManifest(target.workspaceDir);
    assert.equal(manifest.schedule.enabled, true);
    assert.equal(manifest.schedule.recurrence.mode, "reuse");
    assert.notEqual(manifest.schedule.runAt, "2026-04-25T13:23:00.000Z");
  });
});

test("command services: enabling a paused recurring schedule reports interval violations", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const target = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    setRunSchedule(target.runId, {
      cron: "0 * * * *",
      timezone: "UTC",
      mode: "reuse",
    });

    patchManifest(target.workspaceDir, (manifest) => {
      manifest.schedule = {
        ...manifest.schedule,
        enabled: false,
        runAt: "2026-04-25T13:23:00.000Z",
      };
    });

    await withEnv({ TASK_RUNNER_MIN_RECURRENCE_INTERVAL_SEC: "7200" }, async () => {
      assert.throws(
        () => setRunScheduleEnabled(target.runId, true),
        (err) =>
          err instanceof CommandError &&
          /cannot enable schedule .*minimum_interval_violation/.test(err.message),
      );
    });

    const manifest = readManifest(target.workspaceDir);
    assert.equal(manifest.schedule.enabled, false);
    assert.equal(manifest.schedule.runAt, "2026-04-25T13:23:00.000Z");
  });
});

test("command services: locked task lists reject addTask with CommandError", async () => {
  const dir = tempDir();
  writeBundle(dir, LOCKED_ASSIGNMENT, "svc-locked-work");
  const outcome = await initRun(dir, "svc-locked-work");

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => addTask(outcome.runId, { title: "Blocked by lock" }),
      (err) =>
        err instanceof CommandError && /the `tasks` field is locked for this run/.test(err.message),
    );
  });
});

test("command services: listRuns supports exact cwd scope, repo scope, and unscoped newest-first results", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const first = await initRun(dir);
  const second = await initRun(dir);
  const otherCwd = join(dir, "other-cwd");
  mkdirSync(otherCwd, { recursive: true });

  patchManifest(first.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T10:00:00.000Z";
    manifest.archivedAt = "2026-04-12T12:00:00.000Z";
  });
  patchManifest(second.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T11:00:00.000Z";
    manifest.cwd = otherCwd;
  });

  const otherWorkspaceDir = join(dir, "runs", "other-repo", "oth123");
  mkdirSync(otherWorkspaceDir, { recursive: true });
  const otherManifest = readManifest(second.workspaceDir);
  otherManifest.runId = "oth123";
  otherManifest.repo = "other-repo";
  otherManifest.cwd = join(dir, "other-repo-cwd");
  otherManifest.workspaceDir = otherWorkspaceDir;
  otherManifest.startedAt = "2026-04-12T09:00:00.000Z";
  otherManifest.archivedAt = null;
  writeFileSync(join(otherWorkspaceDir, "run.json"), `${JSON.stringify(otherManifest, null, 2)}\n`);
  writeFileSync(join(otherWorkspaceDir, "assignment-seed.md"), "# Assignment seed\n");

  mkdirSync(join(dir, "runs", "broken-repo", "bad999"), { recursive: true });
  writeFileSync(join(dir, "runs", "broken-repo", "bad999", "run.json"), "{not json\n");

  await withSharedRuntimeEnv(dir, async () => {
    const visible = listRuns({
      includeArchived: true,
      scope: {
        kind: "cwd",
        cwd: dir,
      },
    });
    assert.deepEqual(
      visible.map((run) => run.runId),
      [first.runId],
    );

    const exactOtherCwd = listRuns({
      scope: {
        kind: "cwd",
        cwd: otherCwd,
      },
    });
    assert.deepEqual(
      exactOtherCwd.map((run) => run.runId),
      [second.runId],
    );

    const repoScoped = listRuns({
      scope: {
        kind: "repo",
        repo: "other-repo",
      },
    });
    assert.deepEqual(
      repoScoped.map((run) => run.runId),
      ["oth123"],
    );

    const globalVisible = listRuns();
    assert.deepEqual(
      globalVisible.map((run) => run.runId),
      [second.runId, "oth123"],
    );
    assert.equal(globalVisible[0].repo, "unknown");
    assert.equal(globalVisible[1].repo, "other-repo");

    const allRuns = listRuns({ includeArchived: true });
    assert.deepEqual(
      allRuns.map((run) => run.runId),
      [second.runId, first.runId, "oth123"],
    );
    assert.equal(allRuns[1].archivedAt, "2026-04-12T12:00:00.000Z");
    assert.deepEqual(allRuns[0].capabilities, {
      canArchive: true,
      canUnarchive: false,
      canReset: true,
      canDelete: false,
      canReady: true,
      canResume: false,
      canAbort: false,
      abortReason: "not_active_in_daemon",
      canReconfigure: true,
      reconfigureReason: undefined,
      taskMutation: {
        canSetStatus: true,
        canEditNotes: true,
        canAdd: true,
      },
    });
    assert.deepEqual(allRuns[0].dependencyState, {
      ready: true,
      total: 0,
      satisfied: 0,
      unsatisfied: 0,
    });
    assert.deepEqual(allRuns[1].capabilities, {
      canArchive: false,
      canUnarchive: true,
      canReset: true,
      canDelete: true,
      canReady: false,
      canResume: false,
      canAbort: false,
      abortReason: "not_active_in_daemon",
      canReconfigure: false,
      reconfigureReason: "archived",
      taskMutation: {
        canSetStatus: true,
        canEditNotes: true,
        canAdd: true,
      },
    });
    assert.deepEqual(allRuns[1].dependencyState, {
      ready: true,
      total: 0,
      satisfied: 0,
      unsatisfied: 0,
    });
  });
});

test("command services: listRuns supports group scope across branching lineages and projects runGroupId", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const root = await initRun(dir);
  const target = await initRun(dir, "svc-work", "svc-agent", { parentRunId: root.runId });
  const peer = await initRun(dir, "svc-work", "svc-agent", { parentRunId: root.runId });
  const child = await initRun(dir, "svc-work", "svc-agent", { parentRunId: target.runId });
  const different = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const groupRuns = listRuns({
      includeArchived: true,
      scope: {
        kind: "group",
        runGroupId: root.runId,
      },
    });
    assert.deepEqual(
      new Set(groupRuns.map((run) => run.runId)),
      new Set([root.runId, target.runId, peer.runId, child.runId]),
    );
    assert.deepEqual(new Set(groupRuns.map((run) => run.runGroupId)), new Set([root.runId]));

    const allRuns = listRuns({ includeArchived: true });
    const summariesByRunId = new Map(allRuns.map((run) => [run.runId, run]));
    assert.equal(summariesByRunId.get(root.runId)?.runGroupId, root.runId);
    assert.equal(summariesByRunId.get(target.runId)?.runGroupId, root.runId);
    assert.equal(summariesByRunId.get(peer.runId)?.runGroupId, root.runId);
    assert.equal(summariesByRunId.get(child.runId)?.runGroupId, root.runId);
    assert.equal(summariesByRunId.get(different.runId)?.runGroupId, different.runId);
  });
});

test("command services: listRuns group scope ignores broken parent lineage", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const root = await initRun(dir);
  const target = await initRun(dir, "svc-work", "svc-agent", { parentRunId: root.runId });

  patchManifest(target.workspaceDir, (manifest) => {
    manifest.parentRunId = "missing-parent";
  });

  await withSharedRuntimeEnv(dir, async () => {
    const groupRuns = listRuns({
      includeArchived: true,
      scope: {
        kind: "group",
        runGroupId: root.runId,
      },
    });
    assert.deepEqual(
      new Set(groupRuns.map((run) => run.runId)),
      new Set([root.runId, target.runId]),
    );
  });
});

test("command services: listRuns group scope ignores unrelated broken lineages", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const root = await initRun(dir);
  const target = await initRun(dir, "svc-work", "svc-agent", { parentRunId: root.runId });
  const peer = await initRun(dir, "svc-work", "svc-agent", { parentRunId: root.runId });
  const unrelatedRoot = await initRun(dir);
  const unrelatedChild = await initRun(dir, "svc-work", "svc-agent", {
    parentRunId: unrelatedRoot.runId,
  });

  patchManifest(unrelatedChild.workspaceDir, (manifest) => {
    manifest.parentRunId = "missing-parent";
  });

  await withSharedRuntimeEnv(dir, async () => {
    const groupRuns = listRuns({
      includeArchived: true,
      scope: {
        kind: "group",
        runGroupId: root.runId,
      },
    });
    assert.deepEqual(
      new Set(groupRuns.map((run) => run.runId)),
      new Set([root.runId, target.runId, peer.runId]),
    );
  });
});

test("command services: archived runs allow attachment add/list/download/remove with canonical storage", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const sourcePath = join(dir, "notes.md");
  const downloadsDir = join(dir, "downloads");
  writeFileSync(sourcePath, "hello attachments\n");
  mkdirSync(downloadsDir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = "2026-04-14T12:00:00.000Z";
    manifest.archivedAt = "2026-04-14T12:05:00.000Z";
  });

  await withSharedRuntimeEnv(dir, async () => {
    const added = await addAttachmentFromFile(outcome.runId, { sourcePath });
    assert.equal(added.attachment.name, "notes.md");
    assert.equal(added.attachment.mimeType, "text/markdown; charset=utf-8");
    assert.match(added.attachment.relativePath, /^attachments\/att-[^/]+\/notes\.md$/);

    const storedPath = join(outcome.workspaceDir, added.attachment.relativePath);
    assert.equal(readFileSync(storedPath, "utf8"), "hello attachments\n");

    const listed = listAttachments(outcome.runId);
    assert.equal(listed.attachments.length, 1);
    assert.equal(listed.attachments[0].id, added.attachment.id);
    assert.equal(listed.attachments[0].ownerRunId, outcome.runId);

    const downloaded = downloadAttachment(outcome.runId, added.attachment.id, downloadsDir);
    assert.equal(readFileSync(downloaded.outputPath, "utf8"), "hello attachments\n");

    const removed = removeAttachment(outcome.runId, added.attachment.id);
    assert.equal(removed.changed, true);
    assert.equal(listAttachments(outcome.runId).attachments.length, 0);
    assert.equal(readManifest(outcome.workspaceDir).attachments.length, 0);
    assert.equal(existsSync(storedPath), false);
  });
});

test("command services: attachment list defaults to group scope and supports explicit run scope", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const root = await initRun(dir);
  const target = await initRun(dir, "svc-work", "svc-agent", { parentRunId: root.runId });
  const peer = await initRun(dir, "svc-work", "svc-agent", { parentRunId: root.runId });
  const child = await initRun(dir, "svc-work", "svc-agent", { parentRunId: target.runId });
  const different = await initRun(dir);
  const rootFile = join(dir, "root.txt");
  const targetFile = join(dir, "target.txt");
  const peerFile = join(dir, "peer.txt");
  const childFile = join(dir, "child.txt");
  const differentFile = join(dir, "different.txt");
  writeFileSync(rootFile, "root\n");
  writeFileSync(targetFile, "target\n");
  writeFileSync(peerFile, "peer\n");
  writeFileSync(childFile, "child\n");
  writeFileSync(differentFile, "different\n");

  await withSharedRuntimeEnv(dir, async () => {
    await addAttachmentFromFile(root.runId, { sourcePath: rootFile });
    await addAttachmentFromFile(target.runId, { sourcePath: targetFile });
    await addAttachmentFromFile(peer.runId, { sourcePath: peerFile });
    await addAttachmentFromFile(child.runId, { sourcePath: childFile });
    await addAttachmentFromFile(different.runId, { sourcePath: differentFile });

    const group = listAttachments(target.runId);
    assert.equal(group.attachments.length, 4);
    assert.deepEqual(
      new Set(group.attachments.map((attachment) => attachment.ownerRunId)),
      new Set([root.runId, target.runId, peer.runId, child.runId]),
    );
    assert.equal(
      group.attachments.some((attachment) => attachment.ownerRunId === different.runId),
      false,
    );

    const runOnly = listAttachments(target.runId, { scope: "run" });
    assert.deepEqual(
      runOnly.attachments.map((attachment) => attachment.ownerRunId),
      [target.runId],
    );
  });
});

test("command services: setRunName propagates codex thread rename and clear values", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const codexServer = await startCodexRenameServer();

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.backend = "codex";
    manifest.backendSessionId = "thr_rename";
    manifest.backendSpecific = {
      codex: {
        transport: {
          type: "ws",
          url: codexServer.url,
        },
      },
    };
    manifest.cwd = dir;
  });

  try {
    await withSharedRuntimeEnv(dir, async () => {
      const renamed = await setRunName(outcome.runId, { name: "  Codex rename  " });
      assert.deepEqual(renamed, {
        runId: outcome.runId,
        name: "Codex rename",
        changed: true,
      });

      const cleared = await setRunName(outcome.runId, { name: null });
      assert.deepEqual(cleared, {
        runId: outcome.runId,
        name: null,
        changed: true,
      });
    });

    assert.deepEqual(codexServer.renameCalls, [
      { threadId: "thr_rename", name: "Codex rename" },
      { threadId: "thr_rename", name: null },
    ]);
  } finally {
    await codexServer.close();
  }
});

test("command services: setRunNote and setRunPinned are idempotent and preserve reset seed metadata", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const noted = setRunNote(outcome.runId, { note: "# Follow-up\n\nKeep the review sharp." });
    assert.deepEqual(noted, {
      runId: outcome.runId,
      note: "# Follow-up\n\nKeep the review sharp.",
      changed: true,
    });

    const notedAgain = setRunNote(outcome.runId, { note: "# Follow-up\n\nKeep the review sharp." });
    assert.deepEqual(notedAgain, {
      runId: outcome.runId,
      note: "# Follow-up\n\nKeep the review sharp.",
      changed: false,
    });

    const pinned = setRunPinned(outcome.runId, { pinned: true });
    assert.deepEqual(pinned, {
      runId: outcome.runId,
      pinned: true,
      changed: true,
    });

    const pinnedAgain = setRunPinned(outcome.runId, { pinned: true });
    assert.deepEqual(pinnedAgain, {
      runId: outcome.runId,
      pinned: true,
      changed: false,
    });

    const cleared = setRunNote(outcome.runId, { note: "   " });
    assert.deepEqual(cleared, {
      runId: outcome.runId,
      note: null,
      changed: true,
    });
  });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.note, null);
  assert.equal(manifest.resetSeed.note, null);
  assert.equal(manifest.pinned, true);
  assert.equal(manifest.resetSeed.pinned, true);
});

test("command services: setRunName keeps manifest update when codex propagation fails", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const codexServer = await startCodexRenameServer({ failRename: true });

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.backend = "codex";
    manifest.backendSessionId = "thr_rename";
    manifest.backendSpecific = {
      codex: {
        transport: {
          type: "ws",
          url: codexServer.url,
        },
      },
    };
    manifest.cwd = dir;
  });

  try {
    await withSharedRuntimeEnv(dir, async () => {
      const renamed = await setRunName(outcome.runId, { name: "Still persisted" });
      assert.deepEqual(renamed, {
        runId: outcome.runId,
        name: "Still persisted",
        changed: true,
      });
    });

    const manifest = readManifest(outcome.workspaceDir);
    assert.equal(manifest.name, "Still persisted");
    assert.equal(manifest.resetSeed.name, "Still persisted");
    assert.deepEqual(codexServer.renameCalls, [
      { threadId: "thr_rename", name: "Still persisted" },
    ]);
  } finally {
    await codexServer.close();
  }
});

test("command services: setRunName does not hang on codex post-open transport errors", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const codexServer = await startCodexRenameServer({ invalidFrameOnRename: true });

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.backend = "codex";
    manifest.backendSessionId = "thr_rename";
    manifest.backendSpecific = {
      codex: {
        transport: {
          type: "ws",
          url: codexServer.url,
        },
      },
    };
    manifest.cwd = dir;
  });

  try {
    await withSharedRuntimeEnv(dir, async () => {
      const renamed = await Promise.race([
        setRunName(outcome.runId, { name: "Post-open failure" }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("setRunName timed out after codex transport error")),
            2_000,
          ),
        ),
      ]);
      assert.deepEqual(renamed, {
        runId: outcome.runId,
        name: "Post-open failure",
        changed: true,
      });
    });

    const manifest = readManifest(outcome.workspaceDir);
    assert.equal(manifest.name, "Post-open failure");
    assert.equal(manifest.resetSeed.name, "Post-open failure");
    assert.deepEqual(codexServer.renameCalls, [
      { threadId: "thr_rename", name: "Post-open failure" },
    ]);
  } finally {
    await codexServer.close();
  }
});

test("command services: setRunName propagates pi session renames into the session file", async () => {
  const dir = tempDir();
  const piHome = join(dir, ".pi-home");
  const sessionId = "pi-session-rename";
  const command = writeFakePiRenameAgent(dir);
  const bucketDir = join(piHome, "agent", "sessions", encodePiSessionDir(dir));
  mkdirSync(bucketDir, { recursive: true });
  writeBundle(dir);
  const outcome = await initRun(dir);
  const sessionPath = join(bucketDir, `2026-04-17T12-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-04-17T12:00:00.000Z",
      cwd: dir,
    })}\n${JSON.stringify({
      type: "message",
      id: "assistant-msg-1",
      parentId: null,
      timestamp: "2026-04-17T12:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Existing answer" }],
      },
    })}\n`,
  );

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.backend = "pi";
    manifest.backendSessionId = sessionId;
    manifest.cwd = dir;
  });

  await withEnv({ PI_HOME: piHome, TASK_RUNNER_PI_BIN: command }, () =>
    withSharedRuntimeEnv(dir, async () => {
      const renamed = await setRunName(outcome.runId, { name: "  Pi rename  " });
      assert.deepEqual(renamed, {
        runId: outcome.runId,
        name: "Pi rename",
        changed: true,
      });
    }),
  );

  const sessionLines = readFileSync(sessionPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const infoEntry = sessionLines.find((entry) => entry.type === "session_info");
  assert.ok(infoEntry);
  assert.equal(infoEntry.name, "Pi rename");
});

test("command services: archiveRun and unarchiveRun are idempotent and reject running runs", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const archived = archiveRun(outcome.runId);
    assert.equal(archived.changed, true);
    assert.ok(archived.archivedAt);
    assert.equal(archived.runId, outcome.runId);

    const archivedAgain = archiveRun(outcome.runId);
    assert.equal(archivedAgain.changed, false);
    assert.equal(archivedAgain.archivedAt, archived.archivedAt);

    const unarchived = unarchiveRun(outcome.runId);
    assert.equal(unarchived.changed, true);
    assert.equal(unarchived.archivedAt, null);

    const unarchivedAgain = unarchiveRun(outcome.runId);
    assert.equal(unarchivedAgain.changed, false);
    assert.equal(unarchivedAgain.archivedAt, null);
  });

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
  });

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => archiveRun(outcome.runId),
      (err) => err instanceof CommandError && /cannot archive a running run/.test(err.message),
    );
    assert.throws(
      () => unarchiveRun(outcome.runId),
      (err) => err instanceof CommandError && /cannot unarchive a running run/.test(err.message),
    );
  });
});
