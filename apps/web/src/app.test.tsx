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

  emitRawMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }

  emitOpen() {
    this.onopen?.(new Event("open"));
  }
}

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  const run: RunSummary = {
    runId: "run-1",
    repo: "task-runner",
    status: "running",
    archivedAt: null,
    agentName: "implementer",
    assignmentName: "Build dashboard",
    backend: "codex",
    model: "gpt-5.4",
    name: "Build dashboard",
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
  if (overrides.name === undefined && overrides.assignmentName !== undefined) {
    run.name = overrides.assignmentName;
  }
  return run;
}

function makeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  const detail: RunDetail = {
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
    name: "Build dashboard",
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
  if (overrides.name === undefined && overrides.assignment?.name !== undefined) {
    detail.name = overrides.assignment.name;
  }
  return detail;
}

function installFetchMock(
  state: {
    runs: RunSummary[];
    details: Record<string, RunDetail>;
  },
  options?: {
    handleRequest?: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response | undefined> | Response | undefined;
  },
) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const override = await options?.handleRequest?.(url, init);
    if (override) {
      return override;
    }
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
      const [, runId, action] = archiveMatch;
      if (action === "archive") {
        return new Response(
          JSON.stringify({
            result: {
              archivedAt: "2026-04-13T06:00:00.000Z",
              changed: true,
              runId,
              status: "success",
            },
          }),
          { status: 200 },
        );
      }
      if (action === "unarchive") {
        return new Response(
          JSON.stringify({
            result: {
              archivedAt: null,
              changed: true,
              runId,
              status: "success",
            },
          }),
          { status: 200 },
        );
      }
      if (action === "resume") {
        return new Response(JSON.stringify({ runId }), { status: 200 });
      }
      return new Response(JSON.stringify({ accepted: true, runId }), { status: 200 });
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

async function findRunCard(name: string | RegExp) {
  return await screen.findByRole("button", {
    name: typeof name === "string" ? new RegExp(name, "i") : name,
  });
}

function getCloseDetailButton() {
  const closeButtons = screen.getAllByRole("button", { name: /close detail/i });
  const closeButton = closeButtons[0];
  if (!closeButton) {
    throw new Error("expected a close-detail button");
  }
  return closeButton;
}

function defineElementMetric(element: Element, key: string, value: number | (() => void)) {
  Object.defineProperty(element, key, {
    configurable: true,
    value,
  });
}

function setBoardGeometry(options: {
  clientWidth: number;
  scrollLeft?: number;
  scrollTo?: ReturnType<typeof vi.fn>;
  scrollWidth: number;
  columns: Array<{ key: string; left: number; width: number }>;
}) {
  const board = screen.getByLabelText("Run board");
  defineElementMetric(board, "clientWidth", options.clientWidth);
  defineElementMetric(board, "scrollLeft", options.scrollLeft ?? 0);
  defineElementMetric(board, "scrollWidth", options.scrollWidth);
  defineElementMetric(
    board,
    "scrollTo",
    options.scrollTo ??
      vi.fn(({ left }: { left: number }) => {
        defineElementMetric(board, "scrollLeft", left);
      }),
  );

  for (const column of options.columns) {
    const element = board.querySelector(`[data-status="${column.key}"]`);
    if (!element) {
      continue;
    }
    defineElementMetric(element, "offsetLeft", column.left);
    defineElementMetric(element, "offsetWidth", column.width);
  }

  window.dispatchEvent(new Event("resize"));
  return board as HTMLElement;
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

    await user.click(await findRunCard("Build dashboard"));

    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(screen.getByText("Build UI")).toBeInTheDocument();
    expect(screen.getAllByText("Repo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /copy run id/i })).toBeInTheDocument();
  });

  it("falls back to document copy when clipboard access is unavailable", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Build dashboard"));
    await screen.findByLabelText("Run detail");
    await user.click(screen.getByRole("button", { name: /copy backend session id/i }));

    expect(await screen.findByText("Copied backend session id.")).toBeInTheDocument();
    expect(document.querySelector(".notice-stack--bottom")).not.toBeNull();

    await waitFor(
      () => {
        expect(screen.queryByText("Copied backend session id.")).not.toBeInTheDocument();
        expect(document.querySelector(".notice-stack--bottom")).toBeNull();
      },
      { timeout: 5000 },
    );
  });

  it("collapses task details by default and expands them on click", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Build dashboard"));
    await screen.findByLabelText("Run detail");

    expect(screen.queryByText("Ship the web UI")).not.toBeInTheDocument();
    expect(screen.queryByText("working")).not.toBeInTheDocument();

    const taskHeader = screen.getByRole("button", { name: /build ui/i, expanded: false });
    await user.click(taskHeader);

    expect(await screen.findByText("Ship the web UI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /build ui/i, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Instructions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();

    expect(screen.queryByText("working")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(await screen.findByText("working")).toBeInTheDocument();
    expect(screen.queryByText("Ship the web UI")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /build ui/i, expanded: true }));
    expect(screen.queryByText("working")).not.toBeInTheDocument();
  });

  it("pressing escape clears selection and closes the detail drawer", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    const runCard = await screen.findByRole("button", { name: /build dashboard/i });
    await user.click(runCard);
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByLabelText("Run detail")).not.toBeInTheDocument();
    });
  });

  it("resizes the detail drawer via the keyboard separator and persists the width", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const drawer = await screen.findByLabelText("Run detail");
    expect(drawer.style.getPropertyValue("--drawer-width")).toBe("540px");

    const handle = screen.getByRole("separator", { name: /resize detail drawer/i });
    handle.focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");

    expect(drawer.style.getPropertyValue("--drawer-width")).toBe("570px");
    expect(handle.getAttribute("aria-valuenow")).toBe("570");

    const stored = window.localStorage.getItem("task-runner:web:board-settings");
    const parsed = stored ? (JSON.parse(stored) as { drawerWidth?: number }) : null;
    expect(parsed?.drawerWidth).toBe(570);
  });

  it("keeps the pending detail skeleton at the persisted drawer width", async () => {
    let resolveDetail: ((response: Response) => void) | undefined;
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest: (url, init) => {
          if (/\/api\/runs\/run-1$/.test(url) && (!init?.method || init.method === "GET")) {
            return new Promise<Response>((resolve) => {
              resolveDetail = resolve;
            });
          }
          return undefined;
        },
      },
    );

    window.localStorage.setItem(
      "task-runner:web:board-settings",
      JSON.stringify({ drawerWidth: 700 }),
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const skeletonDrawer = await screen.findByLabelText("Run detail");
    expect(skeletonDrawer.style.getPropertyValue("--drawer-width")).toBe("700px");

    resolveDetail?.(new Response(JSON.stringify({ run: makeDetail() }), { status: 200 }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy run id/i })).toBeInTheDocument();
    });
  });

  it("renders markdown in task body and notes", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail({
          tasks: [
            {
              id: "render",
              title: "Render markdown",
              body: "**Done when:** the markdown renders\n\n- bullet one\n- bullet two",
              status: "in_progress",
              notes: "Captured `npm run check` exit code 0.",
            },
          ],
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await screen.findByLabelText("Run detail");
    await user.click(screen.getByRole("button", { name: /render markdown/i, expanded: false }));

    expect(await screen.findByText("Done when:")).toBeInTheDocument();
    const bulletOne = screen.getByText("bullet one");
    expect(bulletOne).toBeInTheDocument();
    expect(bulletOne.tagName).toBe("LI");

    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(await screen.findByText("npm run check")).toBeInTheDocument();
    expect(screen.getByText("npm run check").tagName).toBe("CODE");
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
    await findRunCard("Build dashboard");
    await user.type(screen.getByPlaceholderText("Search runs"), "does-not-match");
    expect(await screen.findByText("Filters hide every run")).toBeInTheDocument();
  });

  it("renders unnamed runs separately from assignment metadata and searches by run name", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-unnamed",
          assignmentName: "Assignment metadata",
          name: null,
        }),
        makeRun({
          runId: "run-search",
          assignmentName: "Different assignment",
          name: "Search-only name",
        }),
      ],
      details: {
        "run-unnamed": makeDetail({
          runId: "run-unnamed",
          name: null,
          assignment: {
            name: "Assignment metadata",
            sourcePath: "/tmp/assignment.md",
            workspacePath: "/tmp/task-runner/assignment.md",
          },
        }),
        "run-search": makeDetail({
          runId: "run-search",
          name: "Search-only name",
          assignment: {
            name: "Different assignment",
            sourcePath: "/tmp/assignment.md",
            workspacePath: "/tmp/task-runner/assignment.md",
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    const unnamedCard = await findRunCard("Unnamed");
    expect(unnamedCard).toHaveAttribute("title", "Unnamed");
    expect(screen.getByText("Assignment metadata")).toBeInTheDocument();

    await user.click(unnamedCard);
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Unnamed" })).toBeInTheDocument();
    expect(screen.getByText("Assignment: Assignment metadata")).toBeInTheDocument();

    await user.click(getCloseDetailButton());
    await user.clear(screen.getByPlaceholderText("Search runs"));
    await user.type(screen.getByPlaceholderText("Search runs"), "search-only");

    expect(await screen.findByRole("button", { name: /search-only name/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unnamed/i })).not.toBeInTheDocument();
  });

  it("persists board settings in localStorage", async () => {
    installFetchMock({
      runs: [
        makeRun(),
        makeRun({
          runId: "run-blocked",
          assignmentName: "Blocked dashboard",
          status: "blocked",
        }),
        makeRun({
          runId: "run-error",
          assignmentName: "Broken dashboard",
          status: "error",
        }),
        makeRun({
          runId: "run-archived",
          assignmentName: "Archived dashboard",
          archivedAt: "2026-04-13T06:00:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail(),
        "run-blocked": makeDetail({
          runId: "run-blocked",
          status: "blocked",
        }),
        "run-error": makeDetail({
          runId: "run-error",
          status: "error",
        }),
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
    await findRunCard("Build dashboard");
    expect(screen.queryByRole("button", { name: /archived dashboard/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failures" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Blocked" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Aborted" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show archived runs/i }));
    await user.click(screen.getByRole("button", { name: /hide empty columns/i }));
    await user.click(screen.getByRole("button", { name: /collapse failure states/i }));
    expect(await screen.findByRole("button", { name: /archived dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Blocked" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Error" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Aborted" })).toBeInTheDocument();

    view.unmount();
    queryClient.clear();
    await renderApp();
    expect(await screen.findByRole("button", { name: /archived dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Blocked" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Error" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Aborted" })).toBeInTheDocument();
  });

  it("ignores malformed stored board settings values", async () => {
    window.localStorage.setItem(
      "task-runner:web:board-settings",
      JSON.stringify({
        collapseFailureStates: "yes",
        drawerWidth: "wide",
        hideEmptyColumns: "no",
        repo: 42,
        search: ["dashboard"],
        showArchived: "sure",
      }),
    );

    installFetchMock({
      runs: [
        makeRun(),
        makeRun({
          runId: "run-blocked",
          assignmentName: "Blocked dashboard",
          status: "blocked",
        }),
        makeRun({
          runId: "run-archived",
          assignmentName: "Archived dashboard",
          archivedAt: "2026-04-13T06:00:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail(),
        "run-blocked": makeDetail({
          runId: "run-blocked",
          status: "blocked",
        }),
        "run-archived": makeDetail({
          runId: "run-archived",
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    expect(screen.queryByRole("button", { name: /archived dashboard/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failures" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Blocked" })).not.toBeInTheDocument();

    await user.click(await findRunCard("Build dashboard"));
    const drawer = await screen.findByLabelText("Run detail");
    expect(drawer.style.getPropertyValue("--drawer-width")).toBe("540px");
  });

  it("shows jump buttons for overflowed non-empty columns and scrolls them into view", async () => {
    installFetchMock({
      runs: [
        makeRun(),
        makeRun({
          runId: "run-success",
          assignmentName: "Done dashboard",
          status: "success",
        }),
        makeRun({
          runId: "run-blocked",
          assignmentName: "Blocked dashboard",
          status: "blocked",
        }),
      ],
      details: {
        "run-1": makeDetail(),
        "run-success": makeDetail({
          runId: "run-success",
          status: "success",
        }),
        "run-blocked": makeDetail({
          runId: "run-blocked",
          status: "blocked",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    const scrollTo = vi.fn();
    setBoardGeometry({
      clientWidth: 260,
      columns: [
        { key: "running", left: 0, width: 180 },
        { key: "completed", left: 200, width: 180 },
        { key: "failures", left: 400, width: 180 },
      ],
      scrollTo,
      scrollWidth: 620,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Running (1)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Completed (1)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Failures (1)" })).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Pending (0)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aborted (0)" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Failures (1)" }));

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", left: 360 });
  });

  it("hides jump buttons when all non-empty columns already fit", async () => {
    installFetchMock({
      runs: [
        makeRun(),
        makeRun({
          runId: "run-success",
          assignmentName: "Done dashboard",
          status: "success",
        }),
        makeRun({
          runId: "run-blocked",
          assignmentName: "Blocked dashboard",
          status: "blocked",
        }),
      ],
      details: {
        "run-1": makeDetail(),
        "run-success": makeDetail({
          runId: "run-success",
          status: "success",
        }),
        "run-blocked": makeDetail({
          runId: "run-blocked",
          status: "blocked",
        }),
      },
    });

    await renderApp();
    await findRunCard("Build dashboard");

    setBoardGeometry({
      clientWidth: 800,
      columns: [
        { key: "running", left: 0, width: 180 },
        { key: "completed", left: 200, width: 180 },
        { key: "failures", left: 400, width: 180 },
      ],
      scrollWidth: 800,
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Running (1)" })).not.toBeInTheDocument();
    });
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
    await findRunCard("Resumable run");

    await user.click(await findRunCard("Resumable run"));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();

    await user.click(getCloseDetailButton());
    await user.click(await findRunCard("Passive run"));
    expect(await screen.findByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
  });

  it("locks all run-level actions while one mutation is pending", async () => {
    let resolveArchive: (() => void) | undefined;
    installFetchMock(
      {
        runs: [makeRun({ runId: "resumable", assignmentName: "Resumable run", status: "success" })],
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
        },
      },
      {
        handleRequest: (url) => {
          if (url.endsWith("/api/runs/resumable/archive")) {
            return new Promise<Response>((resolve) => {
              resolveArchive = () => {
                resolve(
                  new Response(
                    JSON.stringify({
                      result: {
                        archivedAt: "2026-04-13T06:00:00.000Z",
                        changed: true,
                        runId: "resumable",
                        status: "success",
                      },
                    }),
                    { status: 200 },
                  ),
                );
              };
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Resumable run");
    await user.click(await findRunCard("Resumable run"));

    await user.click(await screen.findByRole("button", { name: "Archive" }));

    expect(await screen.findByRole("button", { name: "Archiving..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();

    resolveArchive?.();

    await waitFor(() => {
      expect(screen.queryByLabelText("Run detail")).not.toBeInTheDocument();
    });
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
    await user.click(await findRunCard("Build dashboard"));

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
    expect(await screen.findByRole("button", { name: /original title/i })).toBeInTheDocument();

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

    expect(await screen.findByRole("button", { name: /updated from sse/i })).toBeInTheDocument();

    state.runs = [makeRun({ assignmentName: "Recovered after stale" })];
    source.emitError();

    expect(await screen.findByText(/live updates are temporarily stale/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /recovered after stale/i })).toBeInTheDocument(),
    );
  });

  it("revalidates after SSE reconnect before clearing the stale banner", async () => {
    let failNextRunsFetch = false;
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
    installFetchMock(state, {
      handleRequest: (url) => {
        if (url.includes("/api/runs?includeArchived=true") && failNextRunsFetch) {
          failNextRunsFetch = false;
          return new Response(
            JSON.stringify({ error: { message: "temporary failure", code: "server_error" } }),
            { status: 500 },
          );
        }
        return undefined;
      },
    });

    await renderApp();
    expect(await screen.findByRole("button", { name: /original title/i })).toBeInTheDocument();

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitOpen();

    state.runs = [makeRun({ assignmentName: "Recovered after reconnect" })];
    failNextRunsFetch = true;
    source.emitError();

    expect(await screen.findByText(/live updates are temporarily stale/i)).toBeInTheDocument();
    source.emitOpen();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /recovered after reconnect/i }),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByText(/live updates are temporarily stale/i)).not.toBeInTheDocument(),
    );
  });

  it("marks the stream stale when an SSE payload is malformed", async () => {
    installFetchMock({
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
    });

    await renderApp();
    expect(await screen.findByRole("button", { name: /original title/i })).toBeInTheDocument();

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitOpen();
    source.emitRawMessage("{");

    expect(await screen.findByText(/live updates are temporarily stale/i)).toBeInTheDocument();
  });

  it("marks the stream stale when an SSE payload shape is invalid", async () => {
    installFetchMock({
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
    });

    await renderApp();
    expect(await screen.findByRole("button", { name: /original title/i })).toBeInTheDocument();

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitOpen();
    source.emitMessage({ runId: "run-1", event: {} });

    expect(await screen.findByText(/live updates are temporarily stale/i)).toBeInTheDocument();
  });

  it("ignores non-stateful SSE events for HTTP refresh", async () => {
    const fetchMock = installFetchMock({
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
    });

    await renderApp();
    expect(await screen.findByRole("button", { name: /original title/i })).toBeInTheDocument();

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitOpen();

    const callsBefore = fetchMock.mock.calls.length;
    source.emitMessage({
      runId: "run-1",
      event: { type: "backend_notice", text: "noise" },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(fetchMock).toHaveBeenCalledTimes(callsBefore);
  });

  it("resets drawer and task state when switching runs", async () => {
    installFetchMock({
      runs: [makeRun(), makeRun({ runId: "run-2", assignmentName: "Second run" })],
      details: {
        "run-1": makeDetail({
          tasks: [
            {
              id: "shared-task",
              title: "Shared task",
              body: "First run description",
              status: "in_progress",
              notes: "First run notes",
            },
          ],
        }),
        "run-2": makeDetail({
          runId: "run-2",
          assignment: {
            name: "Second run",
            sourcePath: "/tmp/a.md",
            workspacePath: "/tmp/b.md",
          },
          tasks: [
            {
              id: "shared-task",
              title: "Shared task",
              body: "Second run description",
              status: "in_progress",
              notes: "Second run notes",
            },
          ],
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Second run");

    await user.click(await findRunCard("Second run"));
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    await router.navigate({ to: "/" });

    await user.click(await findRunCard("Build dashboard"));
    await screen.findByLabelText("Run detail");
    await user.click(screen.getByRole("button", { name: /shared task/i, expanded: false }));
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(await screen.findByText("First run notes")).toBeInTheDocument();

    await router.navigate({ to: "/runs/$runId", params: { runId: "run-2" } });

    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /shared task/i, expanded: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Second run notes")).not.toBeInTheDocument();
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
    await findRunCard("Second run");

    expect(MockEventSource.instances).toHaveLength(1);

    await user.click(await findRunCard("Build dashboard"));
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(MockEventSource.instances).toHaveLength(1);

    await user.click(getCloseDetailButton());
    await user.click(await findRunCard("Second run"));

    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
