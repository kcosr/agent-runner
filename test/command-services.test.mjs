import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CommandError,
  addTask,
  appendTaskNotes,
  archiveRun,
  listDefinitions,
  listRuns,
  listTasks,
  readStatus,
  setTask,
  showDefinition,
  showTask,
  unarchiveRun,
} from "../dist/commands/service.js";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { runAgent } from "../dist/runner/run-loop.js";
import { withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const AGENT = `---
schemaVersion: 1
name: svc-agent
backend: claude
model: claude-sonnet-4-6
---
Service test agent.
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

function editTaskStatus(content, taskId, status) {
  const marker = `<!-- task-id: ${taskId} -->`;
  const start = content.indexOf(marker);
  const nextMarker = content.indexOf("<!-- task-id:", start + marker.length);
  const end = nextMarker < 0 ? content.length : nextMarker;
  const section = content.slice(start, end);
  return (
    content.slice(0, start) +
    section.replace(/\*\*Status:\*\*\s*\S+/, `**Status:** ${status}`) +
    content.slice(end)
  );
}

async function initRun(baseDir, assignmentName = "svc-work") {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("svc-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig(assignmentName, baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: {
          id: "mock",
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

test("command services: readStatus applies the live workspace overlay for running file-mode runs", async () => {
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

  let assignmentText = readFileSync(outcome.assignmentPath, "utf8");
  assignmentText = editTaskStatus(assignmentText, "t1", "completed");
  assignmentText = editTaskStatus(assignmentText, "t2", "in_progress");
  writeFileSync(outcome.assignmentPath, assignmentText);

  await withSharedRuntimeEnv(dir, async () => {
    const result = readStatus(outcome.runId);
    assert.equal(result.isLive, true);
    assert.equal(result.manifest.finalTasks.t1.status, "completed");
    assert.equal(result.manifest.finalTasks.t2.status, "in_progress");
    assert.equal(result.manifest.tasksCompleted, 1);
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

test("command services: listRuns returns newest-first rows and filters archived unless requested", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const first = await initRun(dir);
  const second = await initRun(dir);

  patchManifest(first.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T10:00:00.000Z";
    manifest.archivedAt = "2026-04-12T12:00:00.000Z";
  });
  patchManifest(second.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T11:00:00.000Z";
  });

  const otherWorkspaceDir = join(dir, "runs", "other-repo", "oth123");
  mkdirSync(otherWorkspaceDir, { recursive: true });
  const otherManifest = readManifest(second.workspaceDir);
  otherManifest.runId = "oth123";
  otherManifest.workspaceDir = otherWorkspaceDir;
  otherManifest.assignmentPath = join(otherWorkspaceDir, "assignment.md");
  otherManifest.startedAt = "2026-04-12T09:00:00.000Z";
  otherManifest.archivedAt = null;
  writeFileSync(join(otherWorkspaceDir, "run.json"), `${JSON.stringify(otherManifest, null, 2)}\n`);
  writeFileSync(otherManifest.assignmentPath, "# Assignment\n");

  mkdirSync(join(dir, "runs", "broken-repo", "bad999"), { recursive: true });
  writeFileSync(join(dir, "runs", "broken-repo", "bad999", "run.json"), "{not json\n");

  await withSharedRuntimeEnv(dir, async () => {
    const visible = listRuns();
    assert.deepEqual(
      visible.runs.map((run) => run.runId),
      [second.runId, "oth123"],
    );
    assert.equal(visible.runs[0].repo, "unknown");
    assert.equal(visible.runs[1].repo, "other-repo");

    const allRuns = listRuns({ includeArchived: true });
    assert.deepEqual(
      allRuns.runs.map((run) => run.runId),
      [second.runId, first.runId, "oth123"],
    );
    assert.equal(allRuns.runs[1].archivedAt, "2026-04-12T12:00:00.000Z");
  });
});

test("command services: archiveRun and unarchiveRun are idempotent and reject running runs", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const archived = archiveRun(outcome.runId);
    assert.equal(archived.changed, true);
    assert.ok(archived.manifest.archivedAt);

    const archivedAgain = archiveRun(outcome.runId);
    assert.equal(archivedAgain.changed, false);
    assert.equal(archivedAgain.manifest.archivedAt, archived.manifest.archivedAt);

    const unarchived = unarchiveRun(outcome.runId);
    assert.equal(unarchived.changed, true);
    assert.equal(unarchived.manifest.archivedAt, null);

    const unarchivedAgain = unarchiveRun(outcome.runId);
    assert.equal(unarchivedAgain.changed, false);
    assert.equal(unarchivedAgain.manifest.archivedAt, null);
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
