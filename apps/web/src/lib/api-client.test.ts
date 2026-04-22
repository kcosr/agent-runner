import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./api-client.js";

const config = {
  apiBasePath: "/api",
  runSummaryEventsPath: "/api/events/run-summaries",
};

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects run list payloads that omit effectiveStatus", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              runs: [
                {
                  runId: "run-1",
                  parentRunId: null,
                  familyRootRunId: null,
                  repo: "task-runner",
                  status: "running",
                  archivedAt: null,
                  agentName: "implementer",
                  name: "Build dashboard",
                  assignmentName: "Build dashboard",
                  backend: "codex",
                  model: "gpt-5.4",
                  cwd: "/tmp/task-runner",
                  startedAt: "2026-04-13T05:00:00.000Z",
                  endedAt: null,
                  tasksCompleted: 1,
                  tasksTotal: 4,
                  attachmentCount: 0,
                  dependencyState: {
                    ready: true,
                    total: 0,
                    satisfied: 0,
                    unsatisfied: 0,
                  },
                  activeTask: {
                    id: "build",
                    title: "Build UI",
                  },
                  execution: {
                    hostMode: "embedded",
                    controller: { kind: "embedded" },
                  },
                  capabilities: {
                    canArchive: false,
                    canUnarchive: false,
                    canReset: true,
                    canDelete: false,
                    canReady: false,
                    canResume: true,
                    canAbort: false,
                    abortReason: "not_active_in_daemon",
                    taskMutation: {
                      canAdd: false,
                      canEditNotes: false,
                      canSetStatus: false,
                    },
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const api = createApiClient(config);

    await expect(api.listRuns()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "ApiError",
      status: 200,
    });
  });

  it("parses effectiveStatus from run list payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              runs: [
                {
                  runId: "run-1",
                  parentRunId: null,
                  familyRootRunId: "run-root",
                  repo: "task-runner",
                  status: "initialized",
                  effectiveStatus: "running",
                  archivedAt: null,
                  notePresent: true,
                  pinned: true,
                  agentName: "implementer",
                  name: "Build dashboard",
                  assignmentName: "Build dashboard",
                  backend: "passive",
                  model: null,
                  cwd: "/tmp/task-runner",
                  startedAt: "2026-04-13T05:00:00.000Z",
                  endedAt: null,
                  tasksCompleted: 1,
                  tasksTotal: 4,
                  attachmentCount: 0,
                  dependencyState: {
                    ready: false,
                    total: 2,
                    satisfied: 1,
                    unsatisfied: 1,
                  },
                  activeTask: {
                    id: "build",
                    title: "Build UI",
                  },
                  execution: {
                    hostMode: "embedded",
                    controller: { kind: "embedded" },
                  },
                  capabilities: {
                    canArchive: true,
                    canUnarchive: false,
                    canReset: true,
                    canDelete: false,
                    canReady: false,
                    canResume: false,
                    canAbort: false,
                    abortReason: "not_active_in_daemon",
                    taskMutation: {
                      canAdd: true,
                      canEditNotes: true,
                      canSetStatus: true,
                    },
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const api = createApiClient(config);

    await expect(api.listRuns()).resolves.toEqual([
      expect.objectContaining({
        runId: "run-1",
        familyRootRunId: "run-root",
        status: "initialized",
        effectiveStatus: "running",
        notePresent: true,
        pinned: true,
        dependencyState: {
          ready: false,
          total: 2,
          satisfied: 1,
          unsatisfied: 1,
        },
      }),
    ]);
  });

  it("adds the optional familyOf query parameter to run-list requests", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            runs: [],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);
    await expect(api.listRuns({ familyOf: "run-root" })).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs?includeArchived=true&familyOf=run-root",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
  });

  it("passes an abort signal to run-detail requests", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            run: {
              runId: "run-1",
              parentRunId: null,
              repo: "task-runner",
              status: "running",
              effectiveStatus: "running",
              archivedAt: null,
              isLive: true,
              workspaceDir: "/tmp/run-1",
              assignmentPath: "/tmp/run-1/assignment-seed.md",
              agent: { name: "implementer", sourcePath: null },
              assignment: null,
              backend: "codex",
              model: "gpt-5.4",
              effort: "high",
              name: "Build dashboard",
              note: null,
              pinned: false,
              backendSessionId: null,
              cwd: "/tmp/task-runner",
              unrestricted: false,
              timeoutSec: 60,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: null,
              exitCode: null,
              attempts: 1,
              maxAttempts: 2,
              sessionCount: 1,
              tasksCompleted: 1,
              tasksTotal: 1,
              attachments: [],
              dependencies: [],
              dependents: [],
              tasks: [],
              activeTask: null,
              message: null,
              pendingPrompt: null,
              callerInstructions: null,
              lockedFields: [],
              runtimeVars: {},
              execution: {
                hostMode: "embedded",
                controller: { kind: "embedded" },
              },
              capabilities: {
                canArchive: false,
                canUnarchive: false,
                canReset: true,
                canDelete: false,
                canReady: false,
                canResume: true,
                canAbort: false,
                abortReason: "not_active_in_daemon",
                taskMutation: {
                  canAdd: false,
                  canEditNotes: false,
                  canSetStatus: false,
                },
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);
    const controller = new AbortController();

    await expect(api.getRun("run-1", { signal: controller.signal })).resolves.toMatchObject({
      runId: "run-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1",
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: controller.signal,
      }),
    );
  });

  it("parses pendingPrompt from run-detail payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              run: {
                runId: "run-1",
                parentRunId: null,
                repo: "task-runner",
                status: "initialized",
                effectiveStatus: "initialized",
                archivedAt: null,
                isLive: false,
                workspaceDir: "/tmp/run-1",
                assignmentPath: "/tmp/run-1/assignment-seed.md",
                agent: { name: "implementer", sourcePath: null },
                assignment: null,
                backend: "codex",
                model: "gpt-5.4",
                effort: "high",
                name: "Build dashboard",
                note: null,
                pinned: false,
                backendSessionId: null,
                cwd: "/tmp/task-runner",
                unrestricted: false,
                timeoutSec: 60,
                startedAt: "2026-04-13T05:00:00.000Z",
                endedAt: null,
                exitCode: null,
                attempts: 0,
                maxAttempts: 2,
                sessionCount: 0,
                tasksCompleted: 0,
                tasksTotal: 1,
                attachments: [],
                dependencies: [],
                dependents: [],
                tasks: [],
                activeTask: null,
                message: "Hand off the queued run",
                pendingPrompt: "Prepared prompt",
                callerInstructions: null,
                lockedFields: [],
                runtimeVars: {},
                execution: {
                  hostMode: "embedded",
                  controller: { kind: "embedded" },
                },
                capabilities: {
                  canArchive: true,
                  canUnarchive: false,
                  canReset: true,
                  canDelete: false,
                  canReady: true,
                  canResume: true,
                  canAbort: false,
                  abortReason: "not_active_in_daemon",
                  taskMutation: {
                    canAdd: true,
                    canEditNotes: true,
                    canSetStatus: true,
                  },
                },
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const api = createApiClient(config);

    await expect(api.getRun("run-1")).resolves.toMatchObject({
      runId: "run-1",
      message: "Hand off the queued run",
      pendingPrompt: "Prepared prompt",
    });
  });

  it("parses hook projections from run detail payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              run: {
                runId: "run-1",
                parentRunId: null,
                repo: "task-runner",
                status: "initialized",
                effectiveStatus: "initialized",
                archivedAt: null,
                isLive: false,
                workspaceDir: "/tmp/run-1",
                assignmentPath: "/tmp/run-1/assignment-seed.md",
                agent: { name: "implementer", sourcePath: null },
                assignment: null,
                backend: "codex",
                model: "gpt-5.4",
                effort: "high",
                name: "Build dashboard",
                note: null,
                pinned: false,
                backendSessionId: null,
                cwd: "/tmp/task-runner",
                unrestricted: false,
                timeoutSec: 60,
                startedAt: "2026-04-13T05:00:00.000Z",
                endedAt: null,
                exitCode: null,
                attempts: 0,
                maxAttempts: 2,
                sessionCount: 0,
                tasksCompleted: 0,
                tasksTotal: 1,
                attachments: [],
                resolvedHooks: [
                  {
                    hookId: "prepare:0:freeze",
                    phase: "prepare",
                    source: { name: "freeze" },
                    resolvedPath: "/tmp/hooks/freeze/hook.ts",
                    when: null,
                    config: { mode: "json" },
                  },
                ],
                hookState: { prepared: true },
                hookAudits: [
                  {
                    phase: "prepare",
                    hookId: "prepare:0:freeze",
                    startedAt: "2026-04-20T10:00:00.000Z",
                    endedAt: "2026-04-20T10:00:01.000Z",
                    outcome: "continue",
                    sessionIndex: null,
                    attempt: null,
                    taskId: null,
                    summary: null,
                  },
                ],
                dependencies: [],
                dependents: [],
                tasks: [],
                activeTask: null,
                message: null,
                pendingPrompt: null,
                callerInstructions: null,
                lockedFields: [],
                runtimeVars: {},
                execution: {
                  hostMode: "embedded",
                  controller: { kind: "embedded" },
                },
                capabilities: {
                  canArchive: true,
                  canUnarchive: false,
                  canReset: true,
                  canDelete: false,
                  canReady: true,
                  canResume: true,
                  canAbort: false,
                  abortReason: "not_active_in_daemon",
                  taskMutation: {
                    canAdd: true,
                    canEditNotes: true,
                    canSetStatus: true,
                  },
                },
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const api = createApiClient(config);

    await expect(api.getRun("run-1")).resolves.toMatchObject({
      resolvedHooks: [
        expect.objectContaining({
          hookId: "prepare:0:freeze",
          phase: "prepare",
        }),
      ],
      hookState: { prepared: true },
      hookAudits: [expect.objectContaining({ outcome: "continue" })],
    });
  });

  it("rejects invalid resume responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );

    const api = createApiClient(config);

    await expect(api.resumeRun("run-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "ApiError",
      status: 200,
    });
  });

  it("sends an optional message when resuming a run", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ runId: "run-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);

    await expect(api.resumeRun("run-1", "Pick up with the failing tests")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/resume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        overrides: {
          message: "Pick up with the failing tests",
        },
      }),
    });
  });

  it("posts reset requests and parses the returned run detail", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            run: {
              runId: "run-1",
              parentRunId: null,
              repo: "task-runner",
              status: "initialized",
              effectiveStatus: "initialized",
              archivedAt: null,
              isLive: false,
              workspaceDir: "/tmp/run-1",
              assignmentPath: "/tmp/run-1/assignment-seed.md",
              agent: { name: "implementer", sourcePath: null },
              assignment: null,
              backend: "codex",
              model: "gpt-5.4",
              effort: "high",
              name: "Build dashboard",
              note: "Reset seed note",
              pinned: true,
              backendSessionId: null,
              cwd: "/tmp/task-runner",
              unrestricted: false,
              timeoutSec: 60,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: null,
              exitCode: null,
              attempts: 0,
              maxAttempts: 2,
              sessionCount: 0,
              tasksCompleted: 0,
              tasksTotal: 1,
              attachments: [],
              dependencies: [],
              dependents: [],
              tasks: [],
              activeTask: null,
              message: null,
              pendingPrompt: "Prepared prompt",
              callerInstructions: null,
              lockedFields: [],
              runtimeVars: {},
              execution: {
                hostMode: "embedded",
                controller: { kind: "embedded" },
              },
              capabilities: {
                canArchive: true,
                canUnarchive: false,
                canReset: true,
                canDelete: false,
                canReady: true,
                canResume: true,
                canAbort: false,
                abortReason: "not_active_in_daemon",
                taskMutation: {
                  canAdd: true,
                  canEditNotes: true,
                  canSetStatus: true,
                },
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);

    await expect(api.resetRun("run-1")).resolves.toMatchObject({
      runId: "run-1",
      status: "initialized",
      note: "Reset seed note",
      pinned: true,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/reset", {
      method: "POST",
      headers: { accept: "application/json" },
    });
  });

  it("deletes archived runs", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ result: { runId: "run-1" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);

    await expect(api.deleteRun("run-1")).resolves.toEqual({ runId: "run-1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1", {
      method: "DELETE",
      headers: { accept: "application/json" },
    });
  });

  it("posts note mutation requests and parses the result payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              runId: "run-1",
              note: "# Follow-up\n\nKeep the pinned card flow.",
              changed: true,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);

    await expect(
      api.setRunNote("run-1", "# Follow-up\n\nKeep the pinned card flow."),
    ).resolves.toEqual({
      runId: "run-1",
      note: "# Follow-up\n\nKeep the pinned card flow.",
      changed: true,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/note", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ note: "# Follow-up\n\nKeep the pinned card flow." }),
    });
  });

  it("posts pin mutation requests and parses the result payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              runId: "run-1",
              pinned: true,
              changed: true,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);

    await expect(api.setRunPinned("run-1", true)).resolves.toEqual({
      runId: "run-1",
      pinned: true,
      changed: true,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/pinned", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ pinned: true }),
    });
  });

  it("parses run timeline history payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              history: {
                runId: "run-1",
                lastCursor: 7,
                attempts: [
                  {
                    attempt: 1,
                    sessionIndex: 0,
                    startedAt: "2026-04-13T05:00:00.000Z",
                    endedAt: "2026-04-13T05:02:00.000Z",
                    prompt: "Do the thing",
                    transcript: "done",
                    notices: "",
                    exitCode: 0,
                    timedOut: false,
                    live: false,
                  },
                  {
                    attempt: 2,
                    sessionIndex: 1,
                    startedAt: "2026-04-13T05:03:00.000Z",
                    endedAt: null,
                    prompt: "Keep going",
                    transcript: "streaming",
                    notices: "warning\n",
                    exitCode: null,
                    timedOut: false,
                    live: true,
                  },
                ],
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const api = createApiClient(config);

    const history = await api.getRunTimelineHistory("run-1");
    expect(history.runId).toBe("run-1");
    expect(history.lastCursor).toBe(7);
    expect(history.attempts).toHaveLength(2);
    expect(history.attempts[0]).toMatchObject({
      attempt: 1,
      prompt: "Do the thing",
      live: false,
    });
    expect(history.attempts[1]).toMatchObject({
      attempt: 2,
      notices: "warning\n",
      live: true,
    });
  });

  it("passes an abort signal to run timeline history requests", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            history: {
              runId: "run-1",
              lastCursor: 0,
              attempts: [],
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);
    const controller = new AbortController();

    await expect(
      api.getRunTimelineHistory("run-1", { signal: controller.signal }),
    ).resolves.toMatchObject({
      runId: "run-1",
      lastCursor: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/timeline",
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: controller.signal,
      }),
    );
  });

  it("parses run audit history payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              history: {
                runId: "run-1",
                lastCursor: 3,
                events: [
                  {
                    runId: "run-1",
                    cursor: 2,
                    event: {
                      type: "task.updated",
                      recordedAt: "2026-04-13T05:00:00.000Z",
                      source: "task_command",
                      hostMode: "embedded",
                      fields: {
                        taskId: "t1",
                        taskTitle: "First",
                        command: "set",
                        statusBefore: "pending",
                        statusAfter: "completed",
                        notesChanged: false,
                      },
                    },
                  },
                  {
                    runId: "run-1",
                    cursor: 3,
                    event: {
                      type: "run.finished",
                      recordedAt: "2026-04-13T05:01:00.000Z",
                      source: "system",
                      hostMode: "embedded",
                      fields: {
                        terminalStatus: "success",
                        exitCode: 0,
                        tasksCompleted: 1,
                        tasksTotal: 1,
                      },
                    },
                  },
                ],
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const api = createApiClient(config);

    await expect(api.getRunAuditHistory("run-1", { limit: 2 })).resolves.toEqual({
      runId: "run-1",
      lastCursor: 3,
      events: [
        expect.objectContaining({
          cursor: 2,
          event: expect.objectContaining({ type: "task.updated" }),
        }),
        expect.objectContaining({
          cursor: 3,
          event: expect.objectContaining({ type: "run.finished" }),
        }),
      ],
    });
  });

  it("rejects invalid run audit history payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              history: {
                runId: "run-1",
                lastCursor: "bad",
                events: [],
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const api = createApiClient(config);

    await expect(api.getRunAuditHistory("run-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "ApiError",
      status: 200,
    });
  });

  it("sends rename requests and parses the result payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              runId: "run-1",
              name: "Dashboard polish",
              changed: true,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);
    await expect(api.setRunName("run-1", "Dashboard polish")).resolves.toEqual({
      runId: "run-1",
      name: "Dashboard polish",
      changed: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/name",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Dashboard polish" }),
      }),
    );
  });

  it("sends backend-session mutation requests and parses the result payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              runId: "run-1",
              backendSessionId: "thread-42",
              changed: true,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              runId: "run-1",
              backendSessionId: null,
              changed: true,
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);
    await expect(api.setBackendSession("run-1", "thread-42")).resolves.toEqual({
      runId: "run-1",
      backendSessionId: "thread-42",
      changed: true,
    });
    await expect(api.clearBackendSession("run-1")).resolves.toEqual({
      runId: "run-1",
      backendSessionId: null,
      changed: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/runs/run-1/backend-session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ backendSessionId: "thread-42" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/runs/run-1/backend-session/clear",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("sends dependency mutation requests and parses the result payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              runId: "run-1",
              dependencyRunIds: ["run-2"],
              changed: true,
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);
    await expect(api.addDependency("run-1", "run-2")).resolves.toEqual({
      runId: "run-1",
      dependencyRunIds: ["run-2"],
      changed: true,
    });
    await expect(api.removeDependency("run-1", "run-2")).resolves.toEqual({
      runId: "run-1",
      dependencyRunIds: ["run-2"],
      changed: true,
    });
    await expect(api.clearDependencies("run-1")).resolves.toEqual({
      runId: "run-1",
      dependencyRunIds: ["run-2"],
      changed: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/runs/run-1/dependencies",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dependencyRunId: "run-2" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/runs/run-1/dependencies/run-2",
      expect.objectContaining({
        method: "DELETE",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/runs/run-1/dependencies/clear",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("uploads and removes attachments through the HTTP API", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === "DELETE"
              ? {
                  result: {
                    runId: "run-1",
                    attachmentId: "att-1",
                    changed: true,
                  },
                }
              : {
                  attachment: {
                    id: "att-1",
                    name: "notes.md",
                    mimeType: "text/markdown; charset=utf-8",
                    size: 12,
                    sha256: "abc",
                    addedAt: "2026-04-14T06:00:00.000Z",
                    relativePath: "attachments/att-1/notes.md",
                  },
                },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);
    const file = new File(["hello world"], "notes.md", { type: "text/markdown" });

    await expect(api.uploadAttachment("run-1", file)).resolves.toEqual(
      expect.objectContaining({
        id: "att-1",
        name: "notes.md",
      }),
    );
    await expect(api.removeAttachment("run-1", "att-1")).resolves.toEqual({
      runId: "run-1",
      attachmentId: "att-1",
      changed: true,
    });
  });

  it("lists attachments with family scope and parses ownerRunId", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            attachments: [
              {
                id: "att-1",
                name: "peer-notes.md",
                mimeType: "text/markdown; charset=utf-8",
                size: 12,
                sha256: "abc",
                addedAt: "2026-04-14T06:00:00.000Z",
                relativePath: "attachments/att-1/peer-notes.md",
                ownerRunId: "run-2",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);

    await expect(api.listAttachments("run-1", { scope: "family" })).resolves.toEqual([
      expect.objectContaining({
        id: "att-1",
        ownerRunId: "run-2",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/attachments?scope=family",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
  });

  it("lists and gets definitions through the HTTP API", async () => {
    const fetchMock = vi.fn(async (input) => {
      switch (input) {
        case "/api/agents":
          return new Response(
            JSON.stringify({
              agents: {
                kind: "agent",
                entries: [
                  {
                    name: "planner",
                    path: "/tmp/agents/planner/agent.md",
                    root: "config",
                  },
                ],
                warnings: [],
              },
            }),
            { status: 200 },
          );
        case "/api/agents/planner":
          return new Response(
            JSON.stringify({
              agent: {
                kind: "agent",
                config: {
                  schemaVersion: 1,
                  name: "planner",
                  backend: "passive",
                },
                instructions: "Plan the work.",
                sourcePath: "/tmp/agents/planner/agent.md",
              },
            }),
            { status: 200 },
          );
        case "/api/assignments":
          return new Response(
            JSON.stringify({
              assignments: {
                kind: "assignment",
                entries: [
                  {
                    name: "daemon-work",
                    path: "/tmp/assignments/daemon-work/assignment.md",
                    root: "config",
                  },
                ],
                warnings: [],
              },
            }),
            { status: 200 },
          );
        case "/api/assignments/daemon-work":
          return new Response(
            JSON.stringify({
              assignment: {
                kind: "assignment",
                config: {
                  schemaVersion: 1,
                  name: "daemon-work",
                  maxRetries: 1,
                  vars: {},
                  tasks: [],
                  hooks: {
                    prepare: [],
                    beforeAttempt: [],
                    afterAttempt: [],
                    afterExit: [],
                    taskTransition: [],
                  },
                  lockedFields: [],
                },
                instructions: "Ship the work.",
                sourcePath: "/tmp/assignments/daemon-work/assignment.md",
              },
            }),
            { status: 200 },
          );
        case "/api/launchers":
          return new Response(
            JSON.stringify({
              launchers: {
                kind: "launcher",
                entries: [
                  { name: "direct", path: null, root: "builtin" },
                  {
                    name: "ssh-wrap",
                    path: "/tmp/launchers/ssh-wrap.yaml",
                    root: "config",
                  },
                ],
                warnings: [],
              },
            }),
            { status: 200 },
          );
        case "/api/launchers/ssh-wrap":
          return new Response(
            JSON.stringify({
              launcher: {
                kind: "launcher",
                definition: {
                  kind: "prefix",
                  name: "ssh-wrap",
                  command: "ssh",
                  args: ["prod", "--"],
                  sourcePath: "/tmp/launchers/ssh-wrap.yaml",
                  root: "config",
                  config: {
                    schemaVersion: 1,
                    name: "ssh-wrap",
                    command: "ssh",
                    args: ["prod", "--"],
                  },
                },
              },
            }),
            { status: 200 },
          );
        default:
          throw new Error(`unexpected fetch ${String(input)}`);
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);

    await expect(api.listAgents()).resolves.toMatchObject({
      kind: "agent",
      entries: [expect.objectContaining({ name: "planner" })],
    });
    await expect(api.getAgent("planner")).resolves.toMatchObject({
      kind: "agent",
      config: expect.objectContaining({ name: "planner" }),
    });
    await expect(api.listAssignments()).resolves.toMatchObject({
      kind: "assignment",
      entries: [expect.objectContaining({ name: "daemon-work" })],
    });
    await expect(api.getAssignment("daemon-work")).resolves.toMatchObject({
      kind: "assignment",
      config: expect.objectContaining({ name: "daemon-work" }),
    });
    const launchers = await api.listLaunchers();
    expect(launchers.kind).toBe("launcher");
    expect(launchers.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "direct" })]),
    );
    await expect(api.getLauncher("ssh-wrap")).resolves.toMatchObject({
      kind: "launcher",
      definition: expect.objectContaining({ name: "ssh-wrap" }),
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/agents",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/agents/planner",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/assignments",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/assignments/daemon-work",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/launchers",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/launchers/ssh-wrap",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("encodes direct-path launcher targets and forwards cwd", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            launcher: {
              kind: "launcher",
              definition: {
                kind: "direct",
                name: "direct",
                sourcePath: null,
                root: "builtin",
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);

    await expect(
      api.getLauncher("./launchers/direct.yaml", { cwd: "/tmp/config-root" }),
    ).resolves.toMatchObject({
      kind: "launcher",
      definition: expect.objectContaining({ kind: "direct" }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/launchers/.%2Flaunchers%2Fdirect.yaml?cwd=%2Ftmp%2Fconfig-root",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
  });

  it("keeps callerCwd explicit in initRun and startRun request bodies", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);
    const input = {
      agent: "planner",
      assignment: "daemon-work",
      callerCwd: "/tmp/browser-cwd",
      cliVars: { plan: "web-init" },
      overrides: {
        cwd: "/tmp/override-cwd",
        message: "Start planning.",
      },
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: {
              runId: "run-1",
              parentRunId: null,
              repo: "task-runner",
              status: "initialized",
              effectiveStatus: "initialized",
              archivedAt: null,
              isLive: false,
              workspaceDir: "/tmp/run-1",
              assignmentPath: "/tmp/run-1/assignment-seed.md",
              agent: { name: "planner", sourcePath: null },
              assignment: null,
              backend: "passive",
              model: null,
              effort: null,
              name: null,
              note: null,
              pinned: false,
              backendSessionId: null,
              cwd: "/tmp/browser-cwd",
              unrestricted: false,
              timeoutSec: 60,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: null,
              exitCode: null,
              attempts: 0,
              maxAttempts: 1,
              sessionCount: 0,
              tasksCompleted: 0,
              tasksTotal: 0,
              attachments: [],
              dependencies: [],
              dependents: [],
              tasks: [],
              activeTask: null,
              message: null,
              pendingPrompt: null,
              callerInstructions: null,
              lockedFields: [],
              runtimeVars: {},
              execution: {
                hostMode: "embedded",
                controller: { kind: "embedded" },
              },
              capabilities: {
                canArchive: true,
                canUnarchive: false,
                canReset: true,
                canDelete: false,
                canReady: false,
                canResume: true,
                canAbort: false,
                abortReason: "not_active_in_daemon",
                taskMutation: {
                  canAdd: true,
                  canEditNotes: true,
                  canSetStatus: true,
                },
              },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: "run-2",
          }),
          { status: 200 },
        ),
      );

    await expect(api.initRun(input)).resolves.toMatchObject({ runId: "run-1" });
    await expect(api.startRun(input)).resolves.toBe("run-2");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/runs/init",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/runs",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
      }),
    );

    const initRequest = fetchMock.mock.calls[0]?.[1];
    const startRequest = fetchMock.mock.calls[1]?.[1];
    expect(initRequest).toBeDefined();
    expect(startRequest).toBeDefined();

    const initBody = JSON.parse((initRequest as RequestInit).body as string);
    const startBody = JSON.parse((startRequest as RequestInit).body as string);
    expect(initBody.callerCwd).toBe("/tmp/browser-cwd");
    expect(startBody.callerCwd).toBe("/tmp/browser-cwd");
    expect(initBody.overrides.cwd).toBe("/tmp/override-cwd");
    expect(startBody.overrides.cwd).toBe("/tmp/override-cwd");
  });

  it("rejects invalid definition list payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              agents: {
                kind: "agent",
                entries: [],
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const api = createApiClient(config);

    await expect(api.listAgents()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      name: "ApiError",
      status: 200,
    });
  });

  it("reads attachment preview text and normalizes the response media type", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("# Notes", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient(config);

    await expect(api.readAttachmentText("run-1", "att-1")).resolves.toEqual({
      mediaType: "text/markdown",
      text: "# Notes",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/attachments/att-1/content");
  });
});
