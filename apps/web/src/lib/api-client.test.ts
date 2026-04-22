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

  it("lists attachments with cwd scope and parses ownerRunId", async () => {
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

    await expect(api.listAttachments("run-1", { cwdScope: true })).resolves.toEqual([
      expect.objectContaining({
        id: "att-1",
        ownerRunId: "run-2",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/attachments?cwdScope=true",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
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
