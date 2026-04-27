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
import { readyRun, setRunSchedule } from "../packages/core/dist/core/commands/service.js";
import { loadedAgentFromManifest } from "../packages/core/dist/core/config/loaded.js";
import { resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { readRunAuditHistory } from "../packages/core/dist/core/run/run-events.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import {
  completeAllTasksFromPrompt,
  setTaskStatusesForPrompt,
  withSharedRuntimeEnv,
} from "./helpers/runtime-paths.mjs";

const AGENT = `---
schemaVersion: 1
name: scheduled-agent
backend: claude
---
Run the scheduled work.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: scheduled-work
tasks:
  - id: t1
    title: First
    body: Do the first thing.
  - id: t2
    title: Second
    body: Do the second thing.
maxRetries: 0
---
Scheduled work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-run-loop-schedule-"));
}

function writeBundle(baseDir) {
  const agentDir = join(baseDir, "agents", "scheduled-agent");
  const assignmentDir = join(baseDir, "assignments", "scheduled-work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(assignmentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.md"), AGENT);
  writeFileSync(join(assignmentDir, "assignment.md"), ASSIGNMENT);
}

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

function writeManifest(workspaceDir, manifest) {
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function patchManifest(workspaceDir, mutator) {
  const manifest = readManifest(workspaceDir);
  mutator(manifest);
  writeManifest(workspaceDir, manifest);
  return manifest;
}

function backend(handler) {
  return {
    id: "claude",
    async invoke(ctx) {
      await handler?.(ctx);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: "session-schedule",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
  };
}

async function initRun(baseDir, overrides = {}, options = {}) {
  return await withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("scheduled-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig("scheduled-work", baseDir);
    return await runAgent({
      loaded,
      loadedAssignment,
      cliVars: {},
      webVars: {},
      backend: backend(() => {
        throw new Error("init should not invoke the backend");
      }),
      initialize: true,
      parentRunId: options.parentRunId ?? null,
      callerCwd: baseDir,
      overrides,
    });
  });
}

async function runReady(baseDir, runId, invoke, overrides = {}) {
  return await withSharedRuntimeEnv(baseDir, async () => {
    const target = resolveResumeTarget(runId);
    return await runAgent({
      loaded: loadedAgentFromManifest(target.manifest),
      cliVars: {},
      webVars: {},
      backend: backend(invoke),
      resume: target,
      overrides,
    });
  });
}

function readyInitializedRun(baseDir, runId) {
  return withSharedRuntimeEnv(baseDir, () => readyRun(runId));
}

function setDue(workspaceDir) {
  patchManifest(workspaceDir, (manifest) => {
    manifest.schedule.runAt = "2000-01-01T00:00:00.000Z";
  });
}

function repoManifests(baseDir, repo) {
  const repoDir = join(baseDir, "runs", repo);
  return readdirSync(repoDir).map((runId) => readManifest(join(repoDir, runId)));
}

test("run-loop schedules: init applies schedule and ready-start consumes one-time schedules", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const init = await initRun(dir, { schedule: { at: "2099-01-01T00:00:00.000Z" } });
  assert.equal(init.manifest.schedule.runAt, "2099-01-01T00:00:00.000Z");
  readyInitializedRun(dir, init.runId);

  const outcome = await runReady(dir, init.runId, (ctx) => {
    assert.equal(readManifest(resolveResumeTarget(init.runId).workspaceDir).schedule, null);
    completeAllTasksFromPrompt(ctx.prompt, dir);
  });

  assert.equal(outcome.summary.status, "success");
  assert.equal(readManifest(outcome.workspaceDir).schedule, null);
});

test("run-loop schedules: early recurring manual run leaves runAt untouched and waits ready", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const init = await initRun(dir, {
    schedule: { cron: "*/5 * * * *", timezone: "UTC", mode: "reuse" },
  });
  readyInitializedRun(dir, init.runId);
  const before = readManifest(init.workspaceDir).schedule.runAt;

  const outcome = await runReady(dir, init.runId, () => {});
  const after = readManifest(init.workspaceDir);

  assert.equal(outcome.summary.status, "ready");
  assert.equal(outcome.exitCode, 0);
  assert.equal(after.status, "ready");
  assert.equal(after.exitCode, null);
  assert.equal(after.endedAt, null);
  assert.equal(after.schedule.runAt, before);
  const audit = readRunAuditHistory({ workspaceDir: init.workspaceDir, runId: init.runId });
  assert.equal(
    audit.events.some((event) => event.event.type === "run.schedule_advanced"),
    false,
  );
});

test("run-loop schedules: due recurring ready promotion advances runAt", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const init = await initRun(dir, {
    schedule: { cron: "*/5 * * * *", timezone: "UTC", mode: "reuse" },
  });
  readyInitializedRun(dir, init.runId);
  setDue(init.workspaceDir);
  const before = readManifest(init.workspaceDir).schedule.runAt;

  const outcome = await runReady(dir, init.runId, () => {});
  const after = readManifest(init.workspaceDir);

  assert.equal(outcome.summary.status, "ready");
  assert.equal(after.status, "ready");
  assert.notEqual(after.schedule.runAt, before);
  assert.ok(new Date(after.schedule.runAt).getTime() > new Date(before).getTime());
});

test("run-loop schedules: future clone recurrence moves schedule to clone", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const source = await initRun(dir, {
    schedule: { cron: "*/5 * * * *", timezone: "UTC", mode: "clone" },
  });
  readyInitializedRun(dir, source.runId);
  const before = readManifest(source.workspaceDir).schedule;

  await runReady(dir, source.runId, (ctx) => completeAllTasksFromPrompt(ctx.prompt, dir));

  const sourceAfter = readManifest(source.workspaceDir);
  const manifests = repoManifests(dir, source.manifest.repo);
  const cloneManifest = manifests.find(
    (manifest) =>
      manifest.runId !== source.runId &&
      manifest.status === "ready" &&
      manifest.schedule?.runAt === before.runAt,
  );

  assert.equal(sourceAfter.status, "success");
  assert.equal(sourceAfter.schedule, null);
  assert.ok(cloneManifest);
  assert.equal(cloneManifest.schemaVersion, 14);
  assert.deepEqual(cloneManifest.assignment, {
    name: "scheduled-work",
    sourcePath: join(dir, "assignments", "scheduled-work", "assignment.md"),
  });
  assert.equal("assignmentPath" in cloneManifest, false);
  assert.equal("workspacePath" in cloneManifest.assignment, false);
  assert.equal(existsSync(join(cloneManifest.workspaceDir, "assignment-seed.md")), true);
  assert.equal(cloneManifest.exitCode, null);
  assert.equal(cloneManifest.endedAt, null);
  assert.deepEqual(cloneManifest.schedule, before);
});

test("run-loop schedules: running schedule mutations are refreshed before retry or exhaustion", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const init = await initRun(dir);
  readyInitializedRun(dir, init.runId);

  const outcome = await runReady(dir, init.runId, () => {
    setRunSchedule(init.runId, { at: "2099-01-01T00:00:00.000Z" });
  });
  const manifest = readManifest(init.workspaceDir);

  assert.equal(outcome.summary.status, "ready");
  assert.equal(outcome.exitCode, 0);
  assert.equal(manifest.status, "ready");
  assert.equal(manifest.schedule.runAt, "2099-01-01T00:00:00.000Z");
  assert.equal(manifest.totalAttemptCount, 1);
});

test("run-loop schedules: recurring failures stop or continue according to continueOnFailure", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const stop = await initRun(dir, {
    schedule: {
      cron: "*/5 * * * *",
      timezone: "UTC",
      mode: "reuse",
      continueOnFailure: false,
    },
  });
  readyInitializedRun(dir, stop.runId);
  setDue(stop.workspaceDir);

  const stopped = await runReady(dir, stop.runId, (ctx) => {
    setTaskStatusesForPrompt(ctx.prompt, { t1: "blocked" }, dir);
  });
  assert.equal(stopped.summary.status, "blocked");
  assert.equal(readManifest(stop.workspaceDir).status, "blocked");

  const cont = await initRun(dir, {
    schedule: {
      cron: "*/5 * * * *",
      timezone: "UTC",
      mode: "reuse",
      continueOnFailure: true,
    },
  });
  readyInitializedRun(dir, cont.runId);
  setDue(cont.workspaceDir);
  const previousRunAt = readManifest(cont.workspaceDir).schedule.runAt;

  const continued = await runReady(dir, cont.runId, (ctx) => {
    setTaskStatusesForPrompt(ctx.prompt, { t1: "blocked" }, dir);
  });
  const manifest = readManifest(cont.workspaceDir);

  assert.equal(continued.summary.status, "ready");
  assert.equal(manifest.status, "ready");
  assert.notEqual(manifest.schedule.runAt, previousRunAt);
});

test("run-loop schedules: recurring reuse resumes increment session indexes after ready promotion", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const init = await initRun(dir, {
    schedule: {
      cron: "*/5 * * * *",
      timezone: "UTC",
      mode: "reuse",
      continueOnFailure: true,
    },
  });
  readyInitializedRun(dir, init.runId);
  setDue(init.workspaceDir);

  const first = await runReady(dir, init.runId, (ctx) => {
    completeAllTasksFromPrompt(ctx.prompt, dir);
  });
  const firstManifest = readManifest(init.workspaceDir);

  assert.equal(first.summary.status, "ready");
  assert.equal(firstManifest.status, "ready");
  assert.equal(firstManifest.totalSessionCount, 1);
  assert.deepEqual(
    firstManifest.sessions.map((session) => session.sessionIndex),
    [0],
  );
  assert.deepEqual(
    firstManifest.attemptRecords.map((attempt) => attempt.sessionIndex),
    [0],
  );

  setDue(init.workspaceDir);
  const second = await runReady(dir, init.runId, () => {}, {
    message: "Resuming after scheduled delay.",
  });
  const secondManifest = readManifest(init.workspaceDir);

  assert.equal(second.summary.status, "ready");
  assert.equal(secondManifest.status, "ready");
  assert.equal(secondManifest.totalSessionCount, 2);
  assert.deepEqual(
    secondManifest.sessions.map((session) => session.sessionIndex),
    [0, 1],
  );
  assert.deepEqual(
    secondManifest.attemptRecords.map((attempt) => attempt.sessionIndex),
    [0, 1],
  );
});

test("run-loop schedules: reuse, reset, and clone recurrence modes use frozen reset state", async () => {
  const dir = tempDir();
  writeBundle(dir);

  const reuse = await initRun(dir, {
    schedule: { cron: "*/5 * * * *", timezone: "UTC", mode: "reuse" },
  });
  readyInitializedRun(dir, reuse.runId);
  setDue(reuse.workspaceDir);
  await runReady(dir, reuse.runId, (ctx) => completeAllTasksFromPrompt(ctx.prompt, dir));
  const reused = readManifest(reuse.workspaceDir);
  assert.equal(reused.status, "ready");
  assert.equal(reused.totalAttemptCount, 1);
  assert.equal(reused.finalTasks.t1.status, "completed");

  const reset = await initRun(dir, {
    schedule: { cron: "*/5 * * * *", timezone: "UTC", mode: "reset" },
  });
  readyInitializedRun(dir, reset.runId);
  setDue(reset.workspaceDir);
  await runReady(dir, reset.runId, (ctx) => completeAllTasksFromPrompt(ctx.prompt, dir));
  const resetManifest = readManifest(reset.workspaceDir);
  assert.equal(resetManifest.status, "ready");
  assert.equal(resetManifest.totalAttemptCount, 0);
  assert.equal(resetManifest.totalSessionCount, 0);
  assert.equal(resetManifest.finalTasks.t1.status, "pending");

  const clone = await initRun(
    dir,
    {
      schedule: { cron: "*/5 * * * *", timezone: "UTC", mode: "clone" },
    },
    {
      parentRunId: reuse.runId,
    },
  );
  readyInitializedRun(dir, clone.runId);
  setDue(clone.workspaceDir);
  await runReady(dir, clone.runId, (ctx) => completeAllTasksFromPrompt(ctx.prompt, dir));

  const manifests = repoManifests(dir, clone.manifest.repo);
  const cloneManifest = manifests.find(
    (manifest) =>
      manifest.runId !== clone.runId &&
      manifest.status === "ready" &&
      manifest.schedule?.recurrence?.mode === "clone",
  );
  assert.ok(cloneManifest);
  assert.equal(readManifest(clone.workspaceDir).status, "success");
  assert.equal(readManifest(clone.workspaceDir).schedule, null);
  assert.equal(cloneManifest.schemaVersion, 14);
  assert.deepEqual(cloneManifest.assignment, {
    name: "scheduled-work",
    sourcePath: join(dir, "assignments", "scheduled-work", "assignment.md"),
  });
  assert.equal("assignmentPath" in cloneManifest, false);
  assert.equal("workspacePath" in cloneManifest.assignment, false);
  assert.equal(existsSync(join(cloneManifest.workspaceDir, "assignment-seed.md")), true);
  assert.equal(cloneManifest.status, "ready");
  assert.equal(cloneManifest.exitCode, null);
  assert.equal(cloneManifest.totalAttemptCount, 0);
  assert.equal(cloneManifest.totalSessionCount, 0);
  assert.equal(cloneManifest.schedule.recurrence.mode, "clone");
  assert.equal(cloneManifest.resetSeed.parentRunId, reuse.runId);
});
