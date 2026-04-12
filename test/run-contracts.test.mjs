import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deriveRunCapabilities,
  toRunArchiveResult,
  toRunDetail,
  toRunSummary,
} from "../dist/contracts/runs.js";

function buildManifest(overrides = {}) {
  const finalTasks = overrides.finalTasks ?? {
    t1: {
      id: "t1",
      title: "First",
      body: "Do the first thing.",
      status: "completed",
      notes: "Done.",
    },
    t2: {
      id: "t2",
      title: "Second",
      body: "Do the second thing.",
      status: "pending",
      notes: "",
    },
  };

  return {
    schemaVersion: 3,
    runId: "run123",
    agent: {
      name: "demo-agent",
      sourcePath: "/repo/agents/demo/agent.md",
      instructions: "Agent instructions.",
    },
    assignment: {
      name: "demo-work",
      sourcePath: "/repo/assignments/demo/assignment.md",
      workspacePath: "/state/runs/demo/run123/assignment.md",
    },
    backend: "claude",
    model: "claude-sonnet-4-6",
    effort: "medium",
    message: "Finish the task list.",
    sessionName: "demo session",
    unrestricted: false,
    cwd: "/repo",
    lockedFields: ["backend"],
    timeoutSec: 3600,
    assignmentPath: "/state/runs/demo/run123/assignment.md",
    workspaceDir: "/state/runs/demo/run123",
    taskMode: undefined,
    startedAt: "2026-04-12T10:00:00.000Z",
    endedAt: null,
    archivedAt: null,
    status: "initialized",
    exitCode: null,
    attempts: 0,
    maxAttempts: 2,
    tasksCompleted: Object.values(finalTasks).filter((task) => task.status === "completed").length,
    tasksTotal: Object.keys(finalTasks).length,
    backendSessionId: null,
    runtimeVars: { repo_path: "." },
    pendingPrompt: "Prompt body",
    callerInstructions: "Caller docs",
    resetSeed: {
      model: "claude-sonnet-4-6",
      effort: "medium",
      sessionName: "demo session",
      unrestricted: false,
      timeoutSec: 3600,
      maxAttempts: 2,
      pendingPrompt: "Prompt body",
      finalTasks,
    },
    finalTasks,
    sessionCount: 0,
    sessions: [],
    attemptRecords: [],
    ...overrides,
  };
}

test("run contracts: toRunSummary maps listed manifest rows to the neutral summary DTO", () => {
  const manifest = buildManifest({
    status: "success",
    endedAt: "2026-04-12T10:05:00.000Z",
  });

  const summary = toRunSummary({
    repo: "demo-repo",
    workspaceDir: manifest.workspaceDir,
    manifest,
  });

  assert.deepEqual(summary, {
    runId: "run123",
    repo: "demo-repo",
    status: "success",
    archivedAt: null,
    agentName: "demo-agent",
    assignmentName: "demo-work",
    backend: "claude",
    model: "claude-sonnet-4-6",
    sessionName: "demo session",
    cwd: "/repo",
    startedAt: "2026-04-12T10:00:00.000Z",
    endedAt: "2026-04-12T10:05:00.000Z",
    tasksCompleted: 1,
    tasksTotal: 2,
  });
});

test("run contracts: toRunDetail maps status results to the neutral detail DTO", () => {
  const manifest = buildManifest({
    status: "success",
    endedAt: "2026-04-12T10:05:00.000Z",
    exitCode: 0,
    attempts: 1,
    backendSessionId: "sess-123",
  });

  const detail = toRunDetail({
    manifest,
    isLive: true,
  });

  assert.equal(detail.runId, "run123");
  assert.equal(detail.status, "success");
  assert.equal(detail.isLive, true);
  assert.equal(detail.taskMode, "file");
  assert.equal(detail.assignment.workspacePath, "/state/runs/demo/run123/assignment.md");
  assert.deepEqual(
    detail.tasks.map((task) => task.id),
    ["t1", "t2"],
  );
  assert.equal(detail.tasks[0].notes, "Done.");
  assert.deepEqual(detail.lockedFields, ["backend"]);
  assert.deepEqual(detail.runtimeVars, { repo_path: "." });
  assert.deepEqual(detail.capabilities, {
    canArchive: true,
    canUnarchive: false,
    canResume: true,
    canAbort: false,
    canMutateTasks: true,
  });
});

test("run contracts: deriveRunCapabilities reflects archive, resume, and task-mutation semantics", () => {
  const initialized = deriveRunCapabilities(buildManifest());
  assert.deepEqual(initialized, {
    canArchive: true,
    canUnarchive: false,
    canResume: true,
    canAbort: false,
    canMutateTasks: true,
  });

  const archived = deriveRunCapabilities(
    buildManifest({
      status: "success",
      archivedAt: "2026-04-12T11:00:00.000Z",
      endedAt: "2026-04-12T10:05:00.000Z",
      exitCode: 0,
      attempts: 1,
    }),
  );
  assert.deepEqual(archived, {
    canArchive: false,
    canUnarchive: true,
    canResume: false,
    canAbort: false,
    canMutateTasks: true,
  });

  const runningFileMode = deriveRunCapabilities(
    buildManifest({
      status: "running",
    }),
  );
  assert.deepEqual(runningFileMode, {
    canArchive: false,
    canUnarchive: false,
    canResume: false,
    canAbort: false,
    canMutateTasks: false,
  });

  const runningCliMode = deriveRunCapabilities(
    buildManifest({
      status: "running",
      taskMode: "cli",
    }),
  );
  assert.equal(runningCliMode.canMutateTasks, true);

  const passive = deriveRunCapabilities(
    buildManifest({
      backend: "passive",
    }),
  );
  assert.equal(passive.canResume, false);
});

test("run contracts: toRunArchiveResult maps manifest-plus-change to the neutral archive DTO", () => {
  const manifest = buildManifest({
    status: "success",
    archivedAt: "2026-04-12T11:00:00.000Z",
  });

  assert.deepEqual(
    toRunArchiveResult({
      manifest,
      changed: true,
    }),
    {
      runId: "run123",
      status: "success",
      archivedAt: "2026-04-12T11:00:00.000Z",
      changed: true,
    },
  );
});
