import type { RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { queryClient } from "./lib/query.js";
import { router } from "./router.js";

const APP_CONFIG = {
  apiBasePath: "/api",
  runEventsPath: "/api/events/runs",
};

class MockEventSource {
  static instances: MockEventSource[] = [];

  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {}

  emitMessage(payload: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }

  emitOpen() {
    this.onopen?.(new Event("open"));
  }
}

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    repo: "task-runner",
    status: "running",
    archivedAt: null,
    agentName: "implementer",
    assignmentName: "Build dashboard",
    backend: "codex",
    model: "gpt-5.4",
    sessionName: "dashboard",
    cwd: "/tmp/task-runner",
    startedAt: "2026-04-13T05:00:00.000Z",
    endedAt: null,
    tasksCompleted: 1,
    tasksTotal: 4,
    capabilities: {
      canArchive: false,
      canUnarchive: false,
      canResume: true,
      taskMutation: {
        canAdd: false,
        canEditNotes: false,
        canSetStatus: false,
      },
    },
    ...overrides,
  };
}

function makeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "run-1",
    repo: "task-runner",
    status: "running",
    archivedAt: null,
    isLive: true,
    workspaceDir: "/tmp/task-runner/.state/run-1",
    assignmentPath: "/tmp/task-runner/assignment.md",
    agent: {
      name: "implementer",
      sourcePath: null,
    },
    assignment: {
      name: "Build dashboard",
      sourcePath: "/tmp/assignment.md",
      workspacePath: "/tmp/task-runner/assignment.md",
    },
    backend: "codex",
    model: "gpt-5.4",
    effort: "high",
    sessionName: "dashboard",
    backendSessionId: "thread-1",
    cwd: "/tmp/task-runner",
    taskMode: "file",
    unrestricted: false,
    timeoutSec: 3600,
    startedAt: "2026-04-13T05:00:00.000Z",
    endedAt: null,
    exitCode: null,
    attempts: 1,
    maxAttempts: 3,
    sessionCount: 1,
    tasksCompleted: 1,
    tasksTotal: 4,
    tasks: [
      {
        id: "orient",
        title: "Orient",
        body: "Read the repo",
        status: "completed",
        notes: "done",
      },
      {
        id: "build",
        title: "Build UI",
        body: "Ship the web UI",
        status: "in_progress",
        notes: "working",
      },
    ],
    message: null,
    callerInstructions: null,
    pendingPrompt: null,
    lockedFields: ["tasks"],
    runtimeVars: {
      repo_path: ".",
    },
    capabilities: {
      canArchive: false,
      canUnarchive: false,
      canResume: true,
      taskMutation: {
        canAdd: false,
        canEditNotes: false,
        canSetStatus: false,
      },
    },
    ...overrides,
  };
}

function installFetchMock(state: {
  runs: RunSummary[];
  details: Record<string, RunDetail>;
}) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/app-config.json")) {
      return new Response(JSON.stringify(APP_CONFIG), { status: 200 });
    }

    if (url.includes("/api/runs?includeArchived=true")) {
      return new Response(JSON.stringify({ runs: state.runs }), { status: 200 });
    }

    const runMatch = /\/api\/runs\/([^/]+)$/.exec(url);
    if (runMatch && (!init?.method || init.method === "GET")) {
      const runId = runMatch[1];
      const detail = runId ? state.details[decodeURIComponent(runId)] : undefined;
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify({ run: detail }), { status: 200 });
    }

    const archiveMatch = /\/api\/runs\/([^/]+)\/(archive|unarchive|resume|abort)$/.exec(url);
    if (archiveMatch) {
      return new Response(JSON.stringify({ ok: true, result: { runId: archiveMatch[1] } }), {
        status: 200,
      });
    }

    throw new Error(`Unhandled fetch: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderApp() {
  await router.navigate({ to: "/" });
  return render(<App />);
}

describe("web app", () => {
  beforeEach(() => {
    queryClient.clear();
    window.localStorage.clear();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  });

  afterEach(async () => {
    cleanup();
    queryClient.clear();
    vi.unstubAllGlobals();
    await router.navigate({ to: "/" });
  });

  it("renders the board and detail drawer from shared run contracts", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    await screen.findByText("Build dashboard");
    await user.click(screen.getByRole("button", { name: /build dashboard/i }));

    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(screen.queryByText("Build UI")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /tasks\s+1\/4/i }));
    expect(await screen.findByText("Build UI")).toBeInTheDocument();
    expect(screen.getAllByText("Repo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /copy run id/i })).toBeInTheDocument();
  });

  it("distinguishes empty runs from filter-hidden runs", async () => {
    installFetchMock({
      runs: [],
      details: {},
    });

    await renderApp();
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();

    cleanup();
    queryClient.clear();

    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();
    await screen.findByText("Build dashboard");
    await user.type(screen.getByPlaceholderText("Search runs"), "does-not-match");
    expect(await screen.findByText("Filters hide every run")).toBeInTheDocument();
  });

  it("persists board settings in localStorage", async () => {
    installFetchMock({
      runs: [
        makeRun(),
        makeRun({
          runId: "run-archived",
          assignmentName: "Archived dashboard",
          archivedAt: "2026-04-13T06:00:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail(),
        "run-archived": makeDetail({
          runId: "run-archived",
          status: "success",
          assignment: {
            name: "Archived dashboard",
            sourcePath: "/tmp/a.md",
            workspacePath: "/tmp/b.md",
          },
          capabilities: {
            canArchive: false,
            canUnarchive: true,
            canResume: true,
            taskMutation: {
              canAdd: false,
              canEditNotes: false,
              canSetStatus: false,
            },
          },
        }),
      },
    });

    const user = userEvent.setup();
    const view = await renderApp();
    await screen.findByText("Build dashboard");
    expect(screen.queryByText("Archived dashboard")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show archived runs/i }));
    expect(await screen.findByText("Archived dashboard")).toBeInTheDocument();

    view.unmount();
    queryClient.clear();
    await renderApp();
    expect(await screen.findByText("Archived dashboard")).toBeInTheDocument();
  });

  it("shows capability-driven actions and hides passive-only controls", async () => {
    installFetchMock({
      runs: [
        makeRun({ runId: "resumable", assignmentName: "Resumable run", status: "success" }),
        makeRun({
          runId: "passive",
          assignmentName: "Passive run",
          status: "success",
          backend: "passive",
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: false,
            taskMutation: {
              canAdd: false,
              canEditNotes: false,
              canSetStatus: false,
            },
          },
        }),
      ],
      details: {
        resumable: makeDetail({
          runId: "resumable",
          status: "success",
          assignment: {
            name: "Resumable run",
            sourcePath: "/tmp/a.md",
            workspacePath: "/tmp/b.md",
          },
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: true,
            taskMutation: {
              canAdd: false,
              canEditNotes: false,
              canSetStatus: false,
            },
          },
        }),
        passive: makeDetail({
          runId: "passive",
          status: "success",
          backend: "passive",
          assignment: { name: "Passive run", sourcePath: "/tmp/a.md", workspacePath: "/tmp/b.md" },
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: false,
            taskMutation: {
              canAdd: false,
              canEditNotes: false,
              canSetStatus: false,
            },
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await screen.findByText("Resumable run");

    await user.click(screen.getByRole("button", { name: /resumable run/i }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();

    const closeButtons = screen.getAllByRole("button", { name: /close detail/i });
    const closeButton = closeButtons[0];
    if (!closeButton) {
      throw new Error("expected a close-detail button");
    }
    await user.click(closeButton);
    await user.click(screen.getByRole("button", { name: /passive run/i }));
    expect(await screen.findByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
  });

  it("shows Abort only for live running runs", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail(),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await screen.findByText("Build dashboard");
    await user.click(screen.getByRole("button", { name: /build dashboard/i }));

    expect(await screen.findByRole("button", { name: "Abort" })).toBeInTheDocument();
  });

  it("applies SSE updates and falls back to HTTP refetch when the stream goes stale", async () => {
    const state = {
      runs: [makeRun({ assignmentName: "Original title" })],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Original title",
            sourcePath: "/tmp/a.md",
            workspacePath: "/tmp/b.md",
          },
        }),
      },
    };
    installFetchMock(state);

    await renderApp();
    expect(await screen.findByText("Original title")).toBeInTheDocument();

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitOpen();

    state.runs = [makeRun({ assignmentName: "Updated from SSE" })];
    state.details["run-1"] = makeDetail({
      assignment: { name: "Updated from SSE", sourcePath: "/tmp/a.md", workspacePath: "/tmp/b.md" },
    });
    source.emitMessage({
      runId: "run-1",
      event: { type: "run_finished", summary: { runId: "run-1" } },
    });

    expect(await screen.findByText("Updated from SSE")).toBeInTheDocument();

    state.runs = [makeRun({ assignmentName: "Recovered after stale" })];
    source.emitError();

    expect(await screen.findByText(/live updates are temporarily stale/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Recovered after stale")).toBeInTheDocument());
  });

  it("keeps one SSE subscription while switching selected runs", async () => {
    installFetchMock({
      runs: [makeRun(), makeRun({ runId: "run-2", assignmentName: "Second run" })],
      details: {
        "run-1": makeDetail(),
        "run-2": makeDetail({
          runId: "run-2",
          assignment: {
            name: "Second run",
            sourcePath: "/tmp/a.md",
            workspacePath: "/tmp/b.md",
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await screen.findByText("Second run");

    expect(MockEventSource.instances).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /build dashboard/i }));
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(MockEventSource.instances).toHaveLength(1);

    const closeButtons = screen.getAllByRole("button", { name: /close detail/i });
    const closeButton = closeButtons[0];
    if (!closeButton) {
      throw new Error("expected a close-detail button");
    }
    await user.click(closeButton);
    await user.click(screen.getByRole("button", { name: /second run/i }));

    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
