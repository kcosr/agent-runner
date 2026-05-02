import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deriveRunCapabilities,
  isDaemonAutoRunnableReadyRun,
  scheduleIsDueOrAbsent,
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
    schemaVersion: 19,
    runId: "run123",
    runGroupId: "run123",
    repo: "demo-repo",
    agent: {
      name: "demo-agent",
      sourcePath: "/repo/agents/demo/agent.md",
      instructions: "Agent instructions.",
    },
    assignment: {
      name: "demo-work",
      sourcePath: "/repo/assignments/demo/assignment.md",
    },
    backend: "claude",
    model: "claude-sonnet-4-6",
    effort: "medium",
    resolvedBackendArgs: [],
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
    workspaceDir: "/state/runs/demo/run123",
    startedAt: "2026-04-12T10:00:00.000Z",
    updatedAt: "2026-04-12T10:00:00.000Z",
    endedAt: null,
    archivedAt: null,
    status: "initialized",
    dependencies: [],
    parentRunId: null,
    schedule: null,
    queuedResumeMessages: overrides.queuedResumeMessages ?? [
      {
        id: "qmsg-demo",
        text: "Queued follow-up.",
        createdAt: "2026-04-12T10:01:00.000Z",
      },
    ],
    exitCode: null,
    totalAttemptCount: 0,
    maxAttemptsPerSession: 2,
    tasksCompleted: Object.values(finalTasks).filter((task) => task.status === "completed").length,
    tasksTotal: Object.keys(finalTasks).length,
    backendSessionId: null,
    backendSessionSync: null,
    runtimeVars: {},
    runtimeVarSources: {},
    resolvedHooks: [
      {
        hookId: "prepare:0:freeze",
        phase: "prepare",
        source: { name: "freeze" },
        resolvedPath: "/repo/hooks/freeze/hook.ts",
        taskScopeId: null,
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
      resolvedBackendArgs: [],
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
      runGroupId: "run123",
      dependencies: [],
      parentRunId: null,
      unrestricted: false,
      timeoutSec: 3600,
      maxAttemptsPerSession: 2,
      brief: "Prepared handoff prompt.",
      runtimeVars: {},
      runtimeVarSources: {},
      hookState: { prepared: true },
      attachments: [],
      finalTasks,
    },
    finalTasks,
    totalSessionCount: 0,
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
    parentRunId: null,
    runGroupId: "run123",
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
    updatedAt: "2026-04-12T10:00:00.000Z",
    endedAt: "2026-04-12T10:05:00.000Z",
    totalAttemptCount: 0,
    totalSessionCount: 0,
    maxAttemptsPerSession: 2,
    currentSession: null,
    lastSession: null,
    tasksCompleted: 1,
    tasksTotal: 2,
    attachmentCount: 0,
    queuedResumeMessageCount: 1,
    hookCount: 1,
    dependencyState: {
      ready: true,
      total: 0,
      satisfied: 0,
      unsatisfied: 0,
    },
    schedule: null,
    scheduleState: "none",
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
      canReady: false,
      canResume: true,
      canAbort: false,
      abortReason: "already_terminal",
      canReconfigure: false,
      reconfigureReason: "not_initialized",
      taskMutation: {
        canSetStatus: true,
        canEditNotes: true,
        canAdd: false,
      },
    },
  });
});

test("run contracts: toRunSummary carries the manifest run group id", () => {
  const manifest = buildManifest({
    runGroupId: "shared-group",
  });

  const summary = toRunSummary({
    repo: "demo-repo",
    workspaceDir: manifest.workspaceDir,
    manifest,
  });

  assert.equal(summary.runGroupId, "shared-group");
});

test("run contracts: toRunDetail maps status results to the neutral detail DTO", () => {
  const manifest = buildManifest({
    status: "success",
    endedAt: "2026-04-12T10:05:00.000Z",
    exitCode: 0,
    totalAttemptCount: 1,
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
    canReady: false,
    canResume: true,
    canAbort: false,
    abortReason: "already_terminal",
    canReconfigure: false,
    reconfigureReason: "not_initialized",
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: false,
    },
  });
  assert.equal("canMutateTasks" in detail.capabilities, false);
  assert.equal("assignmentPath" in detail, false);
  assert.equal("workspacePath" in detail.assignment, false);
  assert.deepEqual(detail, {
    runId: "run123",
    parentRunId: null,
    runGroupId: "run123",
    repo: "demo-repo",
    status: "success",
    effectiveStatus: "success",
    archivedAt: null,
    isLive: true,
    workspaceDir: "/state/runs/demo/run123",
    agent: {
      name: "demo-agent",
      sourcePath: "/repo/agents/demo/agent.md",
    },
    assignment: {
      name: "demo-work",
      sourcePath: "/repo/assignments/demo/assignment.md",
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
    updatedAt: "2026-04-12T10:00:00.000Z",
    endedAt: "2026-04-12T10:05:00.000Z",
    exitCode: 0,
    totalAttemptCount: 1,
    totalSessionCount: 0,
    maxAttemptsPerSession: 2,
    sessions: [],
    currentSession: null,
    lastSession: null,
    tasksCompleted: 1,
    tasksTotal: 2,
    attachments: [],
    queuedResumeMessages: [
      {
        id: "qmsg-demo",
        text: "Queued follow-up.",
        createdAt: "2026-04-12T10:01:00.000Z",
      },
    ],
    resolvedHooks: manifest.resolvedHooks,
    hookState: manifest.hookState,
    hookAudits: [],
    dependencies: [],
    dependents: [],
    schedule: null,
    scheduleState: "none",
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

test("run contracts: toRunDetail projects hook descriptors and audit attemptNumber", () => {
  const manifest = buildManifest({
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
    hookAudits: [
      {
        phase: "prepare",
        hookId: "prepare:0:freeze",
        startedAt: "2026-04-12T10:00:00.000Z",
        endedAt: "2026-04-12T10:00:01.000Z",
        outcome: "continue",
        sessionIndex: null,
        attemptNumber: null,
        taskId: null,
      },
    ],
  });

  const detail = toRunDetail({
    manifest,
    isLive: false,
  });

  assert.deepEqual(detail.resolvedHooks, [
    {
      hookId: "prepare:0:freeze",
      phase: "prepare",
      source: { name: "freeze" },
      resolvedPath: "/repo/hooks/freeze/hook.ts",
      taskScopeId: null,
      when: null,
      config: { mode: "status" },
    },
  ]);
  assert.deepEqual(detail.hookAudits, [
    {
      phase: "prepare",
      hookId: "prepare:0:freeze",
      startedAt: "2026-04-12T10:00:00.000Z",
      endedAt: "2026-04-12T10:00:01.000Z",
      outcome: "continue",
      sessionIndex: null,
      attemptNumber: null,
      taskId: null,
      summary: null,
    },
  ]);
});

test("run contracts: toRunDetail exposes pendingPrompt for initialized zero-attempt runs", () => {
  const detail = toRunDetail({
    manifest: buildManifest(),
    isLive: false,
  });

  assert.equal(detail.pendingPrompt, "Prepared handoff prompt.");
});

test("run contracts: toRunDetail exposes pendingPrompt for ready zero-attempt runs", () => {
  const detail = toRunDetail({
    manifest: buildManifest({
      status: "ready",
    }),
    isLive: false,
  });

  assert.equal(detail.pendingPrompt, "Prepared handoff prompt.");
});

test("run contracts: schedules project onto summary/detail with derived state", () => {
  const schedule = {
    enabled: true,
    runAt: "2026-04-12T09:00:00.000Z",
    recurrence: {
      schedule: {
        type: "cron",
        expression: "0 9 * * *",
        timezone: "UTC",
      },
      mode: "clone",
      continueOnFailure: false,
    },
  };
  const manifest = buildManifest({ schedule });

  const summary = toRunSummary({
    repo: "demo-repo",
    workspaceDir: manifest.workspaceDir,
    manifest,
  });
  const detail = toRunDetail({ manifest, isLive: false });

  assert.deepEqual(summary.schedule, schedule);
  assert.equal(summary.scheduleState, "due");
  assert.deepEqual(detail.schedule, schedule);
  assert.equal(detail.scheduleState, "due");
});

test("run contracts: toRunDetail redacts inherited env vars from runtimeVarSources", () => {
  const detail = toRunDetail({
    manifest: buildManifest({
      parentRunId: "run-parent",
      runtimeVars: {
        visible: "plain",
        inherited_secret: "token-123",
      },
      runtimeVarSources: {
        inherited_secret: {
          source: "parent",
          envName: "LINEAGE_SECRET",
          inheritedFromRunId: "run-parent",
          redacted: true,
        },
      },
    }),
    isLive: false,
  });

  assert.equal(detail.parentRunId, "run-parent");
  assert.deepEqual(detail.runtimeVars, {
    visible: "plain",
    inherited_secret: {
      redacted: true,
      source: "parent",
      envName: "LINEAGE_SECRET",
      inheritedFromRunId: "run-parent",
    },
  });
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
    updatedAt: "2026-04-12T10:00:00.000Z",
    note: "# Follow-up\n\nKeep the active note preview.",
    changed: true,
  });
  assert.deepEqual(toRunPinnedResult({ manifest, changed: true }), {
    runId: "run123",
    updatedAt: "2026-04-12T10:00:00.000Z",
    pinned: true,
    changed: true,
  });
});

test("run contracts: dependency summary/detail projection resolves readiness and reverse edges", () => {
  const target = buildManifest({
    runId: "run123",
    dependencies: [
      { type: "run", runId: "run456" },
      { type: "run", runId: "missing-run" },
    ],
  });
  const dependency = buildManifest({
    runId: "run456",
    name: null,
    assignment: {
      name: "Prerequisite assignment",
      sourcePath: "/repo/assignments/prerequisite/assignment.md",
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
    },
    dependencies: [{ type: "run", runId: "run123" }],
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
      type: "run",
      runId: "run456",
      name: "Prerequisite assignment",
      status: "success",
      effectiveStatus: "success",
      archivedAt: null,
      satisfied: true,
      missing: false,
    },
    {
      type: "run",
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
      type: "run",
      via: "run",
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

  const ready = deriveRunCapabilities(
    buildManifest({
      status: "ready",
    }),
  );
  assert.deepEqual(ready, {
    canArchive: true,
    canUnarchive: false,
    canReset: true,
    canDelete: false,
    canReady: false,
    canResume: true,
    canAbort: false,
    abortReason: "not_active_in_daemon",
    canReconfigure: false,
    reconfigureReason: "not_initialized",
    taskMutation: {
      canSetStatus: false,
      canEditNotes: true,
      canAdd: false,
    },
  });

  const readyBlockedOnDependency = deriveRunCapabilities(
    buildManifest({
      status: "ready",
      dependencies: [{ type: "run", runId: "dep-1" }],
    }),
    {
      unsatisfied: 1,
    },
  );
  assert.equal(readyBlockedOnDependency.canResume, false);

  const archived = deriveRunCapabilities(
    buildManifest({
      status: "success",
      archivedAt: "2026-04-12T11:00:00.000Z",
      endedAt: "2026-04-12T10:05:00.000Z",
      exitCode: 0,
      totalAttemptCount: 1,
    }),
  );
  assert.deepEqual(archived, {
    canArchive: false,
    canUnarchive: true,
    canReset: true,
    canDelete: true,
    canReady: false,
    canResume: false,
    canAbort: false,
    abortReason: "already_terminal",
    canReconfigure: false,
    reconfigureReason: "archived",
    taskMutation: {
      canSetStatus: true,
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

  const passive = deriveRunCapabilities(
    buildManifest({
      backend: "passive",
    }),
  );
  assert.equal(passive.canResume, false);
  assert.equal(passive.canReady, false);
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
  assert.equal(initializedLocked.canReady, true);
  assert.deepEqual(initializedLocked.taskMutation, {
    canSetStatus: true,
    canEditNotes: true,
    canAdd: false,
  });
});

test("run contracts: shared schedule gate helper controls daemon auto-runnability only", () => {
  const futureSchedule = {
    enabled: true,
    runAt: "2099-01-01T00:00:00.000Z",
    recurrence: null,
  };
  const dueSchedule = {
    ...futureSchedule,
    runAt: "2000-01-01T00:00:00.000Z",
  };
  const dependencyState = { unsatisfied: 0 };

  assert.equal(scheduleIsDueOrAbsent(null), true);
  assert.equal(scheduleIsDueOrAbsent(futureSchedule), false);
  assert.equal(scheduleIsDueOrAbsent(dueSchedule), true);
  assert.equal(
    isDaemonAutoRunnableReadyRun({
      manifest: buildManifest({ status: "ready", schedule: futureSchedule }),
      dependencyState,
      activeInDaemon: false,
    }),
    false,
  );
  assert.equal(
    isDaemonAutoRunnableReadyRun({
      manifest: buildManifest({ status: "ready", schedule: dueSchedule }),
      dependencyState,
      activeInDaemon: false,
    }),
    true,
  );
  assert.equal(
    deriveRunCapabilities(buildManifest({ status: "ready", schedule: futureSchedule })).canResume,
    true,
  );
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
    canReady: false,
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
      updatedAt: "2026-04-12T10:00:00.000Z",
      changed: true,
    },
  );
});

test("run contracts: toRunDependenciesResult maps manifest-plus-change to the dependency DTO", () => {
  const manifest = buildManifest({
    dependencies: [{ type: "run", runId: "run456" }],
  });

  assert.deepEqual(
    toRunDependenciesResult({
      manifest,
      changed: true,
    }),
    {
      runId: "run123",
      dependencies: [{ type: "run", runId: "run456" }],
      updatedAt: "2026-04-12T10:00:00.000Z",
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
      updatedAt: "2026-04-12T10:00:00.000Z",
      changed: true,
    },
  );
});
