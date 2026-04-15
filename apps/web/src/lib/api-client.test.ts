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
                  repo: "task-runner",
                  status: "initialized",
                  effectiveStatus: "running",
                  archivedAt: null,
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
        dependencyState: {
          ready: false,
          total: 2,
          satisfied: 1,
          unsatisfied: 1,
        },
      }),
    ]);
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
});
