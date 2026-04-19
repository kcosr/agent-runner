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
  downloadAttachment,
  listAttachments,
  listDefinitions,
  listRuns,
  listTasks,
  readStatus,
  removeAttachment,
  removeRunDependency,
  setRunBackendSession,
  setRunName,
  setRunNote,
  setRunPinned,
  setTask,
  showDefinition,
  showTask,
  unarchiveRun,
} from "../packages/core/dist/core/commands/service.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { withEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

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
    manifest.assignmentPath = join(nextWorkspaceDir, "assignment.md");
    if (manifest.assignment) {
      manifest.assignment.workspacePath = join(nextWorkspaceDir, "assignment.md");
    }
  });
  return nextWorkspaceDir;
}

async function initRun(baseDir, assignmentName = "svc-work", agentName = "svc-agent") {
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
    manifest.attempts = 2;
    manifest.sessionCount = 1;
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
        firstAttempt: 1,
        lastAttempt: 2,
        maxAttempts: 3,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: "thread-original",
      },
    ];
    manifest.attemptRecords = [
      {
        attempt: 1,
        sessionIndex: 0,
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
        tasksAfter: manifest.finalTasks,
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
    attempts: before.attempts,
    sessionCount: before.sessionCount,
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
      attempts: after.attempts,
      sessionCount: after.sessionCount,
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

test("command services: getRunTimelineHistory degrades missing, corrupt, or escaping attempt logs", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const attemptsDir = join(outcome.workspaceDir, "attempts");
  mkdirSync(attemptsDir, { recursive: true });
  writeFileSync(join(attemptsDir, "02.json"), "{\n");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.attemptRecords = [
      {
        attempt: 1,
        sessionIndex: 0,
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
        tasksAfter: manifest.finalTasks,
        invalidStatuses: [],
      },
      {
        attempt: 2,
        sessionIndex: 0,
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
        tasksAfter: manifest.finalTasks,
        invalidStatuses: [],
      },
      {
        attempt: 3,
        sessionIndex: 0,
        startedAt: "2026-04-15T01:04:00.000Z",
        endedAt: "2026-04-15T01:05:00.000Z",
        prompt: "Attempt three",
        sessionIdAtStart: null,
        sessionIdCaptured: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "Third output",
        logPath: "../outside.json",
        tasksAfter: manifest.finalTasks,
        invalidStatuses: [],
      },
    ];
    manifest.attempts = manifest.attemptRecords.length;
  });

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

test("command services: listDefinitions and showDefinition return typed config results", async () => {
  const dir = tempDir();
  writeBundle(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const agents = listDefinitions("agent");
    const assignments = listDefinitions("assignment");
    const assignment = showDefinition("assignment", "svc-work");

    assert.equal(agents.kind, "agent");
    assert.equal(assignments.kind, "assignment");
    assert.ok(agents.entries.some((entry) => entry.name === "svc-agent"));
    assert.ok(assignments.entries.some((entry) => entry.name === "svc-work"));
    assert.equal(assignment.kind, "assignment");
    assert.equal(assignment.loaded.config.name, "svc-work");
    assert.match(assignment.loaded.instructions, /Service test assignment/);
  });
});

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
      canResume: false,
      canAbort: false,
      abortReason: "not_active_in_daemon",
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
        attempt: 1,
        sessionIndex: 0,
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
        tasksAfter: manifest.finalTasks,
        invalidStatuses: [],
      },
    ];
    manifest.attempts = 1;
  });

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

test("command services: listRuns tolerates missing workspace assignment artifacts", async () => {
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
  assert.equal(existsSync(outcome.assignmentPath), false);

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
    const updated = setTask(outcome.runId, "t1", {
      status: "in_progress",
      notes: "Investigating.",
    });
    assert.equal(updated.task.status, "in_progress");
    assert.equal(updated.task.notes, "Investigating.");

    const appended = appendTaskNotes(outcome.runId, "t1", "Waiting on confirmation.");
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
    const added = addTask(outcome.runId, {
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
    const added = addRunDependency(target.runId, dependency.runId);
    assert.deepEqual(added, {
      runId: target.runId,
      dependencyRunIds: [dependency.runId],
      changed: true,
    });

    const detail = readStatus(target.runId);
    assert.deepEqual(detail.dependencies, [
      {
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

    const removed = removeRunDependency(target.runId, dependency.runId);
    assert.deepEqual(removed, {
      runId: target.runId,
      dependencyRunIds: [],
      changed: true,
    });

    const cleared = clearRunDependencies(target.runId);
    assert.deepEqual(cleared, {
      runId: target.runId,
      dependencyRunIds: [],
      changed: false,
    });
  });

  const manifest = readManifest(target.workspaceDir);
  assert.deepEqual(manifest.dependencyRunIds, []);
  assert.deepEqual(manifest.resetSeed.dependencyRunIds, []);
});

test("command services: dependency mutations reject missing runs, self edges, duplicates, cycles, and non-initialized targets", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const target = await initRun(dir);
  const dependency = await initRun(dir);
  const downstream = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => addRunDependency(target.runId, "missing-run"),
      (err) =>
        err instanceof CommandError &&
        /run add-dep: dependency run missing-run was not found/.test(err.message),
    );

    assert.throws(
      () => addRunDependency(target.runId, target.runId),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`run add-dep: run ${target.runId} cannot depend on itself`).test(err.message),
    );

    addRunDependency(target.runId, dependency.runId);
    assert.throws(
      () => addRunDependency(target.runId, dependency.runId),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`dependency ${dependency.runId} already exists on run ${target.runId}`).test(
          err.message,
        ),
    );

    addRunDependency(dependency.runId, downstream.runId);
    assert.throws(
      () => addRunDependency(downstream.runId, target.runId),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`adding dependency ${target.runId} would create a cycle`).test(err.message),
    );

    patchManifest(target.workspaceDir, (manifest) => {
      manifest.status = "success";
      manifest.endedAt = "2026-04-12T10:15:00.000Z";
      manifest.exitCode = 0;
    });

    assert.throws(
      () => addRunDependency(target.runId, downstream.runId),
      (err) =>
        err instanceof CommandError &&
        new RegExp(`cannot add dependencies unless run ${target.runId} is initialized`).test(
          err.message,
        ),
    );
    assert.throws(
      () => removeRunDependency(target.runId, dependency.runId),
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
  otherManifest.assignmentPath = join(otherWorkspaceDir, "assignment.md");
  otherManifest.startedAt = "2026-04-12T09:00:00.000Z";
  otherManifest.archivedAt = null;
  writeFileSync(join(otherWorkspaceDir, "run.json"), `${JSON.stringify(otherManifest, null, 2)}\n`);
  writeFileSync(otherManifest.assignmentPath, "# Assignment\n");

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
      canResume: true,
      canAbort: false,
      abortReason: "not_active_in_daemon",
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
      canResume: false,
      canAbort: false,
      abortReason: "not_active_in_daemon",
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

test("command services: attachment list cwd scope includes exact same-cwd peers only", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const target = await initRun(dir);
  const peer = await initRun(dir);
  const different = await initRun(dir);
  const targetFile = join(dir, "target.txt");
  const peerFile = join(dir, "peer.txt");
  const differentFile = join(dir, "different.txt");
  writeFileSync(targetFile, "target\n");
  writeFileSync(peerFile, "peer\n");
  writeFileSync(differentFile, "different\n");

  patchManifest(different.workspaceDir, (manifest) => {
    manifest.cwd = join(dir, "other-cwd");
  });

  await withSharedRuntimeEnv(dir, async () => {
    await addAttachmentFromFile(target.runId, { sourcePath: targetFile });
    await addAttachmentFromFile(peer.runId, { sourcePath: peerFile });
    await addAttachmentFromFile(different.runId, { sourcePath: differentFile });

    const runOnly = listAttachments(target.runId);
    assert.deepEqual(
      runOnly.attachments.map((attachment) => attachment.ownerRunId),
      [target.runId],
    );

    const scoped = listAttachments(target.runId, { cwdScope: true });
    assert.equal(scoped.attachments.length, 2);
    assert.deepEqual(
      new Set(scoped.attachments.map((attachment) => attachment.ownerRunId)),
      new Set([target.runId, peer.runId]),
    );
    assert.equal(
      scoped.attachments.some((attachment) => attachment.ownerRunId === different.runId),
      false,
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
