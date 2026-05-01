import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { syncBackendSessionHistory } from "../packages/core/dist/core/run/backend-session-sync.js";
import { applyRunResetSeed, resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const AGENT = `---
schemaVersion: 1
name: sync-agent
backend: claude
model: claude-sonnet-4-6
---
Agent.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: sync-work
maxRetries: 0
tasks:
  - id: t1
    title: First
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-session-sync-"));
}

function writeProject(baseDir) {
  const agentDir = join(baseDir, "agents", "sync-agent");
  const assignmentDir = join(baseDir, "assignments", "sync-work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(assignmentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.md"), AGENT);
  writeFileSync(join(assignmentDir, "assignment.md"), ASSIGNMENT);
}

function fileSource(path, token = "v1") {
  return {
    kind: "custom",
    label: path,
    changeToken: { token },
  };
}

function historyBackend({ turns, source = fileSource("history"), invoke, read }) {
  return {
    id: "claude",
    async validateSessionId() {
      return { valid: true };
    },
    async resolveSessionHistorySource() {
      return { available: true, source };
    },
    async readSessionHistory(ctx) {
      if (read) {
        return read(ctx);
      }
      return {
        source,
        cursor: { offset: turns.length },
        turns,
      };
    },
    async invoke(ctx) {
      if (invoke) {
        return invoke(ctx);
      }
      throw new Error("backend.invoke should not be called");
    },
  };
}

function completeTask(workspaceDir, taskId) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.finalTasks[taskId].status = "completed";
  manifest.tasksCompleted = 1;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function runIn(baseDir, opts) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("sync-agent", baseDir);
    const loadedAssignment = opts.resume ? undefined : loadAssignmentConfig("sync-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: opts.backend,
        bootstrapBackendSessionId: opts.bootstrapBackendSessionId,
        initialize: opts.initialize ?? false,
        resume: opts.resume,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("bootstrap import writes complete backend turns as canonical sessions and attempts", async () => {
  const dir = tempDir();
  writeProject(dir);
  const source = fileSource("bootstrap", "v1");
  const turns = [
    {
      backendTurnId: "turn-1",
      status: "complete",
      startedAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-20T10:01:00.000Z",
      userText: "first prompt",
      assistantText: "first answer",
    },
    {
      backendTurnId: "turn-2",
      status: "complete",
      startedAt: "2026-04-20T10:02:00.000Z",
      updatedAt: "2026-04-20T10:03:00.000Z",
      userText: "second prompt",
      assistantText: "second answer",
    },
    {
      backendTurnId: "turn-open",
      status: "open",
      startedAt: "2026-04-20T10:04:00.000Z",
      updatedAt: "2026-04-20T10:04:30.000Z",
      userText: "open prompt",
      assistantText: null,
    },
  ];

  const outcome = await runIn(dir, {
    backend: historyBackend({ turns, source }),
    bootstrapBackendSessionId: "session-1",
    initialize: true,
  });

  assert.equal(outcome.manifest.status, "initialized");
  assert.equal(outcome.summary.totalAttemptCount, 2);
  assert.equal(outcome.summary.totalSessionCount, 2);
  assert.equal(outcome.manifest.backendSessionId, "session-1");
  assert.deepEqual(
    outcome.manifest.attemptRecords.map((record) => record.attemptNumber),
    [1, 2],
  );
  assert.deepEqual(
    outcome.manifest.sessions.map((record) => record.sessionIndex),
    [0, 1],
  );
  assert.deepEqual(outcome.manifest.backendSessionSync.importedTurnIds, ["turn-1", "turn-2"]);
  assert.deepEqual(outcome.manifest.backendSessionSync.openTurnIds, ["turn-open"]);
  assert.deepEqual(outcome.manifest.backendSessionSync.cursor, { offset: 3 });
  assert.equal(outcome.manifest.attemptRecords[0].provenance.kind, "backend_session");
  assert.equal(outcome.manifest.attemptRecords[0].provenance.backendTurnId, "turn-1");
  assert.equal(outcome.manifest.attemptRecords[0].prompt, "first prompt");
  assert.equal(outcome.manifest.attemptRecords[0].transcript, "first answer");
  assert.ok(existsSync(join(outcome.workspaceDir, "attempts", "01.json")));
  assert.ok(existsSync(join(outcome.workspaceDir, "attempts", "02.json")));
});

test("sync is idempotent and open turns update only sync metadata", async () => {
  const dir = tempDir();
  writeProject(dir);
  const initial = await runIn(dir, {
    backend: historyBackend({
      source: fileSource("sync", "v1"),
      turns: [
        {
          backendTurnId: "complete-1",
          status: "complete",
          startedAt: "2026-04-20T11:00:00.000Z",
          updatedAt: "2026-04-20T11:01:00.000Z",
          userText: "prompt",
          assistantText: "answer",
        },
      ],
    }),
    bootstrapBackendSessionId: "session-2",
    initialize: true,
  });

  const unchanged = await syncBackendSessionHistory({
    manifest: initial.manifest,
    backend: historyBackend({
      source: fileSource("sync", "v1"),
      turns: [],
    }),
    mode: "sync",
  });
  assert.equal(unchanged.status, "skipped");
  assert.equal(unchanged.reason, "unchanged");
  assert.equal(initial.manifest.attemptRecords.length, 1);

  const changed = await syncBackendSessionHistory({
    manifest: initial.manifest,
    backend: historyBackend({
      source: fileSource("sync", "v2"),
      turns: [
        {
          backendTurnId: "complete-1",
          status: "complete",
          startedAt: "2026-04-20T11:00:00.000Z",
          updatedAt: "2026-04-20T11:01:30.000Z",
          userText: "prompt",
          assistantText: "updated answer",
        },
        {
          backendTurnId: "open-1",
          status: "open",
          startedAt: "2026-04-20T11:02:00.000Z",
          updatedAt: "2026-04-20T11:02:30.000Z",
          userText: "open",
          assistantText: null,
        },
      ],
    }),
    mode: "sync",
  });

  assert.equal(changed.status, "synced");
  assert.equal(initial.manifest.attemptRecords.length, 1);
  assert.equal(initial.manifest.attemptRecords[0].transcript, "updated answer");
  assert.deepEqual(initial.manifest.backendSessionSync.importedTurnIds, ["complete-1"]);
  assert.deepEqual(initial.manifest.backendSessionSync.openTurnIds, ["open-1"]);
});

test("sync promotes an open backend turn to a complete imported attempt", async () => {
  const dir = tempDir();
  writeProject(dir);
  const initial = await runIn(dir, {
    backend: historyBackend({
      source: fileSource("open-complete", "v1"),
      turns: [
        {
          backendTurnId: "turn-open",
          status: "open",
          startedAt: "2026-04-20T11:02:00.000Z",
          updatedAt: "2026-04-20T11:02:30.000Z",
          userText: "open",
          assistantText: null,
        },
      ],
    }),
    bootstrapBackendSessionId: "session-open-complete",
    initialize: true,
  });
  assert.equal(initial.manifest.attemptRecords.length, 0);
  assert.deepEqual(initial.manifest.backendSessionSync.openTurnIds, ["turn-open"]);

  const result = await syncBackendSessionHistory({
    manifest: initial.manifest,
    backend: historyBackend({
      source: fileSource("open-complete", "v2"),
      turns: [
        {
          backendTurnId: "turn-open",
          status: "complete",
          startedAt: "2026-04-20T11:02:00.000Z",
          updatedAt: "2026-04-20T11:03:00.000Z",
          userText: "open",
          assistantText: "done",
        },
      ],
    }),
    mode: "sync",
  });

  assert.equal(result.status, "synced");
  assert.equal(initial.manifest.attemptRecords.length, 1);
  assert.equal(initial.manifest.totalAttemptCount, 1);
  assert.equal(initial.manifest.totalSessionCount, 1);
  assert.equal(initial.manifest.attemptRecords[0].provenance.backendTurnId, "turn-open");
  assert.equal(initial.manifest.attemptRecords[0].transcript, "done");
  assert.deepEqual(initial.manifest.backendSessionSync.importedTurnIds, ["turn-open"]);
  assert.deepEqual(initial.manifest.backendSessionSync.openTurnIds, []);
});

test("sync upgrades an overlapping task-runner attempt instead of double-counting it", async () => {
  const dir = tempDir();
  writeProject(dir);
  const first = await runIn(dir, {
    backend: historyBackend({
      turns: [],
      invoke: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: "session-overlap",
        transcript: "live answer",
        rawStdout: "",
        rawStderr: "",
      }),
    }),
  });
  assert.equal(first.manifest.attemptRecords.length, 1);
  const liveAttempt = first.manifest.attemptRecords[0];
  const result = await syncBackendSessionHistory({
    manifest: first.manifest,
    backend: historyBackend({
      source: fileSource("overlap", "v2"),
      turns: [
        {
          backendTurnId: "backend-turn-live",
          status: "complete",
          startedAt: liveAttempt.startedAt,
          updatedAt: liveAttempt.endedAt,
          userText: liveAttempt.prompt,
          assistantText: "live answer",
        },
      ],
    }),
    mode: "sync",
  });

  assert.equal(result.status, "synced");
  assert.equal(first.manifest.attemptRecords.length, 1);
  assert.equal(first.manifest.totalAttemptCount, 1);
  assert.equal(first.manifest.sessions.length, 1);
  assert.equal(first.manifest.attemptRecords[0].attemptNumber, 1);
  assert.equal(first.manifest.attemptRecords[0].provenance.kind, "backend_session");
  assert.equal(first.manifest.attemptRecords[0].provenance.backendTurnId, "backend-turn-live");
  assert.equal(first.manifest.sessions[0].provenance.kind, "backend_session");
});

test("sync rollback leaves manifest unchanged except lastError when backend result is not persistable", async () => {
  const dir = tempDir();
  writeProject(dir);
  const initial = await runIn(dir, {
    backend: historyBackend({
      source: fileSource("rollback", "v1"),
      turns: [],
    }),
    bootstrapBackendSessionId: "session-3",
    initialize: true,
  });
  const before = JSON.parse(JSON.stringify(initial.manifest));

  await assert.rejects(
    () =>
      syncBackendSessionHistory({
        manifest: initial.manifest,
        backend: historyBackend({
          source: fileSource("rollback", "v2"),
          turns: [],
          read: async () => ({
            source: fileSource("rollback", "v2"),
            cursor: () => undefined,
            turns: [],
          }),
        }),
        mode: "sync",
      }),
    /cursor is not JSON-persistable/,
  );
  const expected = JSON.parse(JSON.stringify(before));
  expected.backendSessionSync.lastError = "backend history cursor is not JSON-persistable";
  assert.deepEqual(JSON.parse(JSON.stringify(initial.manifest)), expected);
});

test("sync rollback removes attempt logs written before a later write failure", async () => {
  const dir = tempDir();
  writeProject(dir);
  const initial = await runIn(dir, {
    backend: historyBackend({
      source: fileSource("rollback-files", "v1"),
      turns: [],
    }),
    bootstrapBackendSessionId: "session-rollback-files",
    initialize: true,
  });
  mkdirSync(join(initial.workspaceDir, "attempts", "02.json"), { recursive: true });

  await assert.rejects(
    () =>
      syncBackendSessionHistory({
        manifest: initial.manifest,
        backend: historyBackend({
          source: fileSource("rollback-files", "v2"),
          turns: [
            {
              backendTurnId: "turn-1",
              status: "complete",
              startedAt: "2026-04-20T11:00:00.000Z",
              updatedAt: "2026-04-20T11:01:00.000Z",
              userText: "prompt 1",
              assistantText: "answer 1",
            },
            {
              backendTurnId: "turn-2",
              status: "complete",
              startedAt: "2026-04-20T11:02:00.000Z",
              updatedAt: "2026-04-20T11:03:00.000Z",
              userText: "prompt 2",
              assistantText: "answer 2",
            },
          ],
        }),
        mode: "sync",
      }),
    /EISDIR|ENOTDIR|directory/,
  );

  assert.equal(initial.manifest.attemptRecords.length, 0);
  assert.deepEqual(
    readdirSync(join(initial.workspaceDir, "attempts")).filter((entry) => entry === "01.json"),
    [],
  );
});

test("sync records lastError on failed reads when sync metadata already exists", async () => {
  const dir = tempDir();
  writeProject(dir);
  const initial = await runIn(dir, {
    backend: historyBackend({
      source: fileSource("last-error", "v1"),
      turns: [],
    }),
    bootstrapBackendSessionId: "session-last-error",
    initialize: true,
  });
  assert.equal(initial.manifest.backendSessionSync.lastError, null);

  await assert.rejects(
    () =>
      syncBackendSessionHistory({
        manifest: initial.manifest,
        backend: historyBackend({
          source: fileSource("last-error", "v2"),
          turns: [],
          read: async () => {
            throw new Error("history unavailable");
          },
        }),
        mode: "sync",
      }),
    /history unavailable/,
  );
  assert.equal(initial.manifest.backendSessionSync.lastError, "history unavailable");
});

test("sync skips source_unavailable without mutating the manifest", async () => {
  const dir = tempDir();
  writeProject(dir);
  const initial = await runIn(dir, {
    backend: historyBackend({
      source: fileSource("source-unavailable", "v1"),
      turns: [],
    }),
    bootstrapBackendSessionId: "session-source-unavailable",
    initialize: true,
  });
  const before = JSON.parse(JSON.stringify(initial.manifest));
  const result = await syncBackendSessionHistory({
    manifest: initial.manifest,
    backend: {
      ...historyBackend({ turns: [] }),
      async resolveSessionHistorySource() {
        return { available: false, reason: "gone" };
      },
    },
    mode: "sync",
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "source_unavailable");
  assert.deepEqual(JSON.parse(JSON.stringify(initial.manifest)), before);
});

test("reset clears imported backend history and sync state", async () => {
  const dir = tempDir();
  writeProject(dir);
  const initial = await runIn(dir, {
    backend: historyBackend({
      source: fileSource("reset", "v1"),
      turns: [
        {
          backendTurnId: "complete-reset",
          status: "complete",
          startedAt: "2026-04-20T11:00:00.000Z",
          updatedAt: "2026-04-20T11:01:00.000Z",
          userText: "prompt",
          assistantText: "answer",
        },
      ],
    }),
    bootstrapBackendSessionId: "session-reset",
    initialize: true,
  });
  assert.equal(initial.manifest.attemptRecords.length, 1);
  assert.notEqual(initial.manifest.backendSessionSync, null);

  applyRunResetSeed(initial.manifest);

  assert.equal(initial.manifest.backendSessionId, null);
  assert.equal(initial.manifest.backendSessionSync, null);
  assert.deepEqual(initial.manifest.sessions, []);
  assert.deepEqual(initial.manifest.attemptRecords, []);
});

test("pre-resume sync imports changed backend history before allocating the resumed attempt", async () => {
  const dir = tempDir();
  writeProject(dir);
  let invokeCount = 0;
  const first = await runIn(dir, {
    backend: historyBackend({
      turns: [],
      invoke: async () => {
        invokeCount++;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          sessionId: "session-4",
          transcript: "first live attempt",
          rawStdout: "",
          rawStderr: "",
        };
      },
    }),
  });
  assert.equal(first.manifest.status, "exhausted");
  assert.equal(first.manifest.attemptRecords.length, 1);
  assert.equal(invokeCount, 1);

  const target = await withSharedRuntimeEnv(dir, async () => resolveResumeTarget(first.runId, dir));
  let resumedSessionId;
  const resumed = await runIn(dir, {
    resume: target,
    backend: historyBackend({
      source: fileSource("pre-resume", "v2"),
      turns: [
        {
          backendTurnId: "synced-before-resume",
          status: "complete",
          startedAt: "2026-04-20T12:00:00.000Z",
          updatedAt: "2026-04-20T12:01:00.000Z",
          userText: "outside prompt",
          assistantText: "outside answer",
        },
      ],
      invoke: async (ctx) => {
        resumedSessionId = ctx.resumeSessionId;
        completeTask(target.workspaceDir, "t1");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          sessionId: ctx.resumeSessionId,
          transcript: "resumed live attempt",
          rawStdout: "",
          rawStderr: "",
        };
      },
    }),
  });

  assert.equal(resumedSessionId, "session-4");
  assert.deepEqual(
    resumed.manifest.attemptRecords.map((record) => [
      record.attemptNumber,
      record.provenance.kind,
      record.provenance.kind === "backend_session" ? record.provenance.backendTurnId : null,
    ]),
    [
      [1, "task_runner", null],
      [2, "backend_session", "synced-before-resume"],
      [3, "task_runner", null],
    ],
  );
  assert.equal(resumed.manifest.sessions[1].provenance.kind, "backend_session");
  assert.equal(resumed.manifest.sessions[2].backendSessionIdAtStart, "session-4");
  assert.equal(
    JSON.parse(readFileSync(join(resumed.workspaceDir, "attempts", "02.json"), "utf8"))
      .attemptNumber,
    2,
  );
});
