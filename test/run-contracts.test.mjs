import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deriveRunCapabilities,
  toRunArchiveResult,
  toRunBackendSessionResult,
  toRunDependenciesResult,
  toRunDetail,
  toRunNoteResult,
  toRunPinnedResult,
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
    schemaVersion: 10,
    runId: "run123",
    repo: "demo-repo",
    agent: {
      name: "demo-agent",
      sourcePath: "/repo/agents/demo/agent.md",
      instructions: "Agent instructions.",
    },
    assignment: {
      name: "demo-work",
      sourcePath: "/repo/assignments/demo/assignment.md",
      workspacePath: "/state/runs/demo/run123/assignment-seed.md",
    },
    backend: "claude",
    model: "claude-sonnet-4-6",
    effort: "medium",
    launcher: {
      kind: "direct",
      name: "direct",
    },
    message: "Finish the task list.",
    name: "demo session",
    note: null,
    pinned: false,
    unrestricted: false,
    cwd: "/repo",
    lockedFields: ["backend"],
    timeoutSec: 3600,
    assignmentPath: "/state/runs/demo/run123/assignment-seed.md",
    workspaceDir: "/state/runs/demo/run123",
    startedAt: "2026-04-12T10:00:00.000Z",
    endedAt: null,
    archivedAt: null,
    status: "initialized",
    dependencyRunIds: [],
    exitCode: null,
    attempts: 0,
    maxAttempts: 2,
    tasksCompleted: Object.values(finalTasks).filter((task) => task.status === "completed").length,
    tasksTotal: Object.keys(finalTasks).length,
    backendSessionId: null,
    runtimeVars: {},
    resolvedHooks: [
      {
        hookId: "prepare:0:freeze",
        phase: "prepare",
        source: { name: "freeze" },
        resolvedPath: "/repo/hooks/freeze/hook.ts",
        when: null,
        config: { mode: "status" },
      },
    ],
    hookState: { prepared: true },
    hookAudits: [],
    execution: {
      hostMode: "embedded",
      controller: {
        kind: "embedded",
      },
    },
    brief: "Prepared handoff prompt.",
    callerInstructions: "Caller docs",
    attachments: [],
    resetSeed: {
      backend: "claude",
      model: "claude-sonnet-4-6",
      effort: "medium",
      launcher: {
        kind: "direct",
        name: "direct",
      },
      cwd: "/repo",
      lockedFields: ["backend"],
      message: "Finish the task list.",
      name: "demo session",
      note: null,
      pinned: false,
      dependencyRunIds: [],
      unrestricted: false,
      timeoutSec: 3600,
      maxAttempts: 2,
      brief: "Prepared handoff prompt.",
      runtimeVars: {},
      hookState: { prepared: true },
      attachments: [],
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
    effectiveStatus: "success",
    archivedAt: null,
    notePresent: false,
    pinned: false,
    agentName: "demo-agent",
    assignmentName: "demo-work",
    backend: "claude",
    model: "claude-sonnet-4-6",
    name: "demo session",
    cwd: "/repo",
    startedAt: "2026-04-12T10:00:00.000Z",
    endedAt: "2026-04-12T10:05:00.000Z",
    tasksCompleted: 1,
    tasksTotal: 2,
    attachmentCount: 0,
    hookCount: 1,
    dependencyState: {
      ready: true,
      total: 0,
      satisfied: 0,
      unsatisfied: 0,
    },
    activeTask: null,
    execution: {
      hostMode: "embedded",
      controller: {
        kind: "embedded",
      },
    },
    capabilities: {
      canArchive: true,
      canUnarchive: false,
      canReset: true,
      canDelete: false,
      canResume: true,
      canAbort: false,
      abortReason: "already_terminal",
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
    canReset: true,
    canDelete: false,
    canResume: true,
    canAbort: false,
    abortReason: "already_terminal",
    taskMutation: {
      canSetStatus: false,
      canEditNotes: true,
      canAdd: false,
    },
  });
  assert.equal("canMutateTasks" in detail.capabilities, false);
  assert.deepEqual(detail, {
    runId: "run123",
    repo: "demo-repo",
    status: "success",
    effectiveStatus: "success",
    archivedAt: null,
    isLive: true,
    workspaceDir: "/state/runs/demo/run123",
    assignmentPath: "/state/runs/demo/run123/assignment-seed.md",
    agent: {
      name: "demo-agent",
      sourcePath: "/repo/agents/demo/agent.md",
    },
    assignment: {
      name: "demo-work",
      sourcePath: "/repo/assignments/demo/assignment.md",
      workspacePath: "/state/runs/demo/run123/assignment-seed.md",
    },
    backend: "claude",
    model: "claude-sonnet-4-6",
    effort: "medium",
    name: "demo session",
    note: null,
    pinned: false,
    backendSessionId: "sess-123",
    cwd: "/repo",
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
    attachments: [],
    resolvedHooks: manifest.resolvedHooks,
    hookState: manifest.hookState,
    hookAudits: [],
    dependencies: [],
    dependents: [],
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
    activeTask: null,
    message: "Finish the task list.",
    pendingPrompt: null,
    callerInstructions: "Caller docs",
    lockedFields: ["backend"],
    runtimeVars: {},
    execution: {
      hostMode: "embedded",
      controller: {
        kind: "embedded",
      },
    },
    capabilities: detail.capabilities,
  });
});

test("run contracts: toRunDetail exposes pendingPrompt for initialized zero-attempt runs", () => {
  const detail = toRunDetail({
    manifest: buildManifest(),
    isLive: false,
  });

  assert.equal(detail.pendingPrompt, "Prepared handoff prompt.");
});

test("run contracts: note and pin metadata project through summary, detail, and mutation DTOs", () => {
  const manifest = buildManifest();
  manifest.note = "# Follow-up\n\nKeep the active note preview.";
  manifest.pinned = true;
  manifest.resetSeed.note = manifest.note;
  manifest.resetSeed.pinned = manifest.pinned;

  const summary = toRunSummary({
    repo: "demo-repo",
    workspaceDir: manifest.workspaceDir,
    manifest,
  });
  const detail = toRunDetail({
    manifest,
    isLive: false,
  });

  assert.equal(summary.notePresent, true);
  assert.equal(summary.pinned, true);
  assert.equal(detail.note, "# Follow-up\n\nKeep the active note preview.");
  assert.equal(detail.pinned, true);
  assert.deepEqual(toRunNoteResult({ manifest, changed: true }), {
    runId: "run123",
    note: "# Follow-up\n\nKeep the active note preview.",
    changed: true,
  });
  assert.deepEqual(toRunPinnedResult({ manifest, changed: true }), {
    runId: "run123",
    pinned: true,
    changed: true,
  });
});

test("run contracts: dependency summary/detail projection resolves readiness and reverse edges", () => {
  const target = buildManifest({
    runId: "run123",
    dependencyRunIds: ["run456", "missing-run"],
  });
  const dependency = buildManifest({
    runId: "run456",
    name: null,
    assignment: {
      name: "Prerequisite assignment",
      sourcePath: "/repo/assignments/prerequisite/assignment.md",
      workspacePath: "/state/runs/demo/run456/assignment-seed.md",
    },
    status: "success",
    endedAt: "2026-04-12T09:30:00.000Z",
  });
  const dependent = buildManifest({
    runId: "run789",
    name: null,
    assignment: {
      name: "Downstream assignment",
      sourcePath: "/repo/assignments/downstream/assignment.md",
      workspacePath: "/state/runs/demo/run789/assignment-seed.md",
    },
    dependencyRunIds: ["run123"],
    startedAt: "2026-04-12T10:10:00.000Z",
  });
  const graph = new Map([
    [target.runId, target],
    [dependency.runId, dependency],
    [dependent.runId, dependent],
  ]);

  const summary = toRunSummary(
    {
      repo: "demo-repo",
      workspaceDir: target.workspaceDir,
      manifest: target,
    },
    graph,
  );
  const detail = toRunDetail({
    manifest: target,
    isLive: false,
    relatedManifests: graph,
  });

  assert.deepEqual(summary.dependencyState, {
    ready: false,
    total: 2,
    satisfied: 1,
    unsatisfied: 1,
  });
  assert.deepEqual(detail.dependencies, [
    {
      runId: "run456",
      name: "Prerequisite assignment",
      status: "success",
      effectiveStatus: "success",
      archivedAt: null,
      satisfied: true,
      missing: false,
    },
    {
      runId: "missing-run",
      name: null,
      status: null,
      effectiveStatus: null,
      archivedAt: null,
      satisfied: false,
      missing: true,
    },
  ]);
  assert.deepEqual(detail.dependents, [
    {
      runId: "run789",
      name: "Downstream assignment",
      status: "initialized",
      effectiveStatus: "initialized",
      archivedAt: null,
      satisfied: false,
      missing: false,
    },
  ]);
});

test("run contracts: activeTask is derived only when exactly one task is in progress", () => {
  const manifest = buildManifest({
    finalTasks: {
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
        status: "in_progress",
        notes: "",
      },
    },
    tasksCompleted: 1,
    tasksTotal: 2,
  });

  const summary = toRunSummary({
    repo: "demo-repo",
    workspaceDir: manifest.workspaceDir,
    manifest,
  });
  const detail = toRunDetail({
    manifest,
    isLive: true,
  });

  assert.deepEqual(summary.activeTask, {
    id: "t2",
    title: "Second",
  });
  assert.deepEqual(detail.activeTask, {
    id: "t2",
    title: "Second",
  });

  const noActiveManifest = buildManifest({
    finalTasks: {
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
    },
  });
  assert.equal(
    toRunSummary({
      repo: "demo-repo",
      workspaceDir: noActiveManifest.workspaceDir,
      manifest: noActiveManifest,
    }).activeTask,
    null,
  );
  assert.equal(
    toRunDetail({
      manifest: noActiveManifest,
      isLive: true,
    }).activeTask,
    null,
  );

  const ambiguousActiveManifest = buildManifest({
    finalTasks: {
      t1: {
        id: "t1",
        title: "First",
        body: "Do the first thing.",
        status: "in_progress",
        notes: "",
      },
      t2: {
        id: "t2",
        title: "Second",
        body: "Do the second thing.",
        status: "in_progress",
        notes: "",
      },
    },
    tasksCompleted: 0,
    tasksTotal: 2,
  });
  assert.equal(
    toRunSummary({
      repo: "demo-repo",
      workspaceDir: ambiguousActiveManifest.workspaceDir,
      manifest: ambiguousActiveManifest,
    }).activeTask,
    null,
  );
  assert.equal(
    toRunDetail({
      manifest: ambiguousActiveManifest,
      isLive: true,
    }).activeTask,
    null,
  );
});

test("run contracts: deriveRunCapabilities reflects archive, resume, and task-mutation semantics", () => {
  const initialized = deriveRunCapabilities(buildManifest());
  assert.deepEqual(initialized, {
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
    canReset: true,
    canDelete: true,
    canResume: false,
    canAbort: false,
    abortReason: "already_terminal",
    taskMutation: {
      canSetStatus: false,
      canEditNotes: true,
      canAdd: false,
    },
  });

  const running = deriveRunCapabilities(
    buildManifest({
      status: "running",
    }),
  );
  assert.deepEqual(running, {
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

  const passive = deriveRunCapabilities(
    buildManifest({
      backend: "passive",
    }),
  );
  assert.equal(passive.canResume, false);
  assert.equal(passive.canAbort, false);
  assert.equal(passive.abortReason, "not_active_in_daemon");
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

test("run contracts: passive summaries and details derive effectiveStatus from task snapshots", () => {
  const manifest = buildManifest({
    backend: "passive",
    status: "initialized",
    finalTasks: {
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
        status: "in_progress",
        notes: "Working.",
      },
    },
    tasksCompleted: 1,
  });

  const summary = toRunSummary({
    repo: "demo-repo",
    workspaceDir: manifest.workspaceDir,
    manifest,
  });
  const detail = toRunDetail({ manifest, isLive: false });

  assert.equal(summary.status, "initialized");
  assert.equal(summary.effectiveStatus, "running");
  assert.equal(detail.status, "initialized");
  assert.equal(detail.effectiveStatus, "running");
  assert.deepEqual(detail.capabilities, {
    canArchive: true,
    canUnarchive: false,
    canReset: true,
    canDelete: false,
    canResume: false,
    canAbort: false,
    abortReason: "not_active_in_daemon",
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: true,
    },
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

test("run contracts: toRunDependenciesResult maps manifest-plus-change to the dependency DTO", () => {
  const manifest = buildManifest({
    dependencyRunIds: ["run456"],
  });

  assert.deepEqual(
    toRunDependenciesResult({
      manifest,
      changed: true,
    }),
    {
      runId: "run123",
      dependencyRunIds: ["run456"],
      changed: true,
    },
  );
});

test("run contracts: toRunBackendSessionResult maps manifest-plus-change to the backend session DTO", () => {
  const manifest = buildManifest({
    backendSessionId: "thread-42",
  });

  assert.deepEqual(
    toRunBackendSessionResult({
      manifest,
      changed: true,
    }),
    {
      runId: "run123",
      backendSessionId: "thread-42",
      changed: true,
    },
  );
});
