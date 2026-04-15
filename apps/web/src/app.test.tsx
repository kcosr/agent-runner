import type { RunTimelineHistory } from "@task-runner/core/contracts/events.js";
import type { RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { queryClient } from "./lib/query.js";
import { router } from "./router.js";

const APP_CONFIG = {
  apiBasePath: "/api",
  runSummaryEventsPath: "/api/events/run-summaries",
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

function abortReasonForStatus(status: RunSummary["status"] | RunDetail["status"]) {
  return status === "success" ||
    status === "blocked" ||
    status === "exhausted" ||
    status === "aborted" ||
    status === "error"
    ? "already_terminal"
    : "not_active_in_daemon";
}

function makeRun(
  overrides: Partial<Omit<RunSummary, "capabilities" | "execution">> & {
    capabilities?: Partial<RunSummary["capabilities"]>;
    execution?: RunSummary["execution"];
  } = {},
): RunSummary {
  const base = {
    runId: "run-1",
    repo: "task-runner",
    status: "running",
    effectiveStatus: "running",
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
    execution: {
      hostMode: "embedded",
      controller: {
        kind: "embedded",
      },
    },
  } satisfies Omit<RunSummary, "capabilities" | "execution"> & {
    capabilities: RunSummary["capabilities"];
    execution: RunSummary["execution"];
  };
  const run = {
    ...base,
    ...overrides,
    capabilities: {
      ...base.capabilities,
      ...(overrides.capabilities ?? {}),
    },
    execution: overrides.execution ?? base.execution,
  } as RunSummary;
  if (overrides.status !== undefined && !("effectiveStatus" in overrides)) {
    run.effectiveStatus = overrides.status;
  }
  if (
    overrides.status !== undefined &&
    overrides.activeTask === undefined &&
    overrides.status !== "running"
  ) {
    run.activeTask = null;
  }
  if (overrides.capabilities === undefined || overrides.capabilities.abortReason === undefined) {
    run.capabilities.abortReason = run.capabilities.canAbort
      ? undefined
      : abortReasonForStatus(run.status);
  }
  if (overrides.name === undefined && overrides.assignmentName !== undefined) {
    run.name = overrides.assignmentName;
  }
  return run;
}

function makeDetail(
  overrides: Partial<Omit<RunDetail, "capabilities" | "execution">> & {
    capabilities?: Partial<RunDetail["capabilities"]>;
    execution?: RunDetail["execution"];
  } = {},
): RunDetail {
  const base = {
    runId: "run-1",
    repo: "task-runner",
    status: "running",
    effectiveStatus: "running",
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
    attachments: [],
    dependencies: [],
    dependents: [],
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
    activeTask: {
      id: "build",
      title: "Build UI",
    },
    message: null,
    callerInstructions: null,
    lockedFields: ["tasks"],
    runtimeVars: {
      repo_path: ".",
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
    execution: {
      hostMode: "embedded",
      controller: {
        kind: "embedded",
      },
    },
  } satisfies Omit<RunDetail, "capabilities" | "execution"> & {
    capabilities: RunDetail["capabilities"];
    execution: RunDetail["execution"];
  };
  const detail = {
    ...base,
    ...overrides,
    capabilities: {
      ...base.capabilities,
      ...(overrides.capabilities ?? {}),
    },
    execution: overrides.execution ?? base.execution,
  } as RunDetail;
  if (overrides.status !== undefined && !("effectiveStatus" in overrides)) {
    detail.effectiveStatus = overrides.status;
  }
  if (
    overrides.status !== undefined &&
    overrides.activeTask === undefined &&
    overrides.status !== "running"
  ) {
    detail.activeTask = null;
  }
  if (overrides.capabilities === undefined || overrides.capabilities.abortReason === undefined) {
    detail.capabilities.abortReason = detail.capabilities.canAbort
      ? undefined
      : abortReasonForStatus(detail.status);
  }
  if (overrides.name === undefined && overrides.assignment?.name !== undefined) {
    detail.name = overrides.assignment.name;
  }
  return detail;
}

function installFetchMock(
  state: {
    runs: RunSummary[];
    details: Record<string, RunDetail>;
    timelineHistories?: Record<string, RunTimelineHistory>;
  },
  options?: {
    handleRequest?: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response | undefined> | Response | undefined;
  },
) {
  function dependencyDetailFor(runId: string): RunDetail["dependencies"][number] {
    const detail = state.details[runId];
    if (!detail) {
      return {
        runId,
        name: null,
        status: null,
        effectiveStatus: null,
        archivedAt: null,
        satisfied: false,
        missing: true,
      };
    }
    return {
      runId: detail.runId,
      name: detail.name,
      status: detail.status,
      effectiveStatus: detail.effectiveStatus,
      archivedAt: detail.archivedAt,
      satisfied: detail.status === "success",
      missing: false,
    };
  }

  function syncDependencyState(runId: string) {
    const detail = state.details[runId];
    if (!detail) {
      return;
    }
    const satisfied = detail.dependencies.filter((dependency) => dependency.satisfied).length;
    const dependencyState = {
      ready: detail.dependencies.length === satisfied,
      total: detail.dependencies.length,
      satisfied,
      unsatisfied: detail.dependencies.length - satisfied,
    };
    state.runs = state.runs.map((run) => (run.runId === runId ? { ...run, dependencyState } : run));
  }

  function syncAttachmentCount(runId: string) {
    const detail = state.details[runId];
    if (!detail) {
      return;
    }
    state.runs = state.runs.map((run) =>
      run.runId === runId ? { ...run, attachmentCount: detail.attachments.length } : run,
    );
  }

  function headerValue(headers: HeadersInit | undefined, key: string): string | null {
    if (!headers) {
      return null;
    }
    if (headers instanceof Headers) {
      return headers.get(key);
    }
    if (Array.isArray(headers)) {
      const entry = headers.find(([name]) => name.toLowerCase() === key.toLowerCase());
      return entry?.[1] ?? null;
    }
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === key.toLowerCase()) {
        return value;
      }
    }
    return null;
  }

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

    const attachmentsMatch = /\/api\/runs\/([^/]+)\/attachments$/.exec(url);
    if (attachmentsMatch) {
      const runId = decodeURIComponent(attachmentsMatch[1] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify({ attachments: detail.attachments }), { status: 200 });
      }
      if (init.method === "POST") {
        const rawName = headerValue(init.headers, "x-task-runner-attachment-name");
        const name = rawName ? decodeURIComponent(rawName) : "upload.bin";
        const attachment = {
          id: `att-${detail.attachments.length + 1}`,
          name,
          mimeType: headerValue(init.headers, "content-type") ?? "application/octet-stream",
          size: 12,
          sha256: "abc123",
          addedAt: "2026-04-14T06:00:00.000Z",
          relativePath: `attachments/att-${detail.attachments.length + 1}/${name}`,
        };
        detail.attachments = [...detail.attachments, attachment];
        syncAttachmentCount(runId);
        return new Response(JSON.stringify({ attachment }), { status: 200 });
      }
    }

    const attachmentContentMatch = /\/api\/runs\/([^/]+)\/attachments\/([^/]+)\/content$/.exec(url);
    if (attachmentContentMatch && (!init?.method || init.method === "GET")) {
      const runId = decodeURIComponent(attachmentContentMatch[1] ?? "");
      const attachmentId = decodeURIComponent(attachmentContentMatch[2] ?? "");
      const attachment = state.details[runId]?.attachments.find((item) => item.id === attachmentId);
      if (!attachment) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      return new Response("attachment body", {
        status: 200,
        headers: { "content-type": attachment.mimeType },
      });
    }

    const removeAttachmentMatch = /\/api\/runs\/([^/]+)\/attachments\/([^/]+)$/.exec(url);
    if (removeAttachmentMatch && init?.method === "DELETE") {
      const runId = decodeURIComponent(removeAttachmentMatch[1] ?? "");
      const attachmentId = decodeURIComponent(removeAttachmentMatch[2] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      detail.attachments = detail.attachments.filter(
        (attachment) => attachment.id !== attachmentId,
      );
      syncAttachmentCount(runId);
      return new Response(
        JSON.stringify({
          result: {
            runId,
            attachmentId,
            changed: true,
          },
        }),
        { status: 200 },
      );
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

    const timelineMatch = /\/api\/runs\/([^/]+)\/timeline$/.exec(url);
    if (timelineMatch && (!init?.method || init.method === "GET")) {
      const runId = decodeURIComponent(timelineMatch[1] ?? "");
      if (!state.details[runId]) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const history = state.timelineHistories?.[runId] ?? {
        runId,
        attempts: [],
        lastCursor: 0,
      };
      return new Response(JSON.stringify({ history }), { status: 200 });
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

    const renameMatch = /\/api\/runs\/([^/]+)\/name$/.exec(url);
    if (renameMatch && init?.method === "POST") {
      const runId = decodeURIComponent(renameMatch[1] ?? "");
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { name?: string | null })
          : {};
      const name = body.name ?? null;
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const changed = detail.name !== name;
      state.details[runId] = { ...detail, name };
      state.runs = state.runs.map((run) => (run.runId === runId ? { ...run, name } : run));
      return new Response(JSON.stringify({ result: { runId, name, changed } }), { status: 200 });
    }

    const addDependencyMatch = /\/api\/runs\/([^/]+)\/dependencies$/.exec(url);
    if (addDependencyMatch && init?.method === "POST") {
      const runId = decodeURIComponent(addDependencyMatch[1] ?? "");
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { dependencyRunId?: string })
          : {};
      const detail = state.details[runId];
      if (!detail || !body.dependencyRunId) {
        return new Response(JSON.stringify({ error: { message: "invalid", code: "invalid" } }), {
          status: 400,
        });
      }
      const dependencyRunId = body.dependencyRunId;
      detail.dependencies = [...detail.dependencies, dependencyDetailFor(dependencyRunId)];
      const dependencyDetail = state.details[dependencyRunId];
      if (dependencyDetail) {
        dependencyDetail.dependents = [...dependencyDetail.dependents, dependencyDetailFor(runId)];
      }
      syncDependencyState(runId);
      return new Response(
        JSON.stringify({
          result: {
            runId,
            dependencyRunIds: detail.dependencies.map((dependency) => dependency.runId),
            changed: true,
          },
        }),
        { status: 200 },
      );
    }

    const removeDependencyMatch = /\/api\/runs\/([^/]+)\/dependencies\/([^/]+)$/.exec(url);
    if (removeDependencyMatch && init?.method === "DELETE") {
      const runId = decodeURIComponent(removeDependencyMatch[1] ?? "");
      const dependencyRunId = decodeURIComponent(removeDependencyMatch[2] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      detail.dependencies = detail.dependencies.filter(
        (dependency) => dependency.runId !== dependencyRunId,
      );
      const dependencyDetail = state.details[dependencyRunId];
      if (dependencyDetail) {
        dependencyDetail.dependents = dependencyDetail.dependents.filter(
          (dependent) => dependent.runId !== runId,
        );
      }
      syncDependencyState(runId);
      return new Response(
        JSON.stringify({
          result: {
            runId,
            dependencyRunIds: detail.dependencies.map((dependency) => dependency.runId),
            changed: true,
          },
        }),
        { status: 200 },
      );
    }

    const clearDependenciesMatch = /\/api\/runs\/([^/]+)\/dependencies\/clear$/.exec(url);
    if (clearDependenciesMatch && init?.method === "POST") {
      const runId = decodeURIComponent(clearDependenciesMatch[1] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const priorDependencyIds = detail.dependencies.map((dependency) => dependency.runId);
      detail.dependencies = [];
      for (const dependencyRunId of priorDependencyIds) {
        const dependencyDetail = state.details[dependencyRunId];
        if (dependencyDetail) {
          dependencyDetail.dependents = dependencyDetail.dependents.filter(
            (dependent) => dependent.runId !== runId,
          );
        }
      }
      syncDependencyState(runId);
      return new Response(
        JSON.stringify({
          result: {
            runId,
            dependencyRunIds: [],
            changed: priorDependencyIds.length > 0,
          },
        }),
        { status: 200 },
      );
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

function findEventSource(urlSuffix: string) {
  const instance = MockEventSource.instances.find((candidate) => candidate.url.endsWith(urlSuffix));
  if (!instance) {
    throw new Error(`expected EventSource for ${urlSuffix}`);
  }
  return instance;
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getCloseDetailButton() {
  const closeButtons = screen.getAllByRole("button", { name: /close detail/i });
  const closeButton = closeButtons[0];
  if (!closeButton) {
    throw new Error("expected a close-detail button");
  }
  return closeButton;
}

function getBoardColumn(name: string) {
  const headingName = new RegExp(`^${escapeRegExp(name)}(?: \\(\\d+\\))?$`);
  const column = screen.getByRole("heading", { name: headingName }).closest("article");
  if (!column) {
    throw new Error(`expected board column ${name}`);
  }
  return column as HTMLElement;
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
    expect(screen.getAllByText("Build UI").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Repo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /copy run id/i })).toBeInTheDocument();
  });

  it("renders attempt history in the attempts tab and merges live output by cursor", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 3,
          attempts: [
            {
              attempt: 1,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "Initial prompt",
              transcript: "Attempt one output\n",
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
              prompt: "## Continue working",
              transcript: "Streaming",
              notices: "\n\n- warning\n",
              exitCode: null,
              timedOut: false,
              live: true,
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();

    expect(screen.getByRole("button", { name: "Attempts" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "2" })).toBeInTheDocument();
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();

    const output = await screen.findByRole("region", { name: "Attempt output" });
    expect(output).toHaveTextContent("Streaming");
    expect(within(output).getByText("warning")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Prompt" }));
    const prompt = screen.getByRole("region", { name: "Attempt prompt" });
    expect(
      within(prompt).getByRole("heading", { level: 2, name: "Continue working" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Output" }));
    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 4,
      event: {
        type: "agent_message_delta",
        text: " live",
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Attempt output" })).toHaveTextContent(
        "Streaming live warning",
      );
    });
  });

  it("separates transcript and backend notices instead of gluing them together", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attempt: 1,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "Prompt",
              transcript: "nullable access:",
              notices: "Good - assignment is indeed nullable on RunDetail.\n\nNow the next note.",
              exitCode: 0,
              timedOut: false,
              live: false,
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();

    const output = await screen.findByRole("region", { name: "Attempt output" });
    expect(output).not.toHaveTextContent("nullable access:Good");
    expect(within(output).getByText("nullable access:")).toBeInTheDocument();
    expect(
      within(output).getByText("Good - assignment is indeed nullable on RunDetail."),
    ).toBeInTheDocument();
    expect(within(output).getByText("Now the next note.")).toBeInTheDocument();
  });

  it("reloads timeline history after a cursor gap instead of merging heuristically", async () => {
    const timelineHistory = {
      runId: "run-1",
      lastCursor: 1,
      attempts: [
        {
          attempt: 1,
          sessionIndex: 0,
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: null,
          prompt: "Initial prompt",
          transcript: "Before gap",
          notices: "",
          exitCode: null,
          timedOut: false,
          live: true,
        },
      ],
    } satisfies RunTimelineHistory;

    const fetchMock = installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
        timelineHistories: {
          "run-1": timelineHistory,
        },
      },
      {
        handleRequest: async (url) => {
          if (url.endsWith("/api/runs/run-1/timeline")) {
            return new Response(JSON.stringify({ history: timelineHistory }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();

    expect(await screen.findByRole("region", { name: "Attempt output" })).toHaveTextContent(
      "Before gap",
    );

    const initialAttempt = timelineHistory.attempts[0];
    if (!initialAttempt) {
      throw new Error("expected initial timeline attempt");
    }
    timelineHistory.lastCursor = 3;
    timelineHistory.attempts = [
      {
        ...initialAttempt,
        transcript: "After reload",
      },
    ];
    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 3,
      event: {
        type: "agent_message_delta",
        text: " skipped",
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Attempt output" })).toHaveTextContent(
        "After reload",
      );
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/runs/run-1/timeline"))
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("groups the board by effective status instead of canonical lifecycle status", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "passive-active",
          assignmentName: "Passive active run",
          backend: "passive",
          status: "initialized",
          effectiveStatus: "running",
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: false,
            taskMutation: {
              canAdd: true,
              canEditNotes: true,
              canSetStatus: true,
            },
          },
        }),
      ],
      details: {
        "passive-active": makeDetail({
          runId: "passive-active",
          assignment: {
            name: "Passive active run",
            sourcePath: "/tmp/a.md",
            workspacePath: "/tmp/b.md",
          },
          backend: "passive",
          status: "initialized",
          effectiveStatus: "running",
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: false,
            taskMutation: {
              canAdd: true,
              canEditNotes: true,
              canSetStatus: true,
            },
          },
        }),
      },
    });

    await renderApp();
    await findRunCard("Passive active run");

    const runningColumn = getBoardColumn("Running");

    expect(
      within(runningColumn).getByRole("button", { name: /passive active run/i }),
    ).toBeInTheDocument();
    expect(within(runningColumn).getByText("running", { selector: ".badge" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Pending(?: \(\d+\))?$/ }),
    ).not.toBeInTheDocument();
  });

  it("shows effective status as primary detail status and canonical lifecycle as secondary metadata", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "passive-active",
          assignmentName: "Passive active run",
          backend: "passive",
          status: "initialized",
          effectiveStatus: "running",
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: false,
            taskMutation: {
              canAdd: true,
              canEditNotes: true,
              canSetStatus: true,
            },
          },
        }),
      ],
      details: {
        "passive-active": makeDetail({
          runId: "passive-active",
          assignment: {
            name: "Passive active run",
            sourcePath: "/tmp/a.md",
            workspacePath: "/tmp/b.md",
          },
          backend: "passive",
          status: "initialized",
          effectiveStatus: "running",
          isLive: true,
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: false,
            taskMutation: {
              canAdd: true,
              canEditNotes: true,
              canSetStatus: true,
            },
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Passive active run"));

    const detail = await screen.findByLabelText("Run detail");
    expect(within(detail).getAllByText("running", { selector: ".badge" }).length).toBeGreaterThan(
      0,
    );
    expect(within(detail).getByText("Lifecycle status")).toBeInTheDocument();
    expect(within(detail).getByText("initialized")).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
  });

  it("shows dependency and attachment indicators on run cards", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-with-indicators",
          name: "Indicator run",
          assignmentName: "Indicator run",
          attachmentCount: 2,
          dependencyState: {
            ready: false,
            total: 3,
            satisfied: 1,
            unsatisfied: 2,
          },
        }),
      ],
      details: {
        "run-with-indicators": makeDetail({
          runId: "run-with-indicators",
          name: "Indicator run",
          assignment: {
            name: "Indicator run",
            sourcePath: "/tmp/indicator-source.md",
            workspacePath: "/tmp/indicator-workspace.md",
          },
        }),
      },
    });

    await renderApp();

    const card = await findRunCard("Indicator run");
    expect(within(card).getByLabelText("1 of 3 dependencies satisfied")).toBeInTheDocument();
    expect(within(card).getByText("1/3")).toBeInTheDocument();
    expect(within(card).getByLabelText("2 attachments")).toBeInTheDocument();
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

    await user.click(getCloseDetailButton());
    await user.clear(screen.getByPlaceholderText("Search runs"));
    await user.type(screen.getByPlaceholderText("Search runs"), "search-only");

    expect(await screen.findByRole("button", { name: /search-only name/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unnamed/i })).not.toBeInTheDocument();
  });

  it("truncates long run names on cards while preserving the full hover title", async () => {
    const longName = "plan feature · /home/kevin/worktrees/task-runner-run-names";
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-long-name",
          assignmentName: "plan-feature",
          name: longName,
        }),
      ],
      details: {
        "run-long-name": makeDetail({
          runId: "run-long-name",
          name: longName,
          assignment: {
            name: "plan-feature",
            sourcePath: "/tmp/assignment.md",
            workspacePath: "/tmp/task-runner/assignment.md",
          },
        }),
      },
    });

    await renderApp();

    const card = await screen.findByRole("button", { name: /plan feature/i });
    const title = card.querySelector(".card-title");
    expect(title).not.toBeNull();
    expect(card).toHaveAttribute("title", longName);
    expect(title).toHaveTextContent("plan feature · /home/kevin/worktrees/task...");
    expect(card).not.toHaveTextContent(longName);
  });

  it("renames a run from the detail drawer title editor", async () => {
    const state = {
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    };
    const fetchMock = installFetchMock(state);

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Build dashboard"));
    expect(await screen.findByRole("heading", { name: "Build dashboard" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /edit run name/i }));
    const input = screen.getByRole("textbox", { name: /run name/i });
    await user.clear(input);
    await user.type(input, "Dashboard polish");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Dashboard polish" })).toBeInTheDocument(),
    );
    expect(await findRunCard("Dashboard polish")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/name",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Dashboard polish" }),
      }),
    );
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
    expect(getBoardColumn("Failed")).toBeInTheDocument();
    expect(getBoardColumn("Blocked")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Aborted(?: \(\d+\))?$/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show archived runs/i }));
    await user.click(screen.getByRole("button", { name: /hide empty columns/i }));
    await user.click(screen.getByRole("button", { name: /collapse failure states/i }));
    expect(await screen.findByRole("button", { name: /archived dashboard/i })).toBeInTheDocument();
    expect(getBoardColumn("Blocked")).toBeInTheDocument();
    expect(getBoardColumn("Error")).toBeInTheDocument();
    expect(getBoardColumn("Aborted")).toBeInTheDocument();

    const blockedColumn = getBoardColumn("Blocked");
    await user.click(
      within(blockedColumn).getByRole("button", { name: "Collapse Blocked column" }),
    );
    await waitFor(() => {
      expect(blockedColumn).toHaveAttribute("data-collapsed", "true");
    });

    const stored = window.localStorage.getItem("task-runner:web:board-settings");
    const parsed = stored ? (JSON.parse(stored) as { collapsedColumnKeys?: string[] }) : null;
    expect(parsed?.collapsedColumnKeys).toEqual(["blocked"]);

    view.unmount();
    queryClient.clear();
    await renderApp();
    expect(await screen.findByRole("button", { name: /archived dashboard/i })).toBeInTheDocument();
    expect(getBoardColumn("Blocked")).toHaveAttribute("data-collapsed", "true");
    expect(getBoardColumn("Error")).toBeInTheDocument();
    expect(getBoardColumn("Aborted")).toBeInTheDocument();
  });

  it("ignores malformed stored board settings values", async () => {
    window.localStorage.setItem(
      "task-runner:web:board-settings",
      JSON.stringify({
        collapseFailureStates: "yes",
        collapsedColumnKeys: ["running", 42],
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
        makeRun({
          runId: "run-error",
          assignmentName: "Broken dashboard",
          status: "error",
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
        "run-error": makeDetail({
          runId: "run-error",
          status: "error",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    expect(screen.queryByRole("button", { name: /archived dashboard/i })).not.toBeInTheDocument();
    expect(getBoardColumn("Failed")).toBeInTheDocument();
    expect(getBoardColumn("Blocked")).toBeInTheDocument();

    await user.click(await findRunCard("Build dashboard"));
    const drawer = await screen.findByLabelText("Run detail");
    expect(drawer.style.getPropertyValue("--drawer-width")).toBe("540px");
    expect(getBoardColumn("Running")).toHaveAttribute("data-collapsed", "false");
  });

  it("collapses and expands a board column on desktop", async () => {
    installFetchMock({
      runs: [
        makeRun(),
        makeRun({
          runId: "run-success",
          assignmentName: "Done dashboard",
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail(),
        "run-success": makeDetail({
          runId: "run-success",
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    const runningColumn = getBoardColumn("Running");
    expect(runningColumn).toHaveAttribute("data-collapsed", "false");
    expect(
      within(runningColumn).getByRole("button", { name: /build dashboard/i }),
    ).toBeInTheDocument();

    await user.click(
      within(runningColumn).getByRole("button", { name: "Collapse Running column" }),
    );

    await waitFor(() => {
      expect(runningColumn).toHaveAttribute("data-collapsed", "true");
    });
    expect(
      within(runningColumn).getByRole("button", { name: "Expand Running column" }),
    ).toBeInTheDocument();
    expect(runningColumn.querySelector(".col-collapsed-count")).toHaveTextContent("1");

    await user.click(runningColumn);

    await waitFor(() => {
      expect(runningColumn).toHaveAttribute("data-collapsed", "false");
    });
    expect(
      within(runningColumn).getByRole("button", { name: "Collapse Running column" }),
    ).toBeInTheDocument();
    expect(
      within(runningColumn).getByRole("button", { name: /build dashboard/i }),
    ).toBeInTheDocument();
  });

  it("keeps grouped failures collapse state independent from split error columns", async () => {
    installFetchMock({
      runs: [
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
      ],
      details: {
        "run-blocked": makeDetail({
          runId: "run-blocked",
          status: "blocked",
        }),
        "run-error": makeDetail({
          runId: "run-error",
          status: "error",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Blocked dashboard");

    const failuresColumn = getBoardColumn("Failed");
    await user.click(
      within(failuresColumn).getByRole("button", { name: "Collapse Failed column" }),
    );

    await waitFor(() => {
      expect(failuresColumn).toHaveAttribute("data-collapsed", "true");
    });

    const storedGrouped = window.localStorage.getItem("task-runner:web:board-settings");
    expect(storedGrouped ? JSON.parse(storedGrouped) : null).toMatchObject({
      collapsedColumnKeys: ["failures"],
    });

    await user.click(screen.getByRole("button", { name: /collapse failure states/i }));

    await waitFor(() => {
      expect(getBoardColumn("Error")).toBeInTheDocument();
    });
    expect(getBoardColumn("Error")).toHaveAttribute("data-collapsed", "false");

    await user.click(screen.getByRole("button", { name: /collapse failure states/i }));

    await waitFor(() => {
      expect(getBoardColumn("Failed")).toHaveAttribute("data-collapsed", "true");
    });
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
        { key: "blocked", left: 400, width: 180 },
      ],
      scrollTo,
      scrollWidth: 620,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Running (1)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Completed (1)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Blocked (1)" })).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Pending (0)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aborted (0)" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Blocked (1)" }));

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", left: 360 });
  });

  it("expands a collapsed jumpbar target before scrolling it into view", async () => {
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

    const frameQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback: FrameRequestCallback) => {
        frameQueue.push(callback);
        return frameQueue.length;
      },
    );
    const flushAnimationFrames = () => {
      const callbacks = frameQueue.splice(0, frameQueue.length);
      callbacks.forEach((callback) => callback(0));
    };

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    const scrollTo = vi.fn();
    setBoardGeometry({
      clientWidth: 260,
      columns: [
        { key: "running", left: 0, width: 180 },
        { key: "completed", left: 200, width: 180 },
        { key: "blocked", left: 400, width: 180 },
      ],
      scrollTo,
      scrollWidth: 620,
    });
    flushAnimationFrames();

    const blockedColumn = getBoardColumn("Blocked");
    await user.click(
      within(blockedColumn).getByRole("button", { name: "Collapse Blocked column" }),
    );
    await waitFor(() => {
      expect(blockedColumn).toHaveAttribute("data-collapsed", "true");
    });

    setBoardGeometry({
      clientWidth: 260,
      columns: [
        { key: "running", left: 0, width: 180 },
        { key: "completed", left: 200, width: 180 },
        { key: "blocked", left: 400, width: 56 },
      ],
      scrollTo,
      scrollWidth: 496,
    });
    flushAnimationFrames();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Blocked (1)" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Blocked (1)" }));
    expect(scrollTo).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(blockedColumn).toHaveAttribute("data-collapsed", "false");
    });

    setBoardGeometry({
      clientWidth: 260,
      columns: [
        { key: "running", left: 0, width: 180 },
        { key: "completed", left: 200, width: 180 },
        { key: "blocked", left: 400, width: 180 },
      ],
      scrollTo,
      scrollWidth: 620,
    });
    flushAnimationFrames();

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
        { key: "blocked", left: 400, width: 180 },
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

  it("opens a resume dialog and does not send a request when cancelled", async () => {
    const fetchMock = installFetchMock({
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
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Resumable run");
    await user.click(await findRunCard("Resumable run"));
    await user.click(await screen.findByRole("button", { name: "Resume" }));

    expect(await screen.findByRole("dialog", { name: "Resume run" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/runs/resumable/resume",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the drawer open when Escape closes the resume dialog", async () => {
    installFetchMock({
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
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Resumable run");
    await user.click(await findRunCard("Resumable run"));
    await user.click(await screen.findByRole("button", { name: "Resume" }));

    expect(await screen.findByRole("dialog", { name: "Resume run" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("requires a resume message before enabling send", async () => {
    installFetchMock({
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
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Resumable run");
    await user.click(await findRunCard("Resumable run"));
    await user.click(await screen.findByRole("button", { name: "Resume" }));

    const sendButton = await screen.findByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();
    expect(
      screen.getByText("Send a follow-up message describing what the run should do next."),
    ).toBeInTheDocument();

    await user.type(await screen.findByLabelText("Message"), "Pick up the failing tests.");

    await waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
  });

  it("sends the resume message from the dialog", async () => {
    let resumeBody: { overrides?: { message?: string } } | undefined;
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
        handleRequest: async (url, init) => {
          if (url.endsWith("/api/runs/resumable/resume")) {
            resumeBody =
              typeof init?.body === "string"
                ? (JSON.parse(init.body) as { overrides?: { message?: string } })
                : undefined;
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Resumable run");
    await user.click(await findRunCard("Resumable run"));
    await user.click(await screen.findByRole("button", { name: "Resume" }));
    await user.type(
      await screen.findByLabelText("Message"),
      "Continue with the failing web tests first.",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(resumeBody).toEqual({
        overrides: {
          message: "Continue with the failing web tests first.",
        },
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
  });

  it("updates the selected run actions from summary SSE state changes", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-1",
          status: "running",
          capabilities: {
            canResume: false,
            canAbort: true,
            abortReason: undefined,
          },
        }),
      ],
      details: {
        "run-1": makeDetail({
          status: "running",
          capabilities: {
            canResume: false,
            canAbort: true,
            abortReason: undefined,
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    expect(await screen.findByRole("button", { name: "Abort" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();

    findEventSource("/api/events/run-summaries").emitMessage({
      type: "summary_upsert",
      summary: makeRun({
        runId: "run-1",
        status: "success",
        endedAt: "2026-04-13T05:10:00.000Z",
        activeTask: null,
        capabilities: {
          canResume: true,
          canAbort: false,
        },
      }),
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    });
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

  it("shows Abort only when capability says the run can be aborted", async () => {
    installFetchMock({
      runs: [makeRun({ capabilities: { canAbort: true, abortReason: undefined } })],
      details: {
        "run-1": makeDetail({ capabilities: { canAbort: true, abortReason: undefined } }),
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
    source.emitMessage({ type: "summary_upsert", summary: state.runs[0] });

    expect(await screen.findByRole("button", { name: /updated from sse/i })).toBeInTheDocument();

    state.runs = [makeRun({ assignmentName: "Recovered after stale" })];
    source.emitError();

    expect(await screen.findByText(/live updates are temporarily stale/i)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /refetch now/i }));
    expect(
      await screen.findByRole("button", { name: /recovered after stale/i }),
    ).toBeInTheDocument();
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
    expect(screen.getByText(/live updates are temporarily stale/i)).toBeInTheDocument();
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
    source.emitMessage({ type: "summary_upsert", summary: {} });

    expect(await screen.findByText(/live updates are temporarily stale/i)).toBeInTheDocument();
  });

  it("applies summary SSE upserts without forcing an HTTP refetch", async () => {
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
      type: "summary_upsert",
      summary: makeRun({ assignmentName: "Updated without refetch" }),
    });

    expect(
      await screen.findByRole("button", { name: /updated without refetch/i }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore);
  });

  it("syncs the selected run card from the fresher detail fetch", async () => {
    installFetchMock({
      runs: [
        makeRun({
          tasksCompleted: 11,
          tasksTotal: 14,
          activeTask: { id: "draft", title: "Draft review notes" },
        }),
      ],
      details: {
        "run-1": makeDetail({
          tasksCompleted: 12,
          tasksTotal: 14,
          activeTask: { id: "apply", title: "Apply review fixes" },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    expect((await findRunCard("Build dashboard")).textContent).toContain("11 / 14");
    expect((await findRunCard("Build dashboard")).textContent).toContain("Draft review notes");

    await user.click(await findRunCard("Build dashboard"));

    await waitFor(async () => {
      const card = await findRunCard("Build dashboard");
      expect(card).toHaveAttribute("aria-pressed", "true");
      expect(card.textContent).toContain("12 / 14");
      expect(card.textContent).toContain("Apply review fixes");
    });
  });

  it("syncs the selected run card from detail SSE updates", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail(),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Build dashboard"));

    const detailSource = findEventSource("/api/runs/run-1/events/detail");
    detailSource.emitOpen();
    detailSource.emitMessage({
      type: "detail_updated",
      detail: makeDetail({
        tasksCompleted: 2,
        tasksTotal: 4,
        activeTask: { id: "ship", title: "Ship the change" },
      }),
    });

    await waitFor(async () => {
      const card = await findRunCard("Build dashboard");
      expect(card.textContent).toContain("2 / 4");
      expect(card.textContent).toContain("Ship the change");
    });
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
    expect(MockEventSource.instances).toHaveLength(3);

    await user.click(getCloseDetailButton());
    await user.click(await findRunCard("Second run"));

    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(MockEventSource.instances).toHaveLength(5);
  });

  it("searches dependency candidates by assignment name and submits the selected run id", async () => {
    const postedDependencyIds: string[] = [];
    installFetchMock(
      {
        runs: [
          makeRun({
            runId: "run-1",
            status: "initialized",
            assignmentName: "Current assignment",
            name: "Current run",
          }),
          makeRun({
            runId: "run-2",
            assignmentName: "Plan feature follow-up",
            name: "Dependency target",
          }),
        ],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            status: "initialized",
            effectiveStatus: "initialized",
            assignment: {
              name: "Current assignment",
              sourcePath: "/tmp/current.md",
              workspacePath: "/tmp/current-workspace.md",
            },
            name: "Current run",
          }),
          "run-2": makeDetail({
            runId: "run-2",
            assignment: {
              name: "Plan feature follow-up",
              sourcePath: "/tmp/dependency.md",
              workspacePath: "/tmp/dependency-workspace.md",
            },
            name: "Dependency target",
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (/\/api\/runs\/run-1\/dependencies$/.test(url) && init?.method === "POST") {
            const body =
              typeof init.body === "string" && init.body.length > 0
                ? (JSON.parse(init.body) as { dependencyRunId?: string })
                : {};
            if (body.dependencyRunId) {
              postedDependencyIds.push(body.dependencyRunId);
            }
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Current run"));
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Dependencies\b/i }));
    await user.type(screen.getByLabelText("Dependency run search"), "follow-up");
    await user.click(
      await screen.findByRole("button", {
        name: /dependency target.*plan feature follow-up.*run-2/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: /add dependency/i }));

    await waitFor(() => expect(postedDependencyIds).toEqual(["run-2"]));
    expect(
      await screen.findByRole("button", { name: /remove dependency run-2/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("run-2", { selector: ".dependency-meta-id" })).toBeInTheDocument();
    expect(screen.getAllByText("running", { selector: ".badge" }).length).toBeGreaterThan(0);
  });

  it("uploads, downloads, and removes attachments from the detail drawer", async () => {
    installFetchMock({
      runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
      details: {
        "run-1": makeDetail({
          runId: "run-1",
          name: "Attachment run",
          attachments: [],
        }),
      },
    });
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));

    await user.upload(
      screen.getByLabelText("Upload attachment file"),
      new File(["hello"], "notes.md", { type: "text/markdown" }),
    );

    expect(await screen.findByText("notes.md")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Download notes\.md$/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(anchorClick).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^Remove notes\.md$/ }));
    await waitFor(() => expect(screen.getByText("No attachments yet.")).toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalled();

    anchorClick.mockRestore();
  });
});
