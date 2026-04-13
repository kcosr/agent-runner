import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deriveRunCapabilities,
  toRunArchiveResult,
  toRunDetail,
  toRunSummary,
} from "../packages/core/dist/contracts/runs.js";

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
    capabilities: {
      canArchive: true,
      canUnarchive: false,
      canResume: true,
      taskMutation: {
        canSetStatus: false,
        canEditNotes: true,
        canAdd: false,
      },
    },
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

  assert.deepEqual(detail.capabilities, {
    canArchive: true,
    canUnarchive: false,
    canResume: true,
    taskMutation: {
      canSetStatus: false,
      canEditNotes: true,
      canAdd: false,
    },
  });
  assert.equal("canAbort" in detail.capabilities, false);
  assert.equal("canMutateTasks" in detail.capabilities, false);
  assert.deepEqual(detail, {
    runId: "run123",
    status: "success",
    archivedAt: null,
    isLive: true,
    workspaceDir: "/state/runs/demo/run123",
    assignmentPath: "/state/runs/demo/run123/assignment.md",
    agent: {
      name: "demo-agent",
      sourcePath: "/repo/agents/demo/agent.md",
    },
    assignment: {
      name: "demo-work",
      sourcePath: "/repo/assignments/demo/assignment.md",
      workspacePath: "/state/runs/demo/run123/assignment.md",
    },
    backend: "claude",
    model: "claude-sonnet-4-6",
    effort: "medium",
    sessionName: "demo session",
    backendSessionId: "sess-123",
    cwd: "/repo",
    taskMode: "file",
    unrestricted: false,
    timeoutSec: 3600,
    startedAt: "2026-04-12T10:00:00.000Z",
    endedAt: "2026-04-12T10:05:00.000Z",
    exitCode: 0,
    attempts: 1,
    maxAttempts: 2,
    sessionCount: 0,
    tasksCompleted: 1,
    tasksTotal: 2,
    tasks: [
      {
        id: "t1",
        title: "First",
        body: "Do the first thing.",
        status: "completed",
        notes: "Done.",
      },
      {
        id: "t2",
        title: "Second",
        body: "Do the second thing.",
        status: "pending",
        notes: "",
      },
    ],
    message: "Finish the task list.",
    callerInstructions: "Caller docs",
    pendingPrompt: "Prompt body",
    lockedFields: ["backend"],
    runtimeVars: { repo_path: "." },
    capabilities: detail.capabilities,
  });
});

test("run contracts: deriveRunCapabilities reflects archive, resume, and task-mutation semantics", () => {
  const initialized = deriveRunCapabilities(buildManifest());
  assert.deepEqual(initialized, {
    canArchive: true,
    canUnarchive: false,
    canResume: true,
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: true,
    },
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
    taskMutation: {
      canSetStatus: false,
      canEditNotes: true,
      canAdd: false,
    },
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
    taskMutation: {
      canSetStatus: false,
      canEditNotes: false,
      canAdd: false,
    },
  });

  const runningCliMode = deriveRunCapabilities(
    buildManifest({
      status: "running",
      taskMode: "cli",
    }),
  );
  assert.deepEqual(runningCliMode.taskMutation, {
    canSetStatus: true,
    canEditNotes: true,
    canAdd: false,
  });

  const passive = deriveRunCapabilities(
    buildManifest({
      backend: "passive",
    }),
  );
  assert.equal(passive.canResume, false);
  assert.deepEqual(passive.taskMutation, {
    canSetStatus: true,
    canEditNotes: true,
    canAdd: true,
  });

  const initializedLocked = deriveRunCapabilities(
    buildManifest({
      lockedFields: ["tasks"],
    }),
  );
  assert.deepEqual(initializedLocked.taskMutation, {
    canSetStatus: true,
    canEditNotes: true,
    canAdd: false,
  });
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
