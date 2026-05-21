import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunAttachment } from "@kcosr/agent-runner-core/contracts/attachments.js";
import type {
  RunAuditHistory,
  RunTimelineHistory,
} from "@kcosr/agent-runner-core/contracts/events.js";
import type { RunInputSurface } from "@kcosr/agent-runner-core/contracts/run-input-surface.js";
import type {
  QueuedResumeMessage,
  RunDetail,
  RunSessionSummary,
  RunSummary,
} from "@kcosr/agent-runner-core/contracts/runs.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { DAEMON_TOKEN_STORAGE_KEY } from "./lib/daemon-token.js";
import { queryClient, runQueryKeys } from "./lib/query.js";
import { runBelongsInListCache } from "./lib/run-list-cache.js";
import { PREFERENCES_STORAGE_KEY } from "./lib/settings.js";
import { router } from "./router.js";
import attachmentMermaidMarkdown from "./test/fixtures/attachment-mermaid.md?raw";

const initializeMermaid = vi.fn();
const renderMermaid = vi.fn(async () => ({
  svg: "<svg><text>attachment diagram</text></svg>",
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMermaid,
    render: renderMermaid,
  },
}));

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");

  type MockCodeViewItem = {
    collapsed?: boolean;
    fileDiff?: { name?: string };
    id: string;
    version?: number;
  };

  const CodeView = React.forwardRef<
    unknown,
    {
      className?: string;
      items?: readonly MockCodeViewItem[];
      options?: { diffStyle?: "unified" | "split" };
      onSelectedLinesChange?: (
        selection: {
          id: string;
          range: { end: number; endSide: "additions"; side: "additions"; start: number };
        } | null,
      ) => void;
      renderHeaderPrefix?: (item: MockCodeViewItem) => React.ReactNode;
    }
  >(function MockCodeView(
    { className, items = [], onSelectedLinesChange, options, renderHeaderPrefix },
    ref,
  ) {
    React.useImperativeHandle(ref, () => ({
      clearSelectedLines: () => {},
      getInstance: () => undefined,
      getItem: (id: string) => items.find((item) => item.id === id),
      getSelectedLines: () => null,
      scrollTo: () => {},
      setSelectedLines: () => {},
      updateItem: () => false,
      updateItemId: () => false,
    }));

    return (
      <div
        aria-label="Code diff"
        className={className}
        data-diff-style={options?.diffStyle ?? "unified"}
        data-code-view-version={items[0]?.version ?? 0}
      >
        {items.map((item) => {
          const name = item.fileDiff?.name ?? item.id;
          return (
            <div data-collapsed={item.collapsed ? "true" : "false"} key={item.id}>
              {renderHeaderPrefix?.(item)}
              <span>{name}</span>
              <button
                onClick={() =>
                  onSelectedLinesChange?.({
                    id: item.id,
                    range: { start: 2, end: 2, side: "additions", endSide: "additions" },
                  })
                }
                type="button"
              >
                Select diff line for {name}
              </button>
            </div>
          );
        })}
      </div>
    );
  });

  return { CodeView };
});

vi.mock("@pierre/trees/react", () => ({
  FileTree: () => null,
  useFileTree: () => ({
    model: {
      getItem: () => ({ select: () => {} }),
      resetPaths: () => {},
      scrollToPath: () => {},
      setGitStatus: () => {},
    },
  }),
  useFileTreeSearch: () => ({
    close: () => {},
    isOpen: false,
    open: () => {},
    setValue: () => {},
    value: "",
  }),
  useFileTreeSelection: () => [],
}));

const APP_CONFIG = {
  apiBasePath: "/api",
  webBasePath: "/",
  runSummaryEventsPath: "/api/events/run-summaries",
};

const DEFAULT_DASHBOARD_PREFERENCES = {
  hideEmptyColumns: true,
  collapseFailureStates: true,
  showArchived: false,
  showNotesOnly: false,
  showScheduledOnly: false,
  showPinnedOnly: false,
  sortField: "startedAt",
  sortDirection: "desc",
  auditNewestFirst: false,
  visibleFocusIndicators: false,
  themeMode: "auto",
  structuredFilters: {
    repo: null,
    agent: null,
    backend: null,
    runGroupId: null,
  },
};

const DEFAULT_DASHBOARD_VIEW_STATE: {
  viewMode: "board" | "list";
  collapsedColumnKeys: string[];
  drawerWidth: number;
  activeRightSurface: "attachments" | "chat" | "detail" | "diffs" | "files" | "notes" | "tasks";
  drawerFullscreen: boolean;
  diffsSidebarWidth: number;
  filesSidebarWidth: number;
  diffsViewMode: "unified" | "split";
} = {
  viewMode: "board",
  collapsedColumnKeys: [],
  drawerWidth: 540,
  activeRightSurface: "detail",
  drawerFullscreen: false,
  diffsSidebarWidth: 272,
  filesSidebarWidth: 240,
  diffsViewMode: "unified",
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

class MockResizeObserver {
  disconnect() {}

  observe() {}

  unobserve() {}
}

function setStoredDashboardPreferences(overrides: Partial<typeof DEFAULT_DASHBOARD_PREFERENCES>) {
  window.localStorage.setItem(
    "agent-runner:web:dashboard-preferences",
    JSON.stringify({
      ...DEFAULT_DASHBOARD_PREFERENCES,
      ...overrides,
    }),
  );
}

function setStoredDashboardViewState(overrides: Partial<typeof DEFAULT_DASHBOARD_VIEW_STATE>) {
  window.localStorage.setItem(
    "agent-runner:web:dashboard-view-state",
    JSON.stringify({
      ...DEFAULT_DASHBOARD_VIEW_STATE,
      ...overrides,
    }),
  );
}

function requestHeader(init: RequestInit | undefined, key: string): string | null {
  return new Headers(init?.headers).get(key);
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
    parentRunId: null,
    runGroupId: "run-1",
    repo: "agent-runner",
    status: "running",
    effectiveStatus: "running",
    archivedAt: null,
    pinned: false,
    notePresent: false,
    agentName: "implementer",
    assignmentName: "Build dashboard",
    backend: "codex",
    model: "gpt-5.4",
    name: "Build dashboard",
    cwd: "/tmp/agent-runner",
    startedAt: "2026-04-13T05:00:00.000Z",
    updatedAt: "2026-04-13T05:00:00.000Z",
    endedAt: null,
    totalAttemptCount: 1,
    totalSessionCount: 1,
    maxAttemptsPerSession: 3,
    currentSession: {
      sessionIndex: 0,
      status: "running",
      startedAt: "2026-04-13T05:00:00.000Z",
      endedAt: null,
      exitCode: null,
      message: null,
      firstAttemptNumber: 1,
      lastAttemptNumber: 1,
      attemptCount: 1,
      maxAttemptsPerSession: 3,
      backendSessionIdAtStart: "thread-1",
      backendSessionIdAtEnd: null,
    },
    lastSession: {
      sessionIndex: 0,
      status: "running",
      startedAt: "2026-04-13T05:00:00.000Z",
      endedAt: null,
      exitCode: null,
      message: null,
      firstAttemptNumber: 1,
      lastAttemptNumber: 1,
      attemptCount: 1,
      maxAttemptsPerSession: 3,
      backendSessionIdAtStart: "thread-1",
      backendSessionIdAtEnd: null,
    },
    tasksCompleted: 1,
    tasksTotal: 4,
    attachmentCount: 0,
    queuedResumeMessageCount: 0,
    dependencyState: {
      ready: true,
      total: 0,
      satisfied: 0,
      unsatisfied: 0,
    },
    schedule: null,
    scheduleState: "none",
    activeTask: {
      id: "build",
      title: "Build UI",
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
      canReconfigure: false,
      taskMutation: {
        canAdd: false,
        canEditPending: false,
        canDeletePending: false,
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
  if (overrides.runGroupId === undefined && overrides.runId !== undefined) {
    run.runGroupId = overrides.runId;
  }
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
    parentRunId: null,
    runGroupId: "run-1",
    repo: "agent-runner",
    status: "running",
    effectiveStatus: "running",
    archivedAt: null,
    note: null,
    pinned: false,
    isLive: true,
    workspaceDir: "/tmp/agent-runner/.state/run-1",
    agent: {
      name: "implementer",
      sourcePath: null,
    },
    assignment: {
      name: "Build dashboard",
      sourcePath: "/tmp/assignment.md",
    },
    backend: "codex",
    model: "gpt-5.4",
    effort: "high",
    name: "Build dashboard",
    backendSessionId: "thread-1",
    cwd: "/tmp/agent-runner",
    unrestricted: false,
    timeoutSec: 3600,
    startedAt: "2026-04-13T05:00:00.000Z",
    updatedAt: "2026-04-13T05:00:00.000Z",
    endedAt: null,
    exitCode: null,
    totalAttemptCount: 1,
    totalSessionCount: 1,
    maxAttemptsPerSession: 3,
    sessions: [
      {
        sessionIndex: 0,
        status: "running",
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: null,
        exitCode: null,
        message: null,
        firstAttemptNumber: 1,
        lastAttemptNumber: 1,
        attemptCount: 1,
        maxAttemptsPerSession: 3,
        backendSessionIdAtStart: "thread-1",
        backendSessionIdAtEnd: null,
      },
    ],
    currentSession: {
      sessionIndex: 0,
      status: "running",
      startedAt: "2026-04-13T05:00:00.000Z",
      endedAt: null,
      exitCode: null,
      message: null,
      firstAttemptNumber: 1,
      lastAttemptNumber: 1,
      attemptCount: 1,
      maxAttemptsPerSession: 3,
      backendSessionIdAtStart: "thread-1",
      backendSessionIdAtEnd: null,
    },
    lastSession: {
      sessionIndex: 0,
      status: "running",
      startedAt: "2026-04-13T05:00:00.000Z",
      endedAt: null,
      exitCode: null,
      message: null,
      firstAttemptNumber: 1,
      lastAttemptNumber: 1,
      attemptCount: 1,
      maxAttemptsPerSession: 3,
      backendSessionIdAtStart: "thread-1",
      backendSessionIdAtEnd: null,
    },
    tasksCompleted: 1,
    tasksTotal: 4,
    attachments: [],
    queuedResumeMessages: [],
    dependencies: [],
    dependents: [],
    schedule: null,
    scheduleState: "none",
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
    pendingPrompt: null,
    callerInstructions: null,
    lockedFields: ["tasks"],
    runtimeVars: {},
    capabilities: {
      canArchive: false,
      canUnarchive: false,
      canReset: true,
      canDelete: false,
      canReady: false,
      canResume: true,
      canAbort: false,
      abortReason: "not_active_in_daemon",
      canReconfigure: false,
      taskMutation: {
        canAdd: false,
        canEditPending: false,
        canDeletePending: false,
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
    executionEnvironment: null,
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
  if (overrides.runGroupId === undefined && overrides.runId !== undefined) {
    detail.runGroupId = overrides.runId;
  }
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

function makeAttachment(
  overrides: Partial<RunAttachment> & Pick<RunAttachment, "id" | "name">,
): RunAttachment {
  return {
    id: overrides.id,
    name: overrides.name,
    mimeType: overrides.mimeType ?? "text/plain; charset=utf-8",
    size: overrides.size ?? 24,
    sha256: overrides.sha256 ?? "abc123",
    addedAt: overrides.addedAt ?? "2026-04-14T06:00:00.000Z",
    relativePath: overrides.relativePath ?? `attachments/${overrides.id}/${overrides.name}`,
  };
}

function makeDefinitionList(kind: "agent" | "assignment", names: string[]) {
  return {
    kind,
    entries: names.map((name) => ({
      name,
      path: null,
      root: "builtin",
    })),
    warnings: [],
  };
}

function makeRunInputSurface(overrides: Partial<RunInputSurface> = {}): RunInputSurface {
  return {
    runSettings: [
      {
        key: "cwd",
        label: "Working Directory",
        description: "Working directory for the run.",
        section: "context",
        inputKind: "string",
        valueStatus: "concrete",
        value: "/tmp/agent-runner",
        editable: false,
        locked: true,
        hiddenWhenUnset: false,
        source: "assignment",
      },
      {
        key: "message",
        label: "Message",
        description: "Default worker ask supplied to the run.",
        section: "execution",
        inputKind: "textarea",
        valueStatus: "unset",
        value: null,
        editable: true,
        locked: false,
        hiddenWhenUnset: false,
        source: "available_override",
      },
      {
        key: "name",
        label: "Name",
        description: "Optional run name.",
        section: "context",
        inputKind: "string",
        valueStatus: "unset",
        value: null,
        editable: true,
        locked: false,
        hiddenWhenUnset: false,
        source: "available_override",
      },
      {
        key: "backend",
        label: "Backend",
        description: "Execution backend.",
        section: "execution",
        inputKind: "enum",
        valueStatus: "concrete",
        value: "codex",
        editable: false,
        locked: true,
        hiddenWhenUnset: false,
        source: "agent",
        required: true,
        enumValues: ["codex", "claude"],
      },
      {
        key: "launcher",
        label: "Launcher",
        description: "Subprocess launcher override for supported backends.",
        section: "execution",
        inputKind: "launcher",
        valueStatus: "unset",
        value: null,
        editable: true,
        locked: false,
        hiddenWhenUnset: false,
        source: "available_override",
      },
      {
        key: "model",
        label: "Model",
        description: "Backend model override.",
        section: "execution",
        inputKind: "model",
        valueStatus: "delegated",
        value: null,
        editable: true,
        locked: false,
        hiddenWhenUnset: false,
        source: "available_override",
      },
    ],
    assignmentInputs: [
      {
        key: "plan",
        label: "Plan",
        description: "Short feature brief.",
        section: "task",
        inputKind: "string",
        valueStatus: "unset",
        value: null,
        editable: true,
        locked: false,
        hiddenWhenUnset: false,
        source: "available_override",
        required: true,
      },
    ],
    ...overrides,
  };
}

function installFetchMock(
  state: {
    runs: RunSummary[];
    details: Record<string, RunDetail>;
    auditHistories?: Record<string, RunAuditHistory>;
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
        type: "run",
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
      type: "run",
      runId: detail.runId,
      name: detail.name,
      status: detail.status,
      effectiveStatus: detail.effectiveStatus,
      archivedAt: detail.archivedAt,
      satisfied: detail.status === "success",
      missing: false,
    };
  }

  function dependentDetailFor(runId: string): RunDetail["dependents"][number] {
    const dependency = dependencyDetailFor(runId);
    return dependency.type === "run"
      ? {
          ...dependency,
          via: "run",
        }
      : {
          type: "run",
          via: "group",
          dependencyGroupId: dependency.groupId,
          runId,
          name: null,
          status: null,
          effectiveStatus: null,
          archivedAt: null,
          satisfied: dependency.satisfied,
          missing: dependency.missing,
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
      run.runId === runId
        ? {
            ...run,
            attachmentCount: detail.attachments.length,
            queuedResumeMessageCount: detail.queuedResumeMessages.length,
          }
        : run,
    );
  }

  function syncScheduleState(detail: RunDetail) {
    detail.scheduleState =
      detail.schedule === null
        ? "none"
        : !detail.schedule.enabled
          ? "paused"
          : new Date(detail.schedule.runAt).getTime() <= Date.now()
            ? "due"
            : "future";
  }

  function syncRunSummary(runId: string) {
    const detail = state.details[runId];
    if (!detail) {
      return;
    }
    state.runs = state.runs.map((run) =>
      run.runId === runId
        ? {
            ...run,
            repo: detail.repo,
            status: detail.status,
            effectiveStatus: detail.effectiveStatus,
            archivedAt: detail.archivedAt,
            pinned: detail.pinned,
            notePresent: detail.note !== null,
            agentName: detail.agent.name,
            name: detail.name,
            assignmentName: detail.assignment?.name ?? null,
            backend: detail.backend,
            model: detail.model,
            cwd: detail.cwd,
            startedAt: detail.startedAt,
            updatedAt: detail.updatedAt,
            endedAt: detail.endedAt,
            totalAttemptCount: detail.totalAttemptCount,
            totalSessionCount: detail.totalSessionCount,
            maxAttemptsPerSession: detail.maxAttemptsPerSession,
            currentSession: detail.currentSession,
            lastSession: detail.lastSession,
            tasksCompleted: detail.tasksCompleted,
            tasksTotal: detail.tasksTotal,
            schedule: detail.schedule,
            scheduleState: detail.scheduleState,
            attachmentCount: detail.attachments.length,
            queuedResumeMessageCount: detail.queuedResumeMessages.length,
            activeTask: detail.activeTask,
            execution: detail.execution,
            capabilities: detail.capabilities,
          }
        : run,
    );
  }

  function syncTaskCounts(runId: string) {
    const detail = state.details[runId];
    if (!detail) {
      return;
    }
    detail.tasksTotal = detail.tasks.length;
    detail.tasksCompleted = detail.tasks.filter((task) => task.status === "completed").length;
    detail.activeTask =
      detail.tasks.find((task) => task.status === "in_progress") ??
      detail.tasks.find((task) => task.status === "pending") ??
      null;
    syncRunSummary(runId);
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

  const UrlConstructor = URL;
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const override = await options?.handleRequest?.(url, init);
    if (override) {
      return override;
    }
    if (url.endsWith("/app-config.json")) {
      return new Response(JSON.stringify({ webBasePath: APP_CONFIG.webBasePath }), { status: 200 });
    }

    const parsedUrl = new UrlConstructor(url, "http://agent-runner.test");
    if (parsedUrl.pathname === "/api/runs" && (!init?.method || init.method === "GET")) {
      const includeArchived = parsedUrl.searchParams.get("includeArchived") === "true";
      const runGroupId = parsedUrl.searchParams.get("runGroupId");
      const runs = state.runs.filter((run) =>
        runBelongsInListCache(run, { includeArchived, runGroupId }),
      );
      return new Response(JSON.stringify({ runs }), { status: 200 });
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
        return new Response(
          JSON.stringify({
            attachments: detail.attachments.map((attachment) => ({
              ...attachment,
              ownerRunId: runId,
            })),
          }),
          { status: 200 },
        );
      }
      if (init.method === "POST") {
        const rawName = headerValue(init.headers, "x-agent-runner-attachment-name");
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

    const createTaskMatch = /\/api\/runs\/([^/]+)\/tasks$/.exec(url);
    if (createTaskMatch && init?.method === "POST") {
      const runId = decodeURIComponent(createTaskMatch[1] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { body?: string; title?: string })
          : {};
      const task = {
        id: `task-${detail.tasks.length + 1}`,
        title: body.title ?? "New task",
        body: body.body ?? "",
        status: "pending" as const,
        notes: "",
      };
      detail.tasks = [...detail.tasks, task];
      syncTaskCounts(runId);
      return new Response(JSON.stringify({ task }), { status: 200 });
    }

    const appendTaskNotesMatch = /\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/append-notes$/.exec(url);
    if (appendTaskNotesMatch && init?.method === "POST") {
      const runId = decodeURIComponent(appendTaskNotesMatch[1] ?? "");
      const taskId = decodeURIComponent(appendTaskNotesMatch[2] ?? "");
      const detail = state.details[runId];
      const task = detail?.tasks.find((entry) => entry.id === taskId);
      if (!detail || !task) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { text?: string })
          : {};
      task.notes = task.notes ? `${task.notes}\n${body.text ?? ""}` : (body.text ?? "");
      syncTaskCounts(runId);
      return new Response(JSON.stringify({ task }), { status: 200 });
    }

    const taskMatch = /\/api\/runs\/([^/]+)\/tasks\/([^/]+)$/.exec(url);
    if (taskMatch && init?.method === "PATCH") {
      const runId = decodeURIComponent(taskMatch[1] ?? "");
      const taskId = decodeURIComponent(taskMatch[2] ?? "");
      const detail = state.details[runId];
      const task = detail?.tasks.find((entry) => entry.id === taskId);
      if (!detail || !task) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as Partial<RunDetail["tasks"][number]>)
          : {};
      if (body.title !== undefined) {
        task.title = body.title;
      }
      if (body.body !== undefined) {
        task.body = body.body;
      }
      if (body.notes !== undefined) {
        task.notes = body.notes;
      }
      if (body.status !== undefined) {
        task.status = body.status;
      }
      syncTaskCounts(runId);
      return new Response(JSON.stringify({ task }), { status: 200 });
    }
    if (taskMatch && init?.method === "DELETE") {
      const runId = decodeURIComponent(taskMatch[1] ?? "");
      const taskId = decodeURIComponent(taskMatch[2] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      detail.tasks = detail.tasks.filter((task) => task.id !== taskId);
      syncTaskCounts(runId);
      return new Response(
        JSON.stringify({
          result: {
            runId,
            taskId,
            deleted: true,
            updatedAt: detail.updatedAt,
          },
        }),
        { status: 200 },
      );
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

    const auditMatch = /\/api\/runs\/([^/]+)\/audit(?:\?.*)?$/.exec(url);
    if (auditMatch && (!init?.method || init.method === "GET")) {
      const runId = decodeURIComponent(auditMatch[1] ?? "");
      if (!state.details[runId]) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const history = state.auditHistories?.[runId] ?? {
        runId,
        events: [],
        lastCursor: 0,
      };
      return new Response(JSON.stringify({ history }), { status: 200 });
    }

    const queuedResumeMessagesMatch = /\/api\/runs\/([^/]+)\/queued-resume-messages$/.exec(url);
    if (queuedResumeMessagesMatch && init?.method === "POST") {
      const runId = decodeURIComponent(queuedResumeMessagesMatch[1] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { message?: string })
          : {};
      const queuedResumeMessage: QueuedResumeMessage = {
        id: `qmsg${detail.queuedResumeMessages.length + 1}`,
        text: body.message ?? "",
        createdAt: "2026-04-30T15:20:00.000Z",
      };
      detail.queuedResumeMessages = [...detail.queuedResumeMessages, queuedResumeMessage];
      syncRunSummary(runId);
      return new Response(JSON.stringify({ run: detail, queuedResumeMessage }), { status: 200 });
    }

    const removeQueuedResumeMessageMatch =
      /\/api\/runs\/([^/]+)\/queued-resume-messages\/([^/]+)$/.exec(url);
    if (removeQueuedResumeMessageMatch && init?.method === "DELETE") {
      const runId = decodeURIComponent(removeQueuedResumeMessageMatch[1] ?? "");
      const messageId = decodeURIComponent(removeQueuedResumeMessageMatch[2] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      detail.queuedResumeMessages = detail.queuedResumeMessages.filter(
        (message) => message.id !== messageId,
      );
      syncRunSummary(runId);
      return new Response(JSON.stringify({ run: detail, removedMessageId: messageId }), {
        status: 200,
      });
    }

    const scheduleToggleMatch = /\/api\/runs\/([^/]+)\/schedule\/(enable|disable)$/.exec(url);
    if (scheduleToggleMatch && init?.method === "POST") {
      const runId = decodeURIComponent(scheduleToggleMatch[1] ?? "");
      const action = scheduleToggleMatch[2];
      const detail = state.details[runId];
      if (!detail?.schedule) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      detail.schedule = {
        ...detail.schedule,
        enabled: action === "enable",
      };
      syncScheduleState(detail);
      syncRunSummary(runId);
      return new Response(JSON.stringify({ run: detail }), { status: 200 });
    }

    const scheduleMatch = /\/api\/runs\/([^/]+)\/schedule$/.exec(url);
    if (scheduleMatch && init?.method === "DELETE") {
      const runId = decodeURIComponent(scheduleMatch[1] ?? "");
      const detail = state.details[runId];
      if (!detail?.schedule) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      detail.schedule = null;
      syncScheduleState(detail);
      syncRunSummary(runId);
      return new Response(JSON.stringify({ run: detail }), { status: 200 });
    }

    const reconfigureMatch = /\/api\/runs\/([^/]+)\/reconfigure$/.exec(url);
    if (reconfigureMatch && init?.method === "POST") {
      const runId = decodeURIComponent(reconfigureMatch[1] ?? "");
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { vars?: Record<string, string>; message?: string })
          : {};
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      if (body.vars !== undefined) {
        detail.runtimeVars = {
          ...detail.runtimeVars,
          ...body.vars,
        };
      }
      if ("message" in body) {
        detail.message = body.message ?? null;
      }
      syncRunSummary(runId);
      return new Response(JSON.stringify({ run: detail }), { status: 200 });
    }

    const archiveMatch = /\/api\/runs\/([^/]+)\/(archive|unarchive|reset|ready|resume|abort)$/.exec(
      url,
    );
    if (archiveMatch) {
      const [, encodedRunId, action] = archiveMatch;
      const runId = decodeURIComponent(encodedRunId ?? "");
      const detail = state.details[runId];
      if (action === "archive") {
        if (!detail) {
          return new Response(
            JSON.stringify({ error: { message: "missing", code: "not_found" } }),
            {
              status: 404,
            },
          );
        }
        detail.archivedAt = "2026-04-13T06:00:00.000Z";
        detail.capabilities = {
          ...detail.capabilities,
          canArchive: false,
          canUnarchive: true,
          canDelete: true,
          canResume: false,
        };
        syncRunSummary(runId);
        return new Response(
          JSON.stringify({
            result: {
              archivedAt: "2026-04-13T06:00:00.000Z",
              changed: true,
              runId,
              status: "success",
              updatedAt: detail.updatedAt,
            },
          }),
          { status: 200 },
        );
      }
      if (action === "unarchive") {
        if (!detail) {
          return new Response(
            JSON.stringify({ error: { message: "missing", code: "not_found" } }),
            {
              status: 404,
            },
          );
        }
        detail.archivedAt = null;
        detail.capabilities = {
          ...detail.capabilities,
          canArchive: true,
          canUnarchive: false,
          canDelete: false,
        };
        syncRunSummary(runId);
        return new Response(
          JSON.stringify({
            result: {
              archivedAt: null,
              changed: true,
              runId,
              status: "success",
              updatedAt: detail.updatedAt,
            },
          }),
          { status: 200 },
        );
      }
      if (action === "reset") {
        if (!detail) {
          return new Response(
            JSON.stringify({ error: { message: "missing", code: "not_found" } }),
            {
              status: 404,
            },
          );
        }
        detail.status = "initialized";
        detail.effectiveStatus = "initialized";
        detail.isLive = false;
        detail.backendSessionId = null;
        detail.totalAttemptCount = 0;
        detail.totalSessionCount = 0;
        detail.sessions = [];
        detail.currentSession = null;
        detail.lastSession = null;
        detail.endedAt = null;
        detail.exitCode = null;
        detail.activeTask = null;
        detail.capabilities = {
          ...detail.capabilities,
          canArchive: true,
          canUnarchive: false,
          canReset: true,
          canDelete: false,
          canReady: true,
          canResume: false,
          canAbort: false,
          abortReason: "not_active_in_daemon",
        };
        syncRunSummary(runId);
        return new Response(JSON.stringify({ run: detail }), { status: 200 });
      }
      if (action === "ready") {
        if (!detail) {
          return new Response(
            JSON.stringify({ error: { message: "missing", code: "not_found" } }),
            {
              status: 404,
            },
          );
        }
        detail.status = "ready";
        detail.effectiveStatus = "ready";
        detail.capabilities = {
          ...detail.capabilities,
          canReady: false,
          canResume: true,
        };
        syncRunSummary(runId);
        return new Response(JSON.stringify({ run: detail }), { status: 200 });
      }
      if (action === "resume") {
        return new Response(JSON.stringify({ runId }), { status: 200 });
      }
      return new Response(JSON.stringify({ accepted: true, runId }), { status: 200 });
    }

    if (runMatch && init?.method === "DELETE") {
      const runId = decodeURIComponent(runMatch[1] ?? "");
      if (!state.details[runId]) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      delete state.details[runId];
      state.runs = state.runs.filter((run) => run.runId !== runId);
      return new Response(JSON.stringify({ result: { runId } }), { status: 200 });
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
      return new Response(
        JSON.stringify({ result: { runId, updatedAt: detail.updatedAt, name, changed } }),
        { status: 200 },
      );
    }

    const noteMatch = /\/api\/runs\/([^/]+)\/note$/.exec(url);
    if (noteMatch && init?.method === "POST") {
      const runId = decodeURIComponent(noteMatch[1] ?? "");
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { note?: string | null })
          : {};
      const note = body.note ?? null;
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const changed = detail.note !== note;
      state.details[runId] = { ...detail, note };
      state.runs = state.runs.map((run) =>
        run.runId === runId ? { ...run, notePresent: note !== null } : run,
      );
      return new Response(
        JSON.stringify({ result: { runId, updatedAt: detail.updatedAt, note, changed } }),
        { status: 200 },
      );
    }

    const pinnedMatch = /\/api\/runs\/([^/]+)\/pinned$/.exec(url);
    if (pinnedMatch && init?.method === "POST") {
      const runId = decodeURIComponent(pinnedMatch[1] ?? "");
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { pinned?: boolean })
          : {};
      const pinned = body.pinned === true;
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const changed = detail.pinned !== pinned;
      state.details[runId] = { ...detail, pinned };
      state.runs = state.runs.map((run) => (run.runId === runId ? { ...run, pinned } : run));
      return new Response(
        JSON.stringify({ result: { runId, updatedAt: detail.updatedAt, pinned, changed } }),
        { status: 200 },
      );
    }

    const backendSessionMatch = /\/api\/runs\/([^/]+)\/backend-session$/.exec(url);
    if (backendSessionMatch && init?.method === "POST") {
      const runId = decodeURIComponent(backendSessionMatch[1] ?? "");
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { backendSessionId?: string })
          : {};
      const backendSessionId = body.backendSessionId?.trim() ?? "";
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      if (backendSessionId.length === 0) {
        return new Response(JSON.stringify({ error: { message: "invalid", code: "invalid" } }), {
          status: 400,
        });
      }
      const changed = detail.backendSessionId !== backendSessionId;
      state.details[runId] = { ...detail, backendSessionId };
      return new Response(
        JSON.stringify({
          result: { runId, updatedAt: detail.updatedAt, backendSessionId, changed },
        }),
        { status: 200 },
      );
    }

    const clearBackendSessionMatch = /\/api\/runs\/([^/]+)\/backend-session\/clear$/.exec(url);
    if (clearBackendSessionMatch && init?.method === "POST") {
      const runId = decodeURIComponent(clearBackendSessionMatch[1] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const changed = detail.backendSessionId !== null;
      state.details[runId] = { ...detail, backendSessionId: null };
      return new Response(
        JSON.stringify({
          result: { runId, updatedAt: detail.updatedAt, backendSessionId: null, changed },
        }),
        { status: 200 },
      );
    }

    const setGroupMatch = /\/api\/runs\/([^/]+)\/group$/.exec(url);
    if (setGroupMatch && init?.method === "POST") {
      const runId = decodeURIComponent(setGroupMatch[1] ?? "");
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { runGroupId?: string })
          : {};
      const detail = state.details[runId];
      const runGroupId = body.runGroupId?.trim() ?? "";
      if (!detail || runGroupId.length === 0) {
        return new Response(JSON.stringify({ error: { message: "invalid", code: "invalid" } }), {
          status: 400,
        });
      }
      const previousRunGroupId = detail.runGroupId;
      detail.runGroupId = runGroupId;
      state.runs = state.runs.map((run) => (run.runId === runId ? { ...run, runGroupId } : run));
      return new Response(
        JSON.stringify({
          result: {
            runId,
            updatedAt: detail.updatedAt,
            runGroupId,
            previousRunGroupId,
            changed: previousRunGroupId !== runGroupId,
          },
        }),
        { status: 200 },
      );
    }

    const clearGroupMatch = /\/api\/runs\/([^/]+)\/group\/clear$/.exec(url);
    if (clearGroupMatch && init?.method === "POST") {
      const runId = decodeURIComponent(clearGroupMatch[1] ?? "");
      const detail = state.details[runId];
      if (!detail) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      const previousRunGroupId = detail.runGroupId;
      detail.runGroupId = runId;
      state.runs = state.runs.map((run) =>
        run.runId === runId ? { ...run, runGroupId: runId } : run,
      );
      return new Response(
        JSON.stringify({
          result: {
            runId,
            updatedAt: detail.updatedAt,
            runGroupId: runId,
            previousRunGroupId,
            changed: previousRunGroupId !== runId,
          },
        }),
        { status: 200 },
      );
    }

    const addDependencyMatch = /\/api\/runs\/([^/]+)\/dependencies$/.exec(url);
    if (addDependencyMatch && init?.method === "POST") {
      const runId = decodeURIComponent(addDependencyMatch[1] ?? "");
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { type?: string; runId?: string; groupId?: string })
          : {};
      const detail = state.details[runId];
      if (
        !detail ||
        (body.type !== "run" && body.type !== "group") ||
        (body.type === "run" && !body.runId) ||
        (body.type === "group" && !body.groupId)
      ) {
        return new Response(JSON.stringify({ error: { message: "invalid", code: "invalid" } }), {
          status: 400,
        });
      }
      if (body.type === "run") {
        const dependencyRunId = body.runId as string;
        detail.dependencies = [...detail.dependencies, dependencyDetailFor(dependencyRunId)];
        const dependencyDetail = state.details[dependencyRunId];
        if (dependencyDetail) {
          dependencyDetail.dependents = [...dependencyDetail.dependents, dependentDetailFor(runId)];
        }
      } else {
        const dependencyGroupId = body.groupId as string;
        detail.dependencies = [
          ...detail.dependencies,
          {
            type: "group",
            groupId: dependencyGroupId,
            total: 2,
            successful: 1,
            unsatisfied: 1,
            archivedExcluded: 0,
            satisfied: false,
            missing: false,
          },
        ];
      }
      syncDependencyState(runId);
      return new Response(
        JSON.stringify({
          result: {
            runId,
            updatedAt: detail.updatedAt,
            dependencies: detail.dependencies.map((dependency) =>
              dependency.type === "run"
                ? { type: "run", runId: dependency.runId }
                : { type: "group", groupId: dependency.groupId },
            ),
            changed: true,
          },
        }),
        { status: 200 },
      );
    }

    const removeDependencyMatch = /\/api\/runs\/([^/]+)\/dependencies$/.exec(url);
    if (removeDependencyMatch && init?.method === "DELETE") {
      const runId = decodeURIComponent(removeDependencyMatch[1] ?? "");
      const body =
        typeof init.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as { type?: string; runId?: string; groupId?: string })
          : {};
      const detail = state.details[runId];
      if (
        !detail ||
        (body.type !== "run" && body.type !== "group") ||
        (body.type === "run" && !body.runId) ||
        (body.type === "group" && !body.groupId)
      ) {
        return new Response(JSON.stringify({ error: { message: "missing", code: "not_found" } }), {
          status: 404,
        });
      }
      if (body.type === "run") {
        const dependencyRunId = body.runId as string;
        detail.dependencies = detail.dependencies.filter(
          (dependency) => dependency.type !== "run" || dependency.runId !== dependencyRunId,
        );
        const dependencyDetail = state.details[dependencyRunId];
        if (dependencyDetail) {
          dependencyDetail.dependents = dependencyDetail.dependents.filter(
            (dependent) => dependent.runId !== runId,
          );
        }
      } else {
        const dependencyGroupId = body.groupId as string;
        detail.dependencies = detail.dependencies.filter(
          (dependency) => dependency.type !== "group" || dependency.groupId !== dependencyGroupId,
        );
      }
      syncDependencyState(runId);
      return new Response(
        JSON.stringify({
          result: {
            runId,
            updatedAt: detail.updatedAt,
            dependencies: detail.dependencies.map((dependency) =>
              dependency.type === "run"
                ? { type: "run", runId: dependency.runId }
                : { type: "group", groupId: dependency.groupId },
            ),
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
      const priorDependencyIds = detail.dependencies
        .filter((dependency) => dependency.type === "run")
        .map((dependency) => dependency.runId);
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
            updatedAt: detail.updatedAt,
            dependencies: [],
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

async function renderApp(initialPath = "/") {
  await router.navigate({ to: initialPath });
  return render(<App />);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findRunCard(name: string | RegExp) {
  return await screen.findByRole(
    "button",
    {
      name: typeof name === "string" ? new RegExp(`^${escapeRegExp(name)}$`, "i") : name,
    },
    {
      timeout: 5000,
    },
  );
}

async function findRunRow(name: string | RegExp) {
  return await screen.findByRole(
    "button",
    {
      name: typeof name === "string" ? new RegExp(`^Open run ${escapeRegExp(name)}$`, "i") : name,
    },
    {
      timeout: 5000,
    },
  );
}

async function findRunRowSurface(name: string | RegExp) {
  const button = await findRunRow(name);
  const row = button.closest(".run-row");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Expected run row surface");
  }
  return row;
}

function nativeCancel(dialog: HTMLElement) {
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
}

async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Filters" }));
  return await screen.findByRole("dialog", { name: "Filters" });
}

function findEventSource(urlSuffix: string) {
  for (let index = MockEventSource.instances.length - 1; index >= 0; index--) {
    const instance = MockEventSource.instances[index];
    if (instance?.url.endsWith(urlSuffix)) {
      return instance;
    }
  }
  throw new Error(`expected EventSource for ${urlSuffix}`);
}

function hasEventSource(urlSuffix: string) {
  return MockEventSource.instances.some((candidate) => candidate.url.endsWith(urlSuffix));
}

function fetchCallCount(
  fetchMock: ReturnType<typeof installFetchMock>,
  predicate: (url: string) => boolean,
) {
  return fetchMock.mock.calls.filter(([url]) => predicate(String(url))).length;
}

function fetchMutationUrls(fetchMock: ReturnType<typeof installFetchMock>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method !== undefined && init.method !== "GET")
    .map(([url]) => String(url));
}

function makeWorkspaceDiff(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    cwd: "/tmp/agent-runner",
    repoRoot: "/tmp/agent-runner",
    mode: "branch",
    baseRef: "main",
    headRef: "HEAD",
    comparison: "merge-base",
    displayRange: "main...HEAD",
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
      },
    ],
    stats: { files: 1, additions: 1, deletions: 0 },
    patch: [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,2 @@",
      " export const existing = true;",
      "+export const selected = true;",
      "",
    ].join("\n"),
    truncated: false,
    maxBytes: 524288,
    ...overrides,
  };
}

function getRunActionMenuElement() {
  const menu = document.querySelector(".run-action-menu");
  expect(menu).toBeInTheDocument();
  return menu as HTMLElement;
}

function dispatchPointerEvent(
  target: Element,
  type: string,
  init: {
    button?: number;
    clientX?: number;
    clientY?: number;
    pointerType?: string;
  },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, { value });
  }
  return fireEvent(target, event);
}

function getCloseDetailButton() {
  const closeButtons = screen.queryAllByRole("button", { name: /close selected run panel/i });
  const closeButton = closeButtons[0];
  if (closeButton) {
    return closeButton;
  }
  const fallbackCloseButton = screen.queryAllByRole("button", { name: /close detail/i })[0];
  if (!fallbackCloseButton) {
    throw new Error("expected a close-panel button");
  }
  return fallbackCloseButton;
}

function getSidebarNavigation() {
  const sidebar = document.querySelector("aside.sidebar");
  if (!(sidebar instanceof HTMLElement)) {
    throw new Error("expected desktop sidebar navigation");
  }
  return within(sidebar);
}

function getBoardColumn(name: string) {
  const headingName = new RegExp(`^${escapeRegExp(name)}(?: \\(\\d+\\))?$`);
  const column = screen.getByRole("heading", { name: headingName }).closest("article");
  if (!column) {
    throw new Error(`expected board column ${name}`);
  }
  return column as HTMLElement;
}

function getColumnRunNames(name: string) {
  const column = getBoardColumn(name);
  return Array.from(column.querySelectorAll(".col-body .card .card-title")).map(
    (element) => element.textContent ?? "",
  );
}

function getBoardColumnTitles() {
  const board = screen.getByLabelText("Run board");
  return Array.from(board.querySelectorAll(".column h2")).map(
    (element) => element.textContent ?? "",
  );
}

type ElementMetricValue = number | ReturnType<typeof vi.fn> | (() => unknown);

function defineElementMetric(element: Element, key: string, value: ElementMetricValue) {
  Object.defineProperty(element, key, {
    configurable: true,
    value,
    writable: true,
  });
}

function dispatchHorizontalWheel(element: Element, deltaX = 80) {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaX,
    deltaY: 0,
  });
  element.dispatchEvent(event);
  return event;
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

function setColumnBodyGeometry(options: {
  bodyTop?: number;
  columnName: string;
  clientHeight: number;
  scrollTop?: number;
  scrollTo?: ReturnType<typeof vi.fn>;
  cards: Array<{ runId: string; top: number; height: number }>;
}) {
  const column = getBoardColumn(options.columnName);
  const body = column.querySelector(".col-body");
  if (!(body instanceof HTMLElement)) {
    throw new Error(`expected scrollable body for column ${options.columnName}`);
  }

  const bodyTop = options.bodyTop ?? 100;
  defineElementMetric(body, "clientHeight", options.clientHeight);
  defineElementMetric(body, "scrollTop", options.scrollTop ?? 0);
  defineElementMetric(
    body,
    "scrollTo",
    options.scrollTo ??
      vi.fn(({ top }: { top: number }) => {
        defineElementMetric(body, "scrollTop", top);
      }),
  );
  defineElementMetric(body, "getBoundingClientRect", () => ({
    x: 0,
    y: bodyTop,
    top: bodyTop,
    left: 0,
    right: 240,
    bottom: bodyTop + body.clientHeight,
    width: 240,
    height: body.clientHeight,
    toJSON: () => ({}),
  }));

  for (const card of options.cards) {
    const element = body.querySelector(`[data-run-id="${card.runId}"]`);
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    defineElementMetric(element, "offsetTop", card.top);
    defineElementMetric(element, "offsetHeight", card.height);
    defineElementMetric(element, "getBoundingClientRect", () => {
      const top = bodyTop + card.top - body.scrollTop;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 220,
        bottom: top + card.height,
        width: 220,
        height: card.height,
        toJSON: () => ({}),
      };
    });
  }

  return body;
}

function getTimelineContentScrollRegion() {
  const scrollRegion = document.querySelector(".timeline-content-scroll");
  if (!(scrollRegion instanceof HTMLElement)) {
    throw new Error("expected timeline content scroll region");
  }
  return scrollRegion;
}

function setTimelineScrollGeometry(options: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop?: number;
}) {
  const scrollRegion = getTimelineContentScrollRegion();
  defineElementMetric(scrollRegion, "clientHeight", options.clientHeight);
  defineElementMetric(scrollRegion, "scrollHeight", options.scrollHeight);
  defineElementMetric(scrollRegion, "scrollTop", options.scrollTop ?? 0);
  return scrollRegion;
}

describe("web app", () => {
  beforeEach(() => {
    queryClient.clear();
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    MockEventSource.instances = [];
    initializeMermaid.mockClear();
    renderMermaid.mockClear();
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.stubGlobal("scrollTo", vi.fn());
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal("CSS", {
      escape: (value: string) => value.replace(/["\\]/g, "\\$&"),
    } satisfies Pick<typeof CSS, "escape">);
    if (window.CSSStyleSheet && !CSSStyleSheet.prototype.replaceSync) {
      Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", {
        configurable: true,
        value: vi.fn(),
      });
    }
  });

  afterEach(async () => {
    cleanup();
    delete document.documentElement.dataset.theme;
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
    expect(screen.getAllByText("CWD").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("/tmp/agent-runner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy cwd path/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy run id/i })).toBeInTheDocument();
  });

  it("toggles list mode, filters by status, sorts globally, and preserves row actions", async () => {
    const runs = [
      makeRun({
        runId: "run-list-running",
        repo: "repo-a",
        assignmentName: "Running list",
        name: "Running list",
        status: "running",
        effectiveStatus: "running",
        startedAt: "2026-04-13T05:00:00.000Z",
        updatedAt: "2026-04-13T05:00:00.000Z",
        attachmentCount: 2,
        queuedResumeMessageCount: 1,
        notePresent: true,
        activeTask: { id: "running-task", title: "Draft running update" },
      }),
      makeRun({
        runId: "run-list-completed",
        repo: "repo-a",
        assignmentName: "Completed list",
        name: "Completed list",
        pinned: true,
        status: "success",
        effectiveStatus: "success",
        startedAt: "2026-04-13T06:00:00.000Z",
        updatedAt: "2026-04-13T06:00:00.000Z",
        endedAt: "2026-04-13T06:30:00.000Z",
        capabilities: {
          canArchive: false,
          canDelete: false,
          canReady: false,
          canResume: false,
          canUnarchive: false,
        },
      }),
      makeRun({
        runId: "run-list-ready",
        repo: "repo-b",
        assignmentName: "Ready list",
        name: "Ready list",
        status: "ready",
        effectiveStatus: "ready",
        startedAt: "2026-04-13T07:00:00.000Z",
        updatedAt: "2026-04-13T07:00:00.000Z",
        activeTask: null,
        capabilities: {
          canReady: true,
        },
      }),
      makeRun({
        runId: "run-list-blocked",
        repo: "repo-c",
        assignmentName: "Blocked list",
        name: "Blocked list",
        status: "blocked",
        effectiveStatus: "blocked",
        startedAt: "2026-04-13T04:00:00.000Z",
        updatedAt: "2026-04-13T04:00:00.000Z",
      }),
    ];
    const fetchMock = installFetchMock({
      runs,
      details: Object.fromEntries(
        runs.map((run) => [
          run.runId,
          makeDetail({
            runId: run.runId,
            repo: run.repo,
            status: run.status,
            effectiveStatus: run.effectiveStatus,
            assignment: run.assignmentName
              ? { name: run.assignmentName, sourcePath: `/tmp/${run.runId}.md` }
              : null,
            name: run.name,
            pinned: run.pinned,
            note: run.notePresent ? "List note" : null,
            capabilities: run.capabilities,
          }),
        ]),
      ),
    });

    const user = userEvent.setup();
    await renderApp();

    await findRunCard("Ready list");
    await user.click(screen.getByRole("button", { name: "List" }));

    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /hide empty columns/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /collapse failure states/i }),
    ).not.toBeInTheDocument();

    const list = await screen.findByLabelText("Runs list");
    expect(
      within(list)
        .getAllByRole("button", { name: /^Open run / })
        .map((button) => button.textContent),
    ).toEqual([
      expect.stringContaining("Completed list"),
      expect.stringContaining("Ready list"),
      expect.stringContaining("Running list"),
      expect.stringContaining("Blocked list"),
    ]);
    const runningRowSurface = await findRunRowSurface("Running list");
    expect(runningRowSurface.querySelector(".run-row__signals")).toBeNull();
    expect(runningRowSurface.querySelector(".progress")).toBeNull();
    expect(within(runningRowSurface).getByLabelText("1 of 4 tasks completed")).toHaveTextContent(
      "1 / 4",
    );
    expect(runningRowSurface.querySelector(".run-row__active-task")).toHaveTextContent(
      "Draft running update",
    );
    expect(within(runningRowSurface).queryByLabelText("Note present")).toBeNull();
    expect(within(runningRowSurface).getByLabelText("2 attachments")).toBeInTheDocument();
    expect(within(runningRowSurface).getByLabelText("1 queued message")).toBeInTheDocument();
    await user.click(
      within(runningRowSurface).getByRole("button", {
        name: "Preview or edit note for run run-list-running",
      }),
    );
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
    expect(within(await findRunRow("Completed list")).queryByLabelText("Pinned")).toBeNull();
    expect(screen.getByRole("button", { name: "All statuses, 4 runs" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Completed, 1 run" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Initialized, 1 run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exhausted, 1 run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Error, 1 run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aborted, 1 run" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Completed, 1 run" }));
    expect(await findRunRow("Completed list")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Open run Running list$/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All statuses, 4 runs" }));
    expect(await findRunRow("Running list")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search runs"), "ready");
    expect(await findRunRow("Ready list")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Open run Completed list$/i }),
    ).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("Search runs"));
    const repoFilterButton = screen.getAllByRole("button", { name: "Filter by repo repo-a" }).at(0);
    if (!repoFilterButton) {
      throw new Error("Expected at least one repo-a filter button in list mode.");
    }
    await user.click(repoFilterButton);
    expect(await findRunRow("Completed list")).toBeInTheDocument();
    expect(await findRunRow("Running list")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Open run Ready list$/i }),
    ).not.toBeInTheDocument();

    await user.click(await findRunRowSurface("Completed list"));
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(screen.getAllByText("Completed list").length).toBeGreaterThanOrEqual(1);

    await user.click(screen.getByRole("button", { name: "Run actions for run-list-completed" }));
    expect(getRunActionMenuElement()).toHaveAttribute(
      "aria-label",
      "Run actions for run-list-completed",
    );
    expect(within(getRunActionMenuElement()).getByText("No available actions")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).not.toBeInTheDocument());

    fireEvent.contextMenu(await findRunRowSurface("Completed list"), { clientX: 48, clientY: 56 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());
    expect(within(getRunActionMenuElement()).getByText("No available actions")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).not.toBeInTheDocument());

    dispatchPointerEvent(await findRunRowSurface("Completed list"), "pointerdown", {
      button: 0,
      clientX: 52,
      clientY: 64,
      pointerType: "touch",
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 540));
    });

    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());
    expect(within(getRunActionMenuElement()).getByText("No available actions")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Unpin run run-list-completed" }));
    await waitFor(() =>
      expect(
        fetchMutationUrls(fetchMock).some((url) => url === "/api/runs/run-list-completed/pinned"),
      ).toBe(true),
    );
  }, 20_000);

  it.each([
    [
      "startedAt",
      "Started",
      {
        startedAtOffsetMs: -2 * 60 * 60 * 1000,
        updatedAtOffsetMs: -60 * 60 * 1000,
        endedAtOffsetMs: undefined,
      },
    ],
    [
      "updatedAt",
      "Updated",
      {
        startedAtOffsetMs: -4 * 60 * 60 * 1000,
        updatedAtOffsetMs: -3 * 60 * 60 * 1000,
        endedAtOffsetMs: undefined,
      },
    ],
    [
      "endedAt",
      "Ended",
      {
        startedAtOffsetMs: -5 * 60 * 60 * 1000,
        updatedAtOffsetMs: -2 * 60 * 60 * 1000,
        endedAtOffsetMs: -4 * 60 * 60 * 1000,
      },
    ],
  ] as const)(
    "shows relative-only timestamps in list mode for %s sorting",
    async (sortField, label, offsets) => {
      const now = Date.now();
      const startedAt = new Date(
        now + (offsets.startedAtOffsetMs ?? -60 * 60 * 1000),
      ).toISOString();
      const updatedAt = new Date(
        now + (offsets.updatedAtOffsetMs ?? -60 * 60 * 1000),
      ).toISOString();
      const endedAt =
        offsets.endedAtOffsetMs === undefined
          ? null
          : new Date(now + offsets.endedAtOffsetMs).toISOString();
      const run = makeRun({
        runId: `run-list-${sortField}`,
        assignmentName: `${label} relative list`,
        name: `${label} relative list`,
        startedAt,
        updatedAt,
        endedAt,
        status: endedAt === null ? "running" : "success",
        effectiveStatus: endedAt === null ? "running" : "success",
      });

      setStoredDashboardPreferences({ sortField, sortDirection: "desc" });
      setStoredDashboardViewState({ viewMode: "list" });
      installFetchMock({
        runs: [run],
        details: {
          [run.runId]: makeDetail({
            runId: run.runId,
            assignment: { name: run.assignmentName ?? "", sourcePath: "/tmp/list-relative.md" },
            name: run.name,
            startedAt,
            updatedAt,
            endedAt,
            status: run.status,
            effectiveStatus: run.effectiveStatus,
          }),
        },
      });

      await renderApp();

      const rowSurface = await findRunRowSurface(`${label} relative list`);
      const timeCell = rowSurface.querySelector(".run-row__time");
      if (!(timeCell instanceof HTMLElement)) {
        throw new Error("Expected list row time cell.");
      }
      const timeValue = timeCell.querySelector(".run-row__time-value");
      if (!(timeValue instanceof HTMLElement)) {
        throw new Error("Expected list row time value.");
      }

      expect(within(timeCell).getByText(label)).toBeInTheDocument();
      expect(timeValue).not.toHaveTextContent(/\d{4}/);
      expect(timeValue).not.toHaveTextContent("Not available");
    },
  );

  it("shows Not available for null ended timestamps in ended list sort mode", async () => {
    const now = Date.now();
    const startedAt = new Date(now - 60 * 60 * 1000).toISOString();
    const updatedAt = new Date(now - 30 * 60 * 1000).toISOString();
    const run = makeRun({
      runId: "run-list-ended-null",
      assignmentName: "Ended missing list",
      name: "Ended missing list",
      startedAt,
      updatedAt,
      endedAt: null,
      status: "running",
      effectiveStatus: "running",
    });

    setStoredDashboardPreferences({ sortField: "endedAt", sortDirection: "desc" });
    setStoredDashboardViewState({ viewMode: "list" });
    installFetchMock({
      runs: [run],
      details: {
        [run.runId]: makeDetail({
          runId: run.runId,
          assignment: { name: run.assignmentName ?? "", sourcePath: "/tmp/list-ended-null.md" },
          name: run.name,
          startedAt,
          updatedAt,
          endedAt: null,
          status: run.status,
          effectiveStatus: run.effectiveStatus,
        }),
      },
    });

    await renderApp();

    const rowSurface = await findRunRowSurface("Ended missing list");
    const timeCell = rowSurface.querySelector(".run-row__time");
    if (!(timeCell instanceof HTMLElement)) {
      throw new Error("Expected list row time cell.");
    }
    const timeValue = timeCell.querySelector(".run-row__time-value");
    if (!(timeValue instanceof HTMLElement)) {
      throw new Error("Expected list row time value.");
    }

    expect(within(timeCell).getByText("Ended")).toBeInTheDocument();
    expect(timeValue).toHaveTextContent("Not available");
    expect(timeValue).toHaveClass("run-row__time-value--muted");
  });

  it("uses board card layout for list items on mobile", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === "(max-width: 900px)",
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-list-mobile-card",
          assignmentName: "Mobile list card",
          name: "Mobile list card",
          pinned: true,
        }),
      ],
      details: {
        "run-list-mobile-card": makeDetail({
          runId: "run-list-mobile-card",
          assignment: { name: "Mobile list card", sourcePath: "/tmp/mobile-list-card.md" },
          name: "Mobile list card",
          pinned: true,
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Mobile list card");

    await user.click(screen.getByRole("button", { name: "List" }));

    const list = await screen.findByLabelText("Runs list");
    const listCard = within(list).getByRole("button", { name: "Mobile list card" });
    expect(listCard.closest(".card")).toBeInstanceOf(HTMLElement);
    expect(
      within(list).queryByRole("button", { name: /^Open run Mobile list card$/i }),
    ).not.toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "Unpin run run-list-mobile-card" }),
    ).toBeInTheDocument();
  });

  it("navigates visible list rows with up and down arrows", async () => {
    const runs = [
      makeRun({
        runId: "run-list-nav-oldest",
        assignmentName: "List nav oldest",
        name: "List nav oldest",
        startedAt: "2026-04-13T05:00:00.000Z",
        updatedAt: "2026-04-13T05:00:00.000Z",
      }),
      makeRun({
        runId: "run-list-nav-middle",
        assignmentName: "List nav middle",
        name: "List nav middle",
        startedAt: "2026-04-13T06:00:00.000Z",
        updatedAt: "2026-04-13T06:00:00.000Z",
      }),
      makeRun({
        runId: "run-list-nav-newest",
        assignmentName: "List nav newest",
        name: "List nav newest",
        startedAt: "2026-04-13T07:00:00.000Z",
        updatedAt: "2026-04-13T07:00:00.000Z",
      }),
    ];
    installFetchMock({
      runs,
      details: Object.fromEntries(
        runs.map((run) => [
          run.runId,
          makeDetail({
            runId: run.runId,
            assignment: {
              name: run.assignmentName ?? run.runId,
              sourcePath: `/tmp/${run.runId}.md`,
            },
            name: run.name,
            startedAt: run.startedAt,
            updatedAt: run.updatedAt,
          }),
        ]),
      ),
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("List nav newest");
    await user.click(screen.getByRole("button", { name: "List" }));
    await screen.findByLabelText("Runs list");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Open run List nav newest$/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(router.state.location.pathname).toBe("/runs/run-list-nav-newest");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Open run List nav middle$/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(router.state.location.pathname).toBe("/runs/run-list-nav-middle");

    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Open run List nav newest$/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(router.state.location.pathname).toBe("/runs/run-list-nav-newest");
  });

  it("renders list status chips for every run status label", async () => {
    const statusRuns = [
      ["initialized", "Initialized"],
      ["ready", "Ready"],
      ["running", "Running"],
      ["blocked", "Blocked"],
      ["exhausted", "Exhausted"],
      ["error", "Error"],
      ["aborted", "Aborted"],
      ["success", "Completed"],
    ] as const;
    installFetchMock({
      runs: statusRuns.map(([status, label]) =>
        makeRun({
          runId: `run-chip-${status}`,
          assignmentName: `${label} chip`,
          name: `${label} chip`,
          status,
          effectiveStatus: status,
          endedAt: status === "success" ? "2026-04-13T06:30:00.000Z" : null,
        }),
      ),
      details: Object.fromEntries(
        statusRuns.map(([status, label]) => [
          `run-chip-${status}`,
          makeDetail({
            runId: `run-chip-${status}`,
            assignment: { name: `${label} chip`, sourcePath: `/tmp/run-chip-${status}.md` },
            name: `${label} chip`,
            status,
            effectiveStatus: status,
          }),
        ]),
      ),
    });

    const user = userEvent.setup();
    await renderApp();

    await findRunCard("Ready chip");
    await user.click(screen.getByRole("button", { name: "List" }));

    expect(await screen.findByRole("button", { name: "All statuses, 8 runs" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const [, label] of statusRuns) {
      expect(screen.getByRole("button", { name: `${label}, 1 run` })).toBeInTheDocument();
    }
  });

  it("cycles view modes with V, suppresses V while typing, and hydrates persisted list mode", async () => {
    installFetchMock({
      runs: [makeRun({ runId: "run-list-cycle", name: "Cycle list" })],
      details: { "run-list-cycle": makeDetail({ runId: "run-list-cycle", name: "Cycle list" }) },
    });

    const user = userEvent.setup();
    const rendered = await renderApp();

    await findRunCard("Cycle list");
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("v");
    expect(await screen.findByLabelText("Runs list")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");

    await user.type(screen.getByPlaceholderText("Search runs"), "cycle");
    await user.keyboard("v");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");

    rendered.unmount();
    cleanup();
    queryClient.clear();
    setStoredDashboardViewState({ viewMode: "list" });
    await renderApp();

    expect(await screen.findByLabelText("Runs list")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches modes without clearing board collapse, search, selected run, or list status state", async () => {
    const runs = [
      makeRun({
        runId: "run-mode-running",
        assignmentName: "Mode running",
        name: "Mode running",
        status: "running",
        effectiveStatus: "running",
      }),
      makeRun({
        runId: "run-mode-completed",
        assignmentName: "Mode completed",
        name: "Mode completed",
        status: "success",
        effectiveStatus: "success",
        endedAt: "2026-04-13T06:30:00.000Z",
      }),
    ];
    installFetchMock({
      runs,
      details: {
        "run-mode-running": makeDetail({
          runId: "run-mode-running",
          name: "Mode running",
          assignment: { name: "Mode running", sourcePath: "/tmp/mode-running.md" },
        }),
        "run-mode-completed": makeDetail({
          runId: "run-mode-completed",
          name: "Mode completed",
          status: "success",
          effectiveStatus: "success",
          assignment: { name: "Mode completed", sourcePath: "/tmp/mode-completed.md" },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await findRunCard("Mode running");
    await user.click(screen.getByRole("button", { name: "Collapse Running column" }));
    expect(getBoardColumn("Running")).toHaveAttribute("data-collapsed", "true");
    await user.click(await findRunCard("Mode completed"));
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Search runs"), "mode");

    await user.click(screen.getByRole("button", { name: "List" }));
    expect(await screen.findByLabelText("Runs list")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search runs")).toHaveValue("mode");
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Completed, 1 run" }));
    expect(await findRunRow("Mode completed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Open run Mode running$/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Board" }));
    expect(getBoardColumn("Running")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByPlaceholderText("Search runs")).toHaveValue("mode");
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "Completed, 1 run" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await findRunRow("Mode completed")).toBeInTheDocument();
  });

  it("shows an explicit empty state when the selected run has no tasks", async () => {
    installFetchMock({
      runs: [makeRun({ tasksCompleted: 0, tasksTotal: 0 })],
      details: {
        "run-1": makeDetail({
          tasks: [],
          tasksCompleted: 0,
          tasksTotal: 0,
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Build dashboard"));

    expect(await screen.findByText("No tasks configured")).toBeInTheDocument();
    expect(screen.getByText("No tasks are configured for this run.")).toBeInTheDocument();
  });

  it("shows the parent run row in the detail drawer and navigates to the parent run", async () => {
    installFetchMock({
      runs: [
        makeRun({ runId: "run-parent", name: "Planning run", assignmentName: "Planning run" }),
        makeRun({
          runId: "run-child",
          name: "Implementer run",
          assignmentName: "Implementer run",
          parentRunId: "run-parent",
        }),
      ],
      details: {
        "run-parent": makeDetail({
          runId: "run-parent",
          name: "Planning run",
          assignment: {
            name: "Planning run",
            sourcePath: "/tmp/planning-assignment.md",
          },
        }),
        "run-child": makeDetail({
          runId: "run-child",
          name: "Implementer run",
          assignment: {
            name: "Implementer run",
            sourcePath: "/tmp/implementer-assignment.md",
          },
          parentRunId: "run-parent",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Implementer run"));

    expect(await screen.findByText("Parent run")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open parent run run-parent" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Planning run" })).toBeInTheDocument();
    });
  });

  it("defers attempts and audit history until their drawer tabs are opened", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: null,
              prompt: "Deferred prompt",
              transcript: "Deferred response",
              notices: "",
              exitCode: null,
              timedOut: false,
              live: true,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
      auditHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          events: [
            {
              runId: "run-1",
              cursor: 1,
              event: {
                type: "task.added",
                recordedAt: "2026-04-21T16:00:00.000Z",
                source: "task_command",
                hostMode: "embedded",
                fields: {
                  taskId: "lazy-history",
                  taskTitle: "Lazy history task",
                },
              },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();

    expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(0);
    expect(
      fetchCallCount(fetchMock, (url) => /\/api\/runs\/run-1\/audit(?:\?.*)?$/.test(url)),
    ).toBe(0);
    expect(hasEventSource("/api/runs/run-1/events/timeline")).toBe(false);
    expect(hasEventSource("/api/runs/run-1/events/audit")).toBe(false);

    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Attempts" }));
    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();

    expect(await screen.findByRole("region", { name: "Attempt response" })).toHaveTextContent(
      "Deferred response",
    );
    expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(1);

    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Tasks",
      }),
    );
    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 2,
      event: {
        type: "agent_message_delta",
        text: " while away",
      },
    });
    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Attempts" }));
    expect(await screen.findByRole("region", { name: "Attempt response" })).toHaveTextContent(
      "Deferred response while away",
    );
    await waitFor(() => {
      expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(1);
    });

    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));
    const auditSource = findEventSource("/api/runs/run-1/events/audit");
    auditSource.emitOpen();

    const auditPanel = await screen.findByLabelText("Audit");
    expect(
      within(within(auditPanel).getByRole("list", { name: "Audit events" })).getByText(
        /Lazy history task/,
      ),
    ).toBeInTheDocument();
    expect(
      fetchCallCount(fetchMock, (url) => /\/api\/runs\/run-1\/audit(?:\?.*)?$/.test(url)),
    ).toBe(1);

    await user.click(within(auditPanel).getByRole("tab", { name: "Tasks" }));
    auditSource.emitMessage({
      runId: "run-1",
      cursor: 2,
      event: {
        type: "task.added",
        recordedAt: "2026-04-21T16:01:00.000Z",
        source: "task_command",
        hostMode: "embedded",
        fields: {
          taskId: "audit-while-away",
          taskTitle: "Audit while away",
        },
      },
    });
    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));
    await waitFor(() => {
      expect(
        fetchCallCount(fetchMock, (url) => /\/api\/runs\/run-1\/audit(?:\?.*)?$/.test(url)),
      ).toBe(1);
    });
    const updatedAuditPanel = await screen.findByLabelText("Audit");
    expect(
      within(within(updatedAuditPanel).getByRole("list", { name: "Audit events" })).getByText(
        /Audit while away/,
      ),
    ).toBeInTheDocument();
  });

  it("does not render the right-surface wrapper when no run is selected", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const { container } = await renderApp();
    await findRunCard("Build dashboard");

    expect(container.querySelector(".dashboard-right-surfaces")).toBeNull();
  });

  it("opens a selected-run panel and switches between Chat, Info, Notes, and Tasks tabs", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    await user.click(await findRunCard("Build dashboard"));
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    expect(screen.getByLabelText("Tasks")).toBeInTheDocument();

    const tablist = await screen.findByRole("tablist", { name: "Run surface" });
    await user.click(within(tablist).getByRole("tab", { name: "Chat" }));
    expect(await screen.findByLabelText("Run chat")).toBeInTheDocument();
    await user.type(await screen.findByLabelText("Message"), "keep this draft");

    await user.click(within(tablist).getByRole("tab", { name: "Info" }));
    expect(screen.getByLabelText("Attachments")).toBeInTheDocument();
    expect(screen.getByLabelText("Run chat").closest(".drawer-body--chat")).toHaveAttribute(
      "hidden",
    );

    await user.click(within(tablist).getByRole("tab", { name: "Notes" }));
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();

    await user.click(within(tablist).getByRole("tab", { name: /Tasks/ }));
    expect(screen.getByLabelText("Tasks")).toBeInTheDocument();

    await user.click(within(tablist).getByRole("tab", { name: "Chat" }));
    expect(await screen.findByLabelText("Message")).toHaveValue("keep this draft");

    await user.click(getCloseDetailButton());
    await waitFor(() => {
      expect(screen.queryByLabelText("Run detail")).not.toBeInTheDocument();
    });
  });

  it("switches the active selected-run surface from the Attachments, Chat, Info, Notes, and Tasks tabs", async () => {
    setStoredDashboardViewState({ activeRightSurface: "detail" });
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const tablist = await screen.findByRole("tablist", { name: "Run surface" });
    const detailTab = within(tablist).getByRole("tab", { name: "Info" });
    const chatTab = within(tablist).getByRole("tab", { name: "Chat" });
    const notesTab = within(tablist).getByRole("tab", { name: "Notes" });
    const tasksTab = within(tablist).getByRole("tab", { name: /Tasks/ });
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Chat", "Info", "Notes", "Tasks", "Diffs", "Files", "Attachments"]);
    expect(detailTab).toHaveAttribute("aria-selected", "true");
    expect(chatTab).toHaveAttribute("aria-selected", "false");
    expect(notesTab).toHaveAttribute("aria-selected", "false");
    expect(tasksTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByLabelText("Run chat").closest(".drawer-body--chat")).toHaveAttribute(
      "hidden",
    );

    await user.click(chatTab);
    expect(detailTab).toHaveAttribute("aria-selected", "false");
    expect(chatTab).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("Run chat")).toBeInTheDocument();

    await user.click(detailTab);
    expect(detailTab).toHaveAttribute("aria-selected", "true");
    expect(chatTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByLabelText("Run chat").closest(".drawer-body--chat")).toHaveAttribute(
      "hidden",
    );

    await user.click(notesTab);
    expect(notesTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();

    await user.click(tasksTab);
    expect(tasksTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Tasks")).toBeInTheDocument();
  });

  it("switches the active selected-run surface with keyboard shortcuts", async () => {
    setStoredDashboardViewState({ activeRightSurface: "detail" });
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const tablist = await screen.findByRole("tablist", { name: "Run surface" });
    const detailTab = within(tablist).getByRole("tab", { name: "Info" });
    const chatTab = within(tablist).getByRole("tab", { name: "Chat" });
    const notesTab = within(tablist).getByRole("tab", { name: "Notes" });
    const tasksTab = within(tablist).getByRole("tab", { name: /Tasks/ });
    const filesTab = within(tablist).getByRole("tab", { name: "Files" });
    const diffsTab = within(tablist).getByRole("tab", { name: "Diffs" });
    expect(detailTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("c");
    expect(chatTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Run chat").closest(".drawer-body--chat")).not.toHaveAttribute(
      "hidden",
    );
    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    expect(message).not.toHaveFocus();

    await user.keyboard("c");
    expect(message).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(message).not.toHaveFocus();

    await user.keyboard("i");
    expect(detailTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Run chat").closest(".drawer-body--chat")).toHaveAttribute(
      "hidden",
    );

    await user.keyboard("n");
    expect(notesTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
    const noteInput = screen.queryByRole("textbox", {
      name: /run note for build dashboard/i,
    });
    expect(noteInput).not.toBeInTheDocument();

    await user.keyboard("n");
    expect(
      await screen.findByRole("textbox", {
        name: /run note for build dashboard/i,
      }),
    ).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("textbox", {
        name: /run note for build dashboard/i,
      }),
    ).not.toBeInTheDocument();

    await user.keyboard("t");
    expect(tasksTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Tasks")).toBeInTheDocument();

    await user.keyboard("f");
    expect(filesTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Files")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "d" });
    expect(diffsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Diffs")).toBeInTheDocument();
  });

  it("restores existing persisted selected-run surfaces and falls back for unknown values", async () => {
    for (const [activeRightSurface, tabName] of [
      ["files", "Files"],
      ["tasks", /Tasks/],
    ] as const) {
      setStoredDashboardViewState({ activeRightSurface });
      installFetchMock({
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      });

      await renderApp("/runs/run-1");
      const tablist = await screen.findByRole("tablist", { name: "Run surface" });
      expect(within(tablist).getByRole("tab", { name: tabName })).toHaveAttribute(
        "aria-selected",
        "true",
      );

      cleanup();
      queryClient.clear();
    }

    window.localStorage.setItem(
      "agent-runner:web:dashboard-view-state",
      JSON.stringify({
        ...DEFAULT_DASHBOARD_VIEW_STATE,
        activeRightSurface: "unknown",
      }),
    );
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    await renderApp("/runs/run-1");
    const tablist = await screen.findByRole("tablist", { name: "Run surface" });
    expect(within(tablist).getByRole("tab", { name: "Info" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders the Diffs surface, restores it, switches comparisons, and refreshes", async () => {
    setStoredDashboardViewState({ activeRightSurface: "diffs" });
    const diffRequests: string[] = [];
    const fetchMock = installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest(url) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            diffRequests.push(parsed.search);
            const mode = parsed.searchParams.get("mode");
            const comparison = parsed.searchParams.get("comparison");
            const diff =
              mode === "working-tree"
                ? makeWorkspaceDiff({
                    mode: "working-tree",
                    baseRef: null,
                    headRef: null,
                    comparison: null,
                    displayRange: "Working tree",
                  })
                : makeWorkspaceDiff({
                    comparison,
                    displayRange: comparison === "direct" ? "main..HEAD" : "main...HEAD",
                  });
            return new Response(JSON.stringify({ diff }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const tablist = await screen.findByRole("tablist", { name: "Run surface" });
    expect(within(tablist).getByRole("tab", { name: "Diffs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByLabelText("Diffs")).toBeInTheDocument();
    expect((await screen.findAllByText("src/app.ts")).length).toBeGreaterThan(0);
    const rangeInput = screen.getByRole("textbox", { name: "Diff range" });
    expect(rangeInput).toHaveValue("main...HEAD");

    fireEvent.change(rangeInput, { target: { value: "main..HEAD" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(diffRequests).toContain("?mode=branch&base=main&head=HEAD&comparison=direct");
    });

    fireEvent.change(rangeInput, { target: { value: "working tree" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(diffRequests).toContain("?mode=working-tree");
    });

    const beforeRefresh = fetchCallCount(fetchMock, (url) => url.includes("/workspace/diff"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace diff" }));
    await waitFor(() => {
      expect(fetchCallCount(fetchMock, (url) => url.includes("/workspace/diff"))).toBeGreaterThan(
        beforeRefresh,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.getByRole("button", { name: "Expand all" })).toBeInTheDocument();
    expect(
      screen.getByLabelText("Code diff").querySelectorAll('[data-collapsed="true"]').length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeInTheDocument();
    expect(
      screen.getByLabelText("Code diff").querySelectorAll('[data-collapsed="true"]'),
    ).toHaveLength(0);
  });

  it("creates a task from a diff line selection with the contracted task body", async () => {
    setStoredDashboardViewState({ activeRightSurface: "diffs" });
    let createdTaskBody: { body?: string; title?: string } | undefined;
    installFetchMock(
      {
        runs: [
          makeRun({
            capabilities: {
              taskMutation: {
                canAdd: true,
                canEditPending: true,
                canDeletePending: true,
                canEditNotes: true,
                canSetStatus: true,
              },
            },
          }),
        ],
        details: {
          "run-1": makeDetail({
            capabilities: {
              taskMutation: {
                canAdd: true,
                canEditPending: true,
                canDeletePending: true,
                canEditNotes: true,
                canSetStatus: true,
              },
            },
            lockedFields: [],
          }),
        },
      },
      {
        handleRequest(url, init) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            return new Response(JSON.stringify({ diff: makeWorkspaceDiff() }), { status: 200 });
          }
          if (parsed.pathname === "/api/runs/run-1/tasks" && init?.method === "POST") {
            createdTaskBody =
              typeof init.body === "string"
                ? (JSON.parse(init.body) as { body?: string; title?: string })
                : undefined;
            return new Response(
              JSON.stringify({
                task: {
                  id: "diff-task",
                  title: createdTaskBody?.title ?? "",
                  body: createdTaskBody?.body ?? "",
                  status: "pending",
                  notes: "",
                },
              }),
              { status: 200 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");
    await user.click(
      await screen.findByRole("button", { name: "Select diff line for src/app.ts" }),
    );
    await user.click(await screen.findByRole("button", { name: "Add task" }));
    expect(await screen.findByRole("dialog", { name: "Create task" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Description"), "Create a follow-up from this diff.");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => {
      expect(createdTaskBody?.title).toBe("Update src/app.ts");
      expect(createdTaskBody?.body).toContain("Diff: `main...HEAD`");
      expect(createdTaskBody?.body).toContain("File: `src/app.ts`");
      expect(createdTaskBody?.body).toContain("Side: additions");
      expect(createdTaskBody?.body).toContain("Range: `src/app.ts:2`");
      expect(createdTaskBody?.body).toContain("export const selected = true;");
      expect(createdTaskBody?.body).toContain("Create a follow-up from this diff.");
    });
  });

  it("restores the persisted diff view mode and persists changes", async () => {
    setStoredDashboardViewState({ activeRightSurface: "diffs", diffsViewMode: "split" });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest(url) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            return new Response(JSON.stringify({ diff: makeWorkspaceDiff() }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    await renderApp("/runs/run-1");

    const codeDiff = await screen.findByLabelText("Code diff");
    expect(codeDiff).toHaveAttribute("data-diff-style", "split");
    expect(screen.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Unified" }));
    await waitFor(() => {
      expect(codeDiff).toHaveAttribute("data-diff-style", "unified");
    });
    const stored = JSON.parse(
      window.localStorage.getItem("agent-runner:web:dashboard-view-state") ?? "{}",
    );
    expect(stored.diffsViewMode).toBe("unified");
  });

  it("bumps the CodeView version when Collapse all is toggled", async () => {
    setStoredDashboardViewState({ activeRightSurface: "diffs" });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest(url) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            return new Response(JSON.stringify({ diff: makeWorkspaceDiff() }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    await renderApp("/runs/run-1");

    const codeDiff = await screen.findByLabelText("Code diff");
    const initialVersion = Number(codeDiff.getAttribute("data-code-view-version"));
    const firstItem = codeDiff.querySelector("[data-collapsed]");
    expect(firstItem).toHaveAttribute("data-collapsed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    await waitFor(() => {
      expect(Number(codeDiff.getAttribute("data-code-view-version"))).toBeGreaterThan(
        initialVersion,
      );
    });
    expect(codeDiff.querySelector("[data-collapsed]")).toHaveAttribute("data-collapsed", "true");

    const collapsedVersion = Number(codeDiff.getAttribute("data-code-view-version"));
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await waitFor(() => {
      expect(Number(codeDiff.getAttribute("data-code-view-version"))).toBeGreaterThan(
        collapsedVersion,
      );
    });
    expect(codeDiff.querySelector("[data-collapsed]")).toHaveAttribute("data-collapsed", "false");
  });

  it("collapses and expands an individual diff file from the header caret", async () => {
    setStoredDashboardViewState({ activeRightSurface: "diffs" });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest(url) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            return new Response(JSON.stringify({ diff: makeWorkspaceDiff() }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    await renderApp("/runs/run-1");

    const codeDiff = await screen.findByLabelText("Code diff");
    expect(codeDiff.querySelector("[data-collapsed]")).toHaveAttribute("data-collapsed", "false");

    const collapseButton = screen.getByRole("button", { name: "Collapse src/app.ts" });
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapseButton);

    await waitFor(() => {
      expect(codeDiff.querySelector("[data-collapsed]")).toHaveAttribute("data-collapsed", "true");
    });
    expect(screen.getByRole("button", { name: "Expand src/app.ts" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand src/app.ts" }));
    await waitFor(() => {
      expect(codeDiff.querySelector("[data-collapsed]")).toHaveAttribute("data-collapsed", "false");
    });
  });

  it("bumps the CodeView version when refreshed diff content changes", async () => {
    setStoredDashboardViewState({ activeRightSurface: "diffs" });
    let diff = makeWorkspaceDiff();
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest(url) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            return new Response(JSON.stringify({ diff }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    await renderApp("/runs/run-1");

    const codeDiff = await screen.findByLabelText("Code diff");
    const initialVersion = Number(codeDiff.getAttribute("data-code-view-version"));
    diff = makeWorkspaceDiff({
      patch: [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..3333333 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,1 +1,2 @@",
        " export const existing = true;",
        "+export const refreshed = true;",
        "",
      ].join("\n"),
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace diff" }));
    await waitFor(() => {
      expect(Number(codeDiff.getAttribute("data-code-view-version"))).toBeGreaterThan(
        initialVersion,
      );
    });
  });

  it("persists the diffs sidebar width when resized via keyboard", async () => {
    setStoredDashboardViewState({ activeRightSurface: "diffs", diffsSidebarWidth: 300 });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest(url) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            return new Response(JSON.stringify({ diff: makeWorkspaceDiff() }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    await renderApp("/runs/run-1");

    const resizer = await screen.findByRole("separator", {
      name: "Resize changed-files sidebar",
    });
    expect(resizer).toHaveAttribute("aria-valuenow", "300");

    fireEvent.keyDown(resizer, { key: "ArrowRight" });
    await waitFor(() => {
      expect(resizer).toHaveAttribute("aria-valuenow", "316");
    });

    fireEvent.keyDown(resizer, { key: "ArrowLeft", shiftKey: true });
    await waitFor(() => {
      expect(resizer).toHaveAttribute("aria-valuenow", "268");
    });

    const stored = JSON.parse(
      window.localStorage.getItem("agent-runner:web:dashboard-view-state") ?? "{}",
    );
    expect(stored.diffsSidebarWidth).toBe(268);
  });

  it("collapses the changed-file browser on mobile diffs layouts", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === "(max-width: 760px)",
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
    setStoredDashboardViewState({ activeRightSurface: "diffs", diffsSidebarWidth: 300 });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest(url) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            return new Response(JSON.stringify({ diff: makeWorkspaceDiff() }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    await renderApp("/runs/run-1");

    const sidebar = await screen.findByLabelText("Changed files");
    await waitFor(() => {
      expect(sidebar).toHaveClass("diffs-sidebar--collapsed");
    });
    expect(sidebar).toHaveTextContent("src/app.ts");
    const toggle = within(sidebar).getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("separator", { name: "Resize changed-files sidebar" }),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(sidebar).not.toHaveClass("diffs-sidebar--collapsed");
    });
    expect(sidebar.closest(".diffs-layout")).toHaveClass("diffs-layout--mobile-browser-expanded");
    expect(screen.queryByLabelText("Diff viewer")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Diff stats")).toBeInTheDocument();
  });

  it("persists the files sidebar width when resized via keyboard", async () => {
    setStoredDashboardViewState({ activeRightSurface: "files", filesSidebarWidth: 250 });
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    await renderApp("/runs/run-1");

    const resizer = await screen.findByRole("separator", {
      name: "Resize workspace files sidebar",
    });
    expect(resizer).toHaveAttribute("aria-valuenow", "250");

    fireEvent.keyDown(resizer, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => {
      expect(resizer).toHaveAttribute("aria-valuenow", "298");
    });

    const stored = JSON.parse(
      window.localStorage.getItem("agent-runner:web:dashboard-view-state") ?? "{}",
    );
    expect(stored.filesSidebarWidth).toBe(298);
  });

  it("shows Diffs loading, empty, error, and truncated states", async () => {
    setStoredDashboardViewState({ activeRightSurface: "diffs" });
    let resolveDiff: (response: Response) => void = () => {};
    const pendingDiff = new Promise<Response>((resolve) => {
      resolveDiff = resolve;
    });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest(url) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            return pendingDiff;
          }
          return undefined;
        },
      },
    );

    await renderApp("/runs/run-1");
    expect(await screen.findByText("Loading diff...")).toBeInTheDocument();

    await act(async () => {
      resolveDiff(
        new Response(
          JSON.stringify({
            diff: makeWorkspaceDiff({
              files: [],
              stats: { files: 0, additions: 0, deletions: 0 },
              patch: "",
              truncated: true,
            }),
          }),
          { status: 200 },
        ),
      );
      await pendingDiff;
    });

    expect(await screen.findByText("No changes in this comparison.")).toBeInTheDocument();
    expect(screen.getByText("Patch output was truncated at 512 KB.")).toBeInTheDocument();

    cleanup();
    queryClient.clear();
    setStoredDashboardViewState({ activeRightSurface: "diffs" });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest(url) {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/diff") {
            return new Response(
              JSON.stringify({
                error: { code: "INVALID_COMMAND", message: 'missing git base ref "main"' },
              }),
              { status: 422 },
            );
          }
          return undefined;
        },
      },
    );

    await renderApp("/runs/run-1");
    expect(await screen.findByText('missing git base ref "main"')).toBeInTheDocument();
  });

  it("renders the Files surface with loading, empty, error, and accessible controls", async () => {
    setStoredDashboardViewState({ activeRightSurface: "files" });
    let resolveRoot: (response: Response) => void = () => {};
    const rootResponse = new Promise<Response>((resolve) => {
      resolveRoot = resolve;
    });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest: (url) => {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/files") {
            if ((parsed.searchParams.get("path") ?? "") === "") {
              return rootResponse;
            }
            return new Response(
              JSON.stringify({
                directory: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "docs",
                  parentPath: "",
                  entries: [],
                  truncated: false,
                  maxEntries: 1000,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/workspace/search") {
            return new Response(
              JSON.stringify({
                search: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  query: parsed.searchParams.get("q") ?? "",
                  matches: [],
                  truncated: false,
                  maxResults: 50,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/workspace/file") {
            const filePath = parsed.searchParams.get("path") ?? "";
            if (filePath === "Dockerfile") {
              return new Response(
                JSON.stringify({
                  file: {
                    runId: "run-1",
                    cwd: "/tmp/agent-runner",
                    path: "Dockerfile",
                    name: "Dockerfile",
                    size: 12,
                    mtimeMs: null,
                    mediaType: "text/plain",
                    markdown: false,
                    text: "FROM node\n",
                    maxBytes: 1048576,
                  },
                }),
                { status: 200 },
              );
            }
            return new Response(
              JSON.stringify({
                error: {
                  code: "INVALID_COMMAND",
                  message: 'workspace file "README.md" is binary',
                },
              }),
              { status: 422 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    expect(await screen.findByRole("tab", { name: "Files", selected: true })).toBeInTheDocument();
    const searchInput = screen.getByLabelText("Search workspace files");
    expect(searchInput).toBeInTheDocument();
    expect(screen.getByText("Loading files...")).toBeInTheDocument();
    expect(screen.queryByText("Loading file...")).not.toBeInTheDocument();
    searchInput.blur();
    fireEvent.keyDown(window, { key: "f" });
    await waitFor(() => expect(searchInput).toHaveFocus());

    await act(async () => {
      resolveRoot(
        new Response(
          JSON.stringify({
            directory: {
              runId: "run-1",
              cwd: "/tmp/agent-runner",
              path: "",
              parentPath: null,
              entries: [
                {
                  path: "docs",
                  name: "docs",
                  kind: "directory",
                  size: null,
                  mtimeMs: null,
                  supportedText: true,
                  markdown: false,
                },
                {
                  path: "Dockerfile",
                  name: "Dockerfile",
                  kind: "file",
                  size: 12,
                  mtimeMs: null,
                  supportedText: true,
                  markdown: false,
                },
                {
                  path: "README.md",
                  name: "README.md",
                  kind: "file",
                  size: 42,
                  mtimeMs: null,
                  supportedText: true,
                  markdown: true,
                },
              ],
              truncated: false,
              maxEntries: 1000,
            },
          }),
          { status: 200 },
        ),
      );
      await rootResponse;
    });

    await user.click(await screen.findByRole("button", { name: /Dockerfile/ }));
    expect(await screen.findByRole("heading", { name: "Dockerfile" })).toBeInTheDocument();
    expect(await screen.findByText("FROM node")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Preview" })).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /README.md/ }));
    expect(await screen.findByText(/workspace file "README.md" is binary/)).toBeInTheDocument();

    await user.clear(searchInput);
    await user.type(searchInput, "missing");
    expect(await screen.findByText("No matching files.")).toBeInTheDocument();
    fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(searchInput).toHaveValue("");
    expect(searchInput).toHaveFocus();
    fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(searchInput).not.toHaveFocus();

    await user.clear(searchInput);
    await user.click(screen.getByRole("button", { name: /docs/ }));
    expect(await screen.findByText("This directory is empty.")).toBeInTheDocument();
  });

  it("refreshes the workspace file browser from the Files header", async () => {
    setStoredDashboardViewState({ activeRightSurface: "files" });
    let filesRequests = 0;
    let fileRequests = 0;
    let searchRequests = 0;
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest: (url) => {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/files") {
            filesRequests += 1;
            return new Response(
              JSON.stringify({
                directory: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "",
                  parentPath: null,
                  entries: [
                    {
                      path: "README.md",
                      name: "README.md",
                      kind: "file",
                      size: 14,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: true,
                    },
                  ],
                  truncated: false,
                  maxEntries: 1000,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/workspace/search") {
            searchRequests += 1;
            return new Response(
              JSON.stringify({
                search: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  query: parsed.searchParams.get("q") ?? "",
                  matches: [
                    {
                      path: "README.md",
                      name: "README.md",
                      kind: "file",
                      size: 14,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: true,
                    },
                  ],
                  truncated: false,
                  maxResults: 50,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/workspace/file") {
            fileRequests += 1;
            return new Response(
              JSON.stringify({
                file: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "README.md",
                  name: "README.md",
                  size: 14,
                  mtimeMs: null,
                  mediaType: "text/markdown",
                  markdown: true,
                  text: "# Workspace\n",
                  maxBytes: 1048576,
                },
              }),
              { status: 200 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");
    expect(await screen.findByRole("button", { name: /README.md/ })).toBeInTheDocument();
    expect(filesRequests).toBe(1);

    await user.click(screen.getByRole("button", { name: /README.md/ }));
    expect(await screen.findByRole("heading", { name: "README.md" })).toBeInTheDocument();
    expect(fileRequests).toBe(1);

    await user.type(screen.getByLabelText("Search workspace files"), "readme");
    await waitFor(() => expect(searchRequests).toBe(1));

    await user.click(screen.getByRole("button", { name: "Refresh workspace files" }));
    await waitFor(() => expect(filesRequests).toBe(2));
    expect(searchRequests).toBe(2);
    expect(fileRequests).toBe(2);
  });

  it("navigates workspace files with fullscreen up and down keys while search is focused", async () => {
    setStoredDashboardViewState({ activeRightSurface: "files" });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest: (url) => {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/files") {
            return new Response(
              JSON.stringify({
                directory: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "",
                  parentPath: null,
                  entries: [
                    {
                      path: "docs",
                      name: "docs",
                      kind: "directory",
                      size: null,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: false,
                    },
                    {
                      path: "alpha.md",
                      name: "alpha.md",
                      kind: "file",
                      size: 16,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: true,
                    },
                    {
                      path: "beta.md",
                      name: "beta.md",
                      kind: "file",
                      size: 15,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: true,
                    },
                    {
                      path: "Cargo.lock",
                      name: "Cargo.lock",
                      kind: "file",
                      size: 12,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: false,
                    },
                  ],
                  truncated: false,
                  maxEntries: 1000,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/workspace/file") {
            const filePath = parsed.searchParams.get("path") ?? "";
            const markdown = filePath !== "Cargo.lock";
            return new Response(
              JSON.stringify({
                file: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: filePath,
                  name: filePath,
                  size: filePath === "beta.md" ? 15 : filePath === "Cargo.lock" ? 12 : 16,
                  mtimeMs: null,
                  mediaType: markdown ? "text/markdown" : "text/plain",
                  markdown,
                  text:
                    filePath === "beta.md"
                      ? "# Beta\nbeta body"
                      : filePath === "Cargo.lock"
                        ? "# lockfile"
                        : "# Alpha\nalpha body",
                  maxBytes: 1048576,
                },
              }),
              { status: 200 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    await user.click(await screen.findByRole("button", { name: /alpha\.md/ }));
    expect(await screen.findByRole("heading", { name: "alpha.md" })).toBeInTheDocument();
    const searchInput = screen.getByLabelText("Search workspace files");
    searchInput.focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("heading", { name: "alpha.md" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand drawer to full width" }));
    searchInput.focus();
    expect(searchInput).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("heading", { name: "beta.md" })).toBeInTheDocument();

    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("heading", { name: "Cargo.lock" })).toBeInTheDocument();

    await user.keyboard("{ArrowUp}");
    expect(await screen.findByRole("heading", { name: "beta.md" })).toBeInTheDocument();
    expect(searchInput).toHaveFocus();
  });

  it("auto-collapses the workspace browser after opening a file on mobile", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === "(max-width: 760px)",
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
    setStoredDashboardViewState({ activeRightSurface: "files" });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest: (url) => {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/files") {
            return new Response(
              JSON.stringify({
                directory: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "",
                  parentPath: null,
                  entries: [
                    {
                      path: "README.md",
                      name: "README.md",
                      kind: "file",
                      size: 42,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: true,
                    },
                  ],
                  truncated: false,
                  maxEntries: 1000,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/workspace/file") {
            return new Response(
              JSON.stringify({
                file: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "README.md",
                  name: "README.md",
                  size: 42,
                  mtimeMs: null,
                  mediaType: "text/markdown",
                  markdown: true,
                  text: "# README",
                  maxBytes: 1048576,
                },
              }),
              { status: 200 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");
    expect(await screen.findByLabelText("Search workspace files")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /README.md/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
    expect(screen.queryByLabelText("Search workspace files")).not.toBeInTheDocument();
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f" });
    const mobileSearchInput = await screen.findByLabelText("Search workspace files");
    await waitFor(() => expect(mobileSearchInput).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.queryByLabelText("Search workspace files")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Workspace" }));
    expect(await screen.findByLabelText("Search workspace files")).toBeInTheDocument();
  });

  it("creates a task from rendered Markdown selection with the contracted task body", async () => {
    setStoredDashboardViewState({ activeRightSurface: "files" });
    let createdTaskBody: { body?: string; title?: string } | undefined;
    installFetchMock(
      {
        runs: [makeRun()],
        details: {
          "run-1": makeDetail({
            capabilities: {
              taskMutation: {
                canAdd: true,
                canEditPending: true,
                canDeletePending: true,
                canEditNotes: true,
                canSetStatus: true,
              },
            },
            lockedFields: [],
          }),
        },
      },
      {
        handleRequest: async (url, init) => {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/files") {
            return new Response(
              JSON.stringify({
                directory: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "",
                  parentPath: null,
                  entries: [
                    {
                      path: "docs/foo.md",
                      name: "foo.md",
                      kind: "file",
                      size: 28,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: true,
                    },
                  ],
                  truncated: false,
                  maxEntries: 1000,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/workspace/file") {
            return new Response(
              JSON.stringify({
                file: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "docs/foo.md",
                  name: "foo.md",
                  size: 28,
                  mtimeMs: null,
                  mediaType: "text/markdown",
                  markdown: true,
                  text: "# Heading\n\nThe selected rendered text.",
                  maxBytes: 1048576,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/tasks" && init?.method === "POST") {
            createdTaskBody =
              typeof init.body === "string"
                ? (JSON.parse(init.body) as { body?: string; title?: string })
                : undefined;
            return new Response(
              JSON.stringify({
                task: {
                  id: "created",
                  title: createdTaskBody?.title ?? "",
                  body: createdTaskBody?.body ?? "",
                  status: "pending",
                  notes: "",
                },
              }),
              { status: 200 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");
    await user.click(await screen.findByRole("button", { name: /foo.md/ }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    });
    const renderedText = await screen.findByText("The selected rendered text.");
    vi.spyOn(window, "getSelection").mockReturnValue({
      anchorNode: renderedText.firstChild,
      focusNode: renderedText.firstChild,
      toString: () => "The selected rendered text.",
    } as Selection);
    const renderedPreview = renderedText.closest(".files-rendered");
    if (!renderedPreview) {
      throw new Error("Rendered preview was not available");
    }
    fireEvent(document, new Event("selectionchange"));

    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(await screen.findByRole("dialog", { name: "Create task" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Description"), "Rewrite this paragraph.");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => {
      expect(createdTaskBody).toEqual({
        title: "Update docs/foo.md",
        body: [
          "File: `docs/foo.md`",
          "View: rendered-markdown",
          "",
          "Selected text:",
          "",
          "> The selected rendered text.",
          "",
          "Instructions:",
          "",
          "Rewrite this paragraph.",
        ].join("\n"),
      });
    });
    expect(await screen.findByText("Created task created.")).toBeInTheDocument();
  });

  it("disables rendered Markdown task creation when the run cannot add tasks", async () => {
    setStoredDashboardViewState({ activeRightSurface: "files" });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest: (url) => {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/files") {
            return new Response(
              JSON.stringify({
                directory: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "",
                  parentPath: null,
                  entries: [
                    {
                      path: "CHANGELOG.md",
                      name: "CHANGELOG.md",
                      kind: "file",
                      size: 28,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: true,
                    },
                  ],
                  truncated: false,
                  maxEntries: 1000,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/workspace/file") {
            return new Response(
              JSON.stringify({
                file: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "CHANGELOG.md",
                  name: "CHANGELOG.md",
                  size: 28,
                  mtimeMs: null,
                  mediaType: "text/markdown",
                  markdown: true,
                  text: "# Changelog\n\nSelected rendered text.",
                  maxBytes: 1048576,
                },
              }),
              { status: 200 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");
    await user.click(await screen.findByRole("button", { name: /CHANGELOG.md/ }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    });
    const renderedText = await screen.findByText("Selected rendered text.");
    vi.spyOn(window, "getSelection").mockReturnValue({
      anchorNode: renderedText.firstChild,
      focusNode: renderedText.firstChild,
      toString: () => "Selected rendered text.",
    } as Selection);
    const renderedPreview = renderedText.closest(".files-rendered");
    if (!renderedPreview) {
      throw new Error("Rendered preview was not available");
    }
    fireEvent.mouseUp(renderedPreview);

    const addTaskButton = screen.getByRole("button", { name: "Add task" });
    expect(addTaskButton).toBeDisabled();
    expect(addTaskButton).toHaveAttribute(
      "title",
      "Task creation is unavailable because this run locks its task list.",
    );
    await user.click(addTaskButton);
    expect(screen.queryByRole("dialog", { name: "Create task" })).not.toBeInTheDocument();
  });

  it("creates a task from source gutter range selection with the contracted task body", async () => {
    setStoredDashboardViewState({ activeRightSurface: "files" });
    let createdTaskBody: { body?: string; title?: string } | undefined;
    installFetchMock(
      {
        runs: [makeRun()],
        details: {
          "run-1": makeDetail({
            capabilities: {
              taskMutation: {
                canAdd: true,
                canEditPending: true,
                canDeletePending: true,
                canEditNotes: true,
                canSetStatus: true,
              },
            },
            lockedFields: [],
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1/workspace/files") {
            return new Response(
              JSON.stringify({
                directory: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "",
                  parentPath: null,
                  entries: [
                    {
                      path: "src/foo.ts",
                      name: "foo.ts",
                      kind: "file",
                      size: 64,
                      mtimeMs: null,
                      supportedText: true,
                      markdown: false,
                    },
                  ],
                  truncated: false,
                  maxEntries: 1000,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/workspace/file") {
            return new Response(
              JSON.stringify({
                file: {
                  runId: "run-1",
                  cwd: "/tmp/agent-runner",
                  path: "src/foo.ts",
                  name: "foo.ts",
                  size: 64,
                  mtimeMs: null,
                  mediaType: "text/plain",
                  markdown: false,
                  text: "const a = 1;\nconst b = 2;\nconst c = a + b;",
                  maxBytes: 1048576,
                },
              }),
              { status: 200 },
            );
          }
          if (parsed.pathname === "/api/runs/run-1/tasks" && init?.method === "POST") {
            createdTaskBody =
              typeof init.body === "string"
                ? (JSON.parse(init.body) as { body?: string; title?: string })
                : undefined;
            return new Response(
              JSON.stringify({
                task: {
                  id: "source-task",
                  title: createdTaskBody?.title ?? "",
                  body: createdTaskBody?.body ?? "",
                  status: "pending",
                  notes: "",
                },
              }),
              { status: 200 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");
    await user.click(await screen.findByRole("button", { name: /foo.ts/ }));
    const selectedStart = await screen.findByText("const b = 2;");
    const selectedEnd = screen.getByText("const c = a + b;");
    let selectionAnchor: Node | null = selectedStart.firstChild;
    let selectionFocus: Node | null = selectedEnd.firstChild;
    let selectionText = "2\nconst b = 2;\n3\nconst c = a + b;";
    vi.spyOn(window, "getSelection").mockReturnValue({
      get anchorNode() {
        return selectionAnchor;
      },
      get focusNode() {
        return selectionFocus;
      },
      removeAllRanges: vi.fn(() => {
        selectionAnchor = null;
        selectionFocus = null;
        selectionText = "";
      }),
      toString: () => selectionText,
    } as unknown as Selection);
    const sourcePreview = selectedStart.closest(".files-source");
    if (!sourcePreview) {
      throw new Error("Source preview was not available");
    }
    fireEvent(document, new Event("selectionchange"));
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear file selection" }));
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    selectionAnchor = selectedStart.firstChild;
    selectionFocus = selectedEnd.firstChild;
    selectionText = "2\nconst b = 2;\n3\nconst c = a + b;";
    fireEvent(document, new Event("selectionchange"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
    selectionAnchor = selectedStart.firstChild;
    selectionFocus = selectedEnd.firstChild;
    selectionText = "2\nconst b = 2;\n3\nconst c = a + b;";
    fireEvent(document, new Event("selectionchange"));

    fireEvent.keyDown(window, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "Create task" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => {
      expect(createdTaskBody).toEqual({
        title: "Update src/foo.ts",
        body: [
          "File: `src/foo.ts`",
          "View: source",
          "Range: `src/foo.ts:2-3`",
          "",
          "Selected source:",
          "",
          "```ts",
          "const b = 2;",
          "const c = a + b;",
          "```",
        ].join("\n"),
      });
    });
  });

  it("renders selected-run Chat, activates the existing timeline once, and streams deltas", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    const fetchMock = installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail({
          message: "Initial **dashboard** request",
        }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: null,
              prompt: "Prompt with **markdown**\n\n- list item",
              transcript: "Streaming answer",
              notices: "backend notice",
              exitCode: null,
              timedOut: false,
              live: true,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    expect(within(chat).queryByText("Initial **dashboard** request")).not.toBeInTheDocument();
    expect(within(chat).queryByText("Initial dashboard request")).not.toBeInTheDocument();
    const turnTimestamp = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date("2026-04-13T05:00:00.000Z"));
    expect(await within(chat).findByText(turnTimestamp)).toHaveClass("chat-turn-divider__label");
    const systemLabel = await within(chat).findByText("System");
    expect(systemLabel.closest(".chat-bubble--system")).not.toBeNull();
    expect(within(chat).getByText("Prompt with")).toBeInTheDocument();
    expect(within(chat).getByText("markdown").closest("strong")).not.toBeNull();
    expect(within(chat).getByText("list item")).toBeInTheDocument();
    expect(within(chat).queryByText("Notices and diagnostics")).not.toBeInTheDocument();
    expect(within(chat).queryByText("backend notice")).not.toBeInTheDocument();
    const assistantMessage = await within(chat).findByText("Streaming answer");
    expect(assistantMessage.closest(".chat-row--assistant")).not.toBeNull();
    expect(assistantMessage.closest(".chat-bubble")).toBeNull();
    expect(
      fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline")),
    ).toBeGreaterThanOrEqual(1);
    expect(
      MockEventSource.instances.filter((source) =>
        source.url.endsWith("/api/runs/run-1/events/timeline"),
      ),
    ).toHaveLength(1);

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();
    timelineSource.emitError();
    await waitFor(() => {
      expect(within(chat).queryByText(/conversation updates are stale/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/live updates are temporarily stale/i)).not.toBeInTheDocument();
    });
    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 2,
      event: {
        type: "agent_message_delta",
        text: " live",
      },
    });

    expect(await within(chat).findByText("Streaming answer live")).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Info",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Attempts" }));
    expect(await screen.findByRole("region", { name: "Attempt response" })).toHaveTextContent(
      "Streaming answer live",
    );
    expect(
      MockEventSource.instances.filter((source) =>
        source.url.endsWith("/api/runs/run-1/events/timeline"),
      ),
    ).toHaveLength(1);
  });

  it("shows Chat scroll controls when scrolled away from transcript edges", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail(),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "Prompt",
              transcript: "First response",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    const list = chat.querySelector(".chat-message-list");
    if (!(list instanceof HTMLElement)) {
      throw new Error("expected chat message list");
    }
    const scrollTopButton = chat.querySelector(".chat-scroll-control--top");
    if (!(scrollTopButton instanceof HTMLButtonElement)) {
      throw new Error("expected Chat scroll-to-top button");
    }
    const scrollBottomButton = chat.querySelector(".chat-scroll-control--bottom");
    if (!(scrollBottomButton instanceof HTMLButtonElement)) {
      throw new Error("expected Chat scroll-to-bottom button");
    }
    expect(scrollTopButton).toHaveAttribute("aria-hidden", "true");
    expect(scrollBottomButton).toHaveAttribute("aria-hidden", "true");

    defineElementMetric(list, "clientHeight", 120);
    defineElementMetric(list, "scrollHeight", 360);
    defineElementMetric(list, "scrollTop", 80);
    fireEvent.scroll(list);

    expect(scrollTopButton).toHaveAttribute("aria-hidden", "false");
    expect(scrollTopButton).toHaveClass("chat-scroll-control--visible");
    expect(scrollBottomButton).toHaveAttribute("aria-hidden", "false");
    expect(scrollBottomButton).toHaveClass("chat-scroll-control--visible");

    await user.click(scrollBottomButton);

    expect(list.scrollTop).toBe(240);
    expect(scrollTopButton).toHaveAttribute("aria-hidden", "false");
    expect(scrollBottomButton).toHaveAttribute("aria-hidden", "true");
    expect(scrollBottomButton).not.toHaveClass("chat-scroll-control--visible");

    await user.click(scrollTopButton);

    expect(list.scrollTop).toBe(0);
    expect(scrollTopButton).toHaveAttribute("aria-hidden", "true");
    expect(scrollTopButton).not.toHaveClass("chat-scroll-control--visible");
    expect(scrollBottomButton).toHaveAttribute("aria-hidden", "false");
  });

  it("reloads selected-run Chat when backend sync invalidates a completed timeline", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    const timelineHistory: RunTimelineHistory = {
      runId: "run-1",
      lastCursor: 1,
      attempts: [
        {
          attemptNumber: 1,
          attemptIndexInSession: 0,
          sessionIndex: 0,
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: "2026-04-13T05:02:00.000Z",
          prompt: "Initial prompt",
          transcript: "Initial answer",
          notices: "",
          exitCode: 0,
          timedOut: false,
          live: false,
          provenance: { kind: "task_runner" },
        },
      ],
    };
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          status: "success",
          effectiveStatus: "success",
          endedAt: "2026-04-13T05:02:00.000Z",
          totalAttemptCount: 1,
        }),
      ],
      details: {
        "run-1": makeDetail({
          status: "success",
          effectiveStatus: "success",
          isLive: false,
          endedAt: "2026-04-13T05:02:00.000Z",
          totalAttemptCount: 1,
        }),
      },
      timelineHistories: {
        "run-1": timelineHistory,
      },
    });

    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    expect(await within(chat).findByText("Initial answer")).toBeInTheDocument();

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();
    const initialAttempt = timelineHistory.attempts[0];
    if (!initialAttempt) {
      throw new Error("expected initial attempt");
    }
    timelineHistory.lastCursor = 2;
    timelineHistory.attempts = [
      initialAttempt,
      {
        attemptNumber: 2,
        attemptIndexInSession: 0,
        sessionIndex: 1,
        startedAt: "2026-04-13T05:03:00.000Z",
        endedAt: "2026-04-13T05:04:00.000Z",
        prompt: "testing 456",
        transcript: "Synced answer",
        notices: "",
        exitCode: 0,
        timedOut: false,
        live: false,
        provenance: { kind: "task_runner" },
      },
    ];
    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 2,
      event: {
        type: "timeline_invalidated",
        reason: "backend_session_sync",
      },
    });

    expect(await within(chat).findByText("Synced answer")).toBeInTheDocument();
    expect(
      fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline")),
    ).toBeGreaterThanOrEqual(2);
  });

  it("does not subscribe archived selected-run Chat to timeline events", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          archivedAt: "2026-04-13T06:00:00.000Z",
          status: "success",
          effectiveStatus: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          archivedAt: "2026-04-13T06:00:00.000Z",
          status: "success",
          effectiveStatus: "success",
          isLive: false,
        }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "Archived prompt",
              transcript: "Archived answer",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    await renderApp("/runs/run-1");

    expect(await screen.findByText("Archived answer")).toBeInTheDocument();
    expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(1);
    expect(hasEventSource("/api/runs/run-1/events/timeline")).toBe(false);
  });

  it("does not render the previous selected-run Chat while reloading a reselected card", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          assignmentName: "First run",
          currentSession: null,
          endedAt: "2026-04-13T05:02:00.000Z",
          name: "First run",
          status: "success",
          totalAttemptCount: 1,
        }),
        makeRun({
          runId: "run-2",
          assignmentName: "Second run",
          currentSession: null,
          endedAt: "2026-04-13T05:02:00.000Z",
          name: "Second run",
          status: "success",
          totalAttemptCount: 1,
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "First run",
            sourcePath: "/tmp/first.md",
          },
          currentSession: null,
          endedAt: "2026-04-13T05:02:00.000Z",
          isLive: false,
          message: "First request",
          name: "First run",
          status: "success",
        }),
        "run-2": makeDetail({
          runId: "run-2",
          assignment: {
            name: "Second run",
            sourcePath: "/tmp/second.md",
          },
          backendSessionId: "thread-2",
          currentSession: null,
          endedAt: "2026-04-13T05:02:00.000Z",
          isLive: false,
          message: "Second request",
          name: "Second run",
          status: "success",
        }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "First prompt",
              transcript: "First response",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
        "run-2": {
          runId: "run-2",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "Second prompt",
              transcript: "Second response",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    expect(await within(chat).findByText("First response")).toBeInTheDocument();
    const runOneTimelineFetches = fetchCallCount(fetchMock, (url) =>
      url.endsWith("/api/runs/run-1/timeline"),
    );

    const user = userEvent.setup();
    await user.click(await findRunCard("Second run"));
    expect(await screen.findByText("Second response")).toBeInTheDocument();

    await user.click(await findRunCard("First run"));
    const activeChat = await screen.findByLabelText("Run chat");
    expect(within(activeChat).queryByText("Second response")).not.toBeInTheDocument();
    expect(await within(activeChat).findByText("First response")).toBeInTheDocument();
    expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(
      runOneTimelineFetches + 1,
    );
  });

  it("renders a pending Chat system card before the first attempt starts", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    installFetchMock({
      runs: [
        makeRun({
          status: "initialized",
          effectiveStatus: "initialized",
          activeTask: null,
          totalAttemptCount: 0,
          totalSessionCount: 0,
          currentSession: null,
          lastSession: null,
        }),
      ],
      details: {
        "run-1": makeDetail({
          status: "initialized",
          effectiveStatus: "initialized",
          isLive: false,
          activeTask: null,
          totalAttemptCount: 0,
          totalSessionCount: 0,
          sessions: [],
          currentSession: null,
          lastSession: null,
          message: "Review this handoff before launch.",
          pendingPrompt: "## Prepared prompt\n\n- Check setup",
        }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 0,
          attempts: [],
        },
      },
    });

    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    const pendingLabel = await within(chat).findByText("System (PENDING)");
    const pendingBubble = pendingLabel.closest(".chat-bubble--system");
    expect(pendingBubble).not.toBeNull();
    expect(pendingBubble).not.toHaveClass("chat-bubble--system-pending");
    expect(
      within(chat).getByRole("heading", { level: 2, name: "Prepared prompt" }),
    ).toBeInTheDocument();
    expect(await within(chat).findByText("Check setup")).toBeInTheDocument();
    expect(within(chat).queryByText("Review this handoff before launch.")).not.toBeInTheDocument();
    expect(within(chat).queryByText("No conversation yet")).not.toBeInTheDocument();
  });

  it("keeps the empty Chat state before attempts when there is no pending prompt", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    installFetchMock({
      runs: [
        makeRun({
          status: "ready",
          effectiveStatus: "ready",
          activeTask: null,
          totalAttemptCount: 0,
          totalSessionCount: 0,
          currentSession: null,
          lastSession: null,
        }),
      ],
      details: {
        "run-1": makeDetail({
          status: "ready",
          effectiveStatus: "ready",
          isLive: false,
          activeTask: null,
          totalAttemptCount: 0,
          totalSessionCount: 0,
          sessions: [],
          currentSession: null,
          lastSession: null,
          message: "Initial request",
          pendingPrompt: null,
        }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 0,
          attempts: [],
        },
      },
    });

    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    expect(await within(chat).findByText("No conversation yet")).toBeInTheDocument();
    expect(
      await within(chat).findByText("This run has no user messages or attempts."),
    ).toBeInTheDocument();
    expect(within(chat).queryByText("Initial request")).not.toBeInTheDocument();
    expect(within(chat).queryByText("System (PENDING)")).not.toBeInTheDocument();
  });

  it("opens the top-level attachment preview tab from previewable Chat artifact cards", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    installFetchMock({
      runs: [makeRun({ attachmentCount: 1 })],
      details: {
        "run-1": makeDetail({
          attachments: [
            makeAttachment({
              id: "att-report",
              name: "report.md",
              mimeType: "text/markdown; charset=utf-8",
              addedAt: "2026-04-13T05:01:00.000Z",
            }),
          ],
        }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:05:00.000Z",
              prompt: "Prompt",
              transcript: "Created an artifact",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    expect(await within(chat).findByText("report.md")).toBeInTheDocument();
    expect(within(chat).getByText("text/markdown; charset=utf-8")).toBeInTheDocument();
    expect(within(chat).getByText("24 B")).toBeInTheDocument();

    await user.click(within(chat).getByRole("button", { name: "Preview attachment report.md" }));

    expect(router.state.location.pathname).toBe("/runs/run-1");
    expect(await screen.findByLabelText("Attachment preview")).toBeInTheDocument();
    expect(await screen.findByText("attachment body")).toBeInTheDocument();
  });

  it("downloads Chat artifact cards from primary and explicit actions without opening preview", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    const fetchMock = installFetchMock({
      runs: [makeRun({ attachmentCount: 2 })],
      details: {
        "run-1": makeDetail({
          attachments: [
            makeAttachment({
              id: "att-report",
              name: "report.md",
              mimeType: "text/markdown",
              addedAt: "2026-04-13T05:01:00.000Z",
            }),
            makeAttachment({
              id: "att-archive",
              name: "archive.zip",
              mimeType: "application/zip",
              addedAt: "2026-04-13T05:02:00.000Z",
            }),
          ],
        }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:05:00.000Z",
              prompt: "Prompt",
              transcript: "Created artifacts",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });
    const createObjectURL = vi.fn(() => "blob:chat-artifact-download");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    try {
      const user = userEvent.setup();
      await renderApp("/runs/run-1");

      const chat = await screen.findByLabelText("Run chat");
      await within(chat).findByText("archive.zip");

      await user.click(
        within(chat).getByRole("button", { name: "Download attachment archive.zip" }),
      );
      await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
      expect(
        within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
          name: "Chat",
        }),
      ).toHaveAttribute("aria-selected", "true");
      expect(screen.getByLabelText("Attachment preview")).not.toBeVisible();

      await user.click(within(chat).getByRole("button", { name: "Download report.md" }));
      await user.click(within(chat).getByRole("button", { name: "Download archive.zip" }));
      await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(3));
      expect(createObjectURL).toHaveBeenCalledTimes(3);
      expect(revokeObjectURL).toHaveBeenCalledTimes(3);
      expect(
        fetchCallCount(fetchMock, (url) =>
          /\/api\/runs\/run-1\/attachments\/att-report\/content$/.test(url),
        ),
      ).toBe(1);
      expect(
        fetchCallCount(fetchMock, (url) =>
          /\/api\/runs\/run-1\/attachments\/att-archive\/content$/.test(url),
        ),
      ).toBe(2);
    } finally {
      anchorClick.mockRestore();
    }
  });

  it("removes Chat artifact cards when selected-run attachments disappear from detail state", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    const attachment = makeAttachment({
      id: "att-report",
      name: "report.md",
      mimeType: "text/markdown",
      addedAt: "2026-04-13T05:01:00.000Z",
    });
    installFetchMock({
      runs: [makeRun({ attachmentCount: 1 })],
      details: {
        "run-1": makeDetail({ attachments: [attachment] }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:05:00.000Z",
              prompt: "Prompt",
              transcript: "Created artifact",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    expect(await within(chat).findByText("report.md")).toBeInTheDocument();

    findEventSource("/api/runs/run-1/events/detail").emitMessage({
      type: "detail_updated",
      detail: makeDetail({ attachments: [] }),
    });

    await waitFor(() => {
      expect(within(chat).queryByText("report.md")).not.toBeInTheDocument();
    });
  });

  it("shows a Chat loading skeleton instead of user messages until timeline history loads", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    const timelineHistory = {
      runId: "run-1",
      lastCursor: 1,
      attempts: [
        {
          attemptNumber: 1,
          attemptIndexInSession: 0,
          sessionIndex: 0,
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: "2026-04-13T05:01:00.000Z",
          prompt: "Timeline prompt",
          transcript: "Timeline response",
          notices: "",
          exitCode: 0,
          timedOut: false,
          live: false,
          provenance: { kind: "task_runner" },
        },
      ],
    } satisfies RunTimelineHistory;
    const timelineResponse = () => new Response(JSON.stringify({ history: timelineHistory }));
    let releaseTimeline: (() => void) | undefined;
    let timelineReleased = false;
    installFetchMock(
      {
        runs: [
          makeRun({
            status: "success",
            endedAt: "2026-04-13T05:02:00.000Z",
            currentSession: null,
          }),
        ],
        details: {
          "run-1": makeDetail({
            status: "success",
            isLive: false,
            endedAt: "2026-04-13T05:02:00.000Z",
            message: "Initial dashboard request",
            currentSession: null,
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (!url.endsWith("/api/runs/run-1/timeline") || init?.method) {
            return undefined;
          }
          if (timelineReleased) {
            return timelineResponse();
          }
          return new Promise<Response>((resolve) => {
            releaseTimeline = () => {
              timelineReleased = true;
              resolve(timelineResponse());
            };
          });
        },
      },
    );

    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    expect(await within(chat).findByLabelText("Loading conversation")).toBeInTheDocument();
    expect(within(chat).queryByText("Initial dashboard request")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(releaseTimeline).toBeDefined();
    });

    releaseTimeline?.();

    expect(await within(chat).findByText("Timeline prompt")).toBeInTheDocument();
    expect(
      within(chat).getByText("Timeline prompt").closest(".chat-bubble--system"),
    ).not.toBeNull();
    expect(within(chat).queryByText("Initial dashboard request")).not.toBeInTheDocument();
    expect(await within(chat).findByText("Timeline response")).toBeInTheDocument();
    expect(within(chat).queryByLabelText("Loading conversation")).not.toBeInTheDocument();
  });

  it("renders the attempt prompt as a system card when the run has no user message", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail({
          message: null,
        }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,
              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:01:00.000Z",
              prompt: "Bootstrap **prompt**",
              transcript: "Assistant reply",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
            {
              attemptNumber: 2,
              attemptIndexInSession: 1,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:02:00.000Z",
              endedAt: "2026-04-13T05:03:00.000Z",
              prompt: "Some tasks are not yet completed. Please continue.",
              transcript: "Follow-up reply",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    expect(await within(chat).findAllByText("System")).toHaveLength(2);
    expect(await within(chat).findByText(/Bootstrap/)).toBeInTheDocument();
    expect(within(chat).getByText("prompt").tagName).toBe("STRONG");
    expect(await within(chat).findByText("Assistant reply")).toBeInTheDocument();
    expect(
      await within(chat).findByText("Some tasks are not yet completed. Please continue."),
    ).toBeInTheDocument();
    expect(await within(chat).findByText("Follow-up reply")).toBeInTheDocument();
    expect(within(chat).queryByText(/prior attempt/i)).not.toBeInTheDocument();
  });

  it("submits Chat composer messages through resume and clears the draft on success", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    let resumeBody: { overrides?: { message?: string } } | undefined;
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail({ isLive: false }) },
      },
      {
        handleRequest: (url, init) => {
          if (!url.endsWith("/api/runs/run-1/resume") || init?.method !== "POST") {
            return undefined;
          }
          resumeBody =
            typeof init.body === "string" && init.body.length > 0
              ? (JSON.parse(init.body) as { overrides?: { message?: string } })
              : undefined;
          return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    await user.type(message, "  Continue from chat  ");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton.closest(".chat-composer__surface")).toBe(
      message.closest(".chat-composer__surface"),
    );
    await user.click(sendButton);

    await waitFor(() => {
      expect(resumeBody).toEqual({ overrides: { message: "Continue from chat" } });
    });
    await waitFor(() => {
      expect(message).toHaveValue("");
    });
  });

  it("disables the Chat composer for archived runs", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    installFetchMock({
      runs: [
        makeRun({
          archivedAt: "2026-04-13T06:00:00.000Z",
          capabilities: { canResume: true },
        }),
      ],
      details: {
        "run-1": makeDetail({
          archivedAt: "2026-04-13T06:00:00.000Z",
          capabilities: { canResume: true },
          isLive: false,
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    expect(message).toBeDisabled();
    await user.click(message);
    expect(message).not.toHaveFocus();
    await user.type(message, "archived draft");
    expect(message).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("queues Chat composer messages for live runs and removes queued messages", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    let queueBody: { message?: string } | undefined;
    let removedMessageId: string | undefined;
    installFetchMock(
      {
        runs: [makeRun({ capabilities: { canResume: false }, queuedResumeMessageCount: 0 })],
        details: {
          "run-1": makeDetail({
            capabilities: { canResume: false },
            isLive: true,
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (url.endsWith("/api/runs/run-1/queued-resume-messages") && init?.method === "POST") {
            queueBody =
              typeof init.body === "string" && init.body.length > 0
                ? (JSON.parse(init.body) as { message?: string })
                : undefined;
            return undefined;
          }
          const removeMatch = /\/api\/runs\/run-1\/queued-resume-messages\/([^/]+)$/.exec(url);
          if (removeMatch && init?.method === "DELETE") {
            removedMessageId = decodeURIComponent(removeMatch[1] ?? "");
            return undefined;
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    await user.type(message, "  Check the live logs  ");
    await user.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => {
      expect(queueBody).toEqual({ message: "Check the live logs" });
    });
    await waitFor(() => {
      expect(message).toHaveValue("");
    });

    const queuedPanel = await screen.findByLabelText("Queued messages");
    expect(within(queuedPanel).getByText("Check the live logs")).toBeInTheDocument();
    expect(screen.getAllByLabelText("1 queued message").length).toBeGreaterThan(0);

    await user.click(
      await within(queuedPanel).findByRole("button", { name: /remove queued message qmsg1/i }),
    );

    await waitFor(() => {
      expect(removedMessageId).toBe("qmsg1");
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Queued messages")).not.toBeInTheDocument();
    });
    expect(screen.queryAllByLabelText("1 queued message")).toHaveLength(0);
  });

  it("edits queued Chat composer messages by restoring the draft and removing the queue item", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    let removedMessageId: string | undefined;
    installFetchMock(
      {
        runs: [makeRun({ capabilities: { canResume: false }, queuedResumeMessageCount: 0 })],
        details: {
          "run-1": makeDetail({
            capabilities: { canResume: false },
            isLive: true,
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          const removeMatch = /\/api\/runs\/run-1\/queued-resume-messages\/([^/]+)$/.exec(url);
          if (removeMatch && init?.method === "DELETE") {
            removedMessageId = decodeURIComponent(removeMatch[1] ?? "");
            return undefined;
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    await user.type(message, "Queued edit text");
    await user.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => {
      expect(message).toHaveValue("");
    });

    await user.type(message, "draft to replace");
    const queuedPanel = await screen.findByLabelText("Queued messages");
    await user.click(
      await within(queuedPanel).findByRole("button", { name: /edit queued message qmsg1/i }),
    );

    expect(message).toHaveValue("Queued edit text");
    expect(message).toHaveFocus();
    await waitFor(() => {
      expect(removedMessageId).toBe("qmsg1");
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Queued messages")).not.toBeInTheDocument();
    });
  });

  it("preserves the Chat composer draft and shows the API error after queue failure", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    installFetchMock(
      {
        runs: [makeRun({ capabilities: { canResume: false } })],
        details: {
          "run-1": makeDetail({
            capabilities: { canResume: false },
            isLive: true,
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (!url.endsWith("/api/runs/run-1/queued-resume-messages") || init?.method !== "POST") {
            return undefined;
          }
          return new Response(JSON.stringify({ error: { message: "queue temporarily failed" } }), {
            status: 500,
          });
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    await user.type(message, "retry queue");
    await user.click(screen.getByRole("button", { name: "Queue" }));

    const chat = await screen.findByLabelText("Run chat");
    expect(await within(chat).findAllByText("queue temporarily failed")).not.toHaveLength(0);
    expect(message).toHaveValue("retry queue");
  });

  it("clears queued Chat messages when the detail stream delivers an empty queue", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    const queuedResumeMessage = {
      id: "qmsg1",
      text: "Already queued",
      createdAt: "2026-04-30T15:20:00.000Z",
    };
    installFetchMock({
      runs: [makeRun({ capabilities: { canResume: false }, queuedResumeMessageCount: 1 })],
      details: {
        "run-1": makeDetail({
          capabilities: { canResume: false },
          isLive: true,
          queuedResumeMessages: [queuedResumeMessage],
        }),
      },
    });

    await renderApp("/runs/run-1");

    expect(await screen.findByLabelText("Queued messages")).toBeInTheDocument();
    expect(screen.getByText("Already queued")).toBeInTheDocument();

    findEventSource("/api/runs/run-1/events/detail").emitMessage({
      type: "detail_updated",
      detail: makeDetail({
        capabilities: { canResume: false },
        isLive: true,
        queuedResumeMessages: [],
      }),
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued messages")).not.toBeInTheDocument();
    });
    expect(screen.queryAllByLabelText("1 queued message")).toHaveLength(0);
  });

  it("refreshes selected-run Chat history when a queued resume starts from an empty timeline", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    const queuedResumeMessage = {
      id: "qmsg1",
      text: "Already queued",
      createdAt: "2026-04-30T15:20:00.000Z",
    };
    const baseSession = makeDetail().sessions[0];
    if (!baseSession) {
      throw new Error("expected base session");
    }
    const firstSession: RunSessionSummary = {
      ...baseSession,
      status: "success" as const,
      endedAt: "2026-04-13T05:02:00.000Z",
      exitCode: 0,
      message: null,
    };
    const resumedSession: RunSessionSummary = {
      ...firstSession,
      sessionIndex: 1,
      status: "running" as const,
      startedAt: "2026-04-13T05:03:00.000Z",
      endedAt: null,
      exitCode: null,
      message: "Already queued",
      firstAttemptNumber: 2,
      lastAttemptNumber: 2,
      attemptCount: 1,
    };
    const timelineHistory: RunTimelineHistory = {
      runId: "run-1",
      lastCursor: 0,
      attempts: [],
    };
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          status: "success",
          effectiveStatus: "success",
          endedAt: "2026-04-13T05:02:00.000Z",
          currentSession: null,
          lastSession: firstSession,
          queuedResumeMessageCount: 1,
          capabilities: { canResume: true },
        }),
      ],
      details: {
        "run-1": makeDetail({
          status: "success",
          effectiveStatus: "success",
          isLive: false,
          endedAt: "2026-04-13T05:02:00.000Z",
          exitCode: 0,
          sessions: [firstSession],
          currentSession: null,
          lastSession: firstSession,
          queuedResumeMessages: [queuedResumeMessage],
          capabilities: { canResume: true },
        }),
      },
      timelineHistories: {
        "run-1": timelineHistory,
      },
    });

    await renderApp("/runs/run-1");

    const chat = await screen.findByLabelText("Run chat");
    expect(await screen.findByLabelText("Queued messages")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(1);
    });

    timelineHistory.lastCursor = 2;
    timelineHistory.attempts = [
      {
        attemptNumber: 2,
        attemptIndexInSession: 0,
        sessionIndex: 1,
        startedAt: "2026-04-13T05:03:00.000Z",
        endedAt: null,
        prompt: "Already queued",
        transcript: "Queued answer",
        notices: "",
        exitCode: null,
        timedOut: false,
        live: true,
        provenance: { kind: "task_runner" },
      },
    ];
    findEventSource("/api/runs/run-1/events/detail").emitMessage({
      type: "detail_updated",
      detail: makeDetail({
        status: "running",
        effectiveStatus: "running",
        isLive: true,
        endedAt: null,
        exitCode: null,
        totalAttemptCount: 2,
        totalSessionCount: 2,
        sessions: [firstSession, resumedSession],
        currentSession: resumedSession,
        lastSession: resumedSession,
        queuedResumeMessages: [],
        capabilities: { canAbort: true, canResume: false },
      }),
    });

    await waitFor(() => {
      expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(2);
    });
    expect(screen.queryByLabelText("Queued messages")).not.toBeInTheDocument();
    expect(await within(chat).findByText("Already queued")).toBeInTheDocument();
    expect(await within(chat).findByText("Queued answer")).toBeInTheDocument();
  });

  it("submits Chat composer messages with Command+Enter", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    let resumeBody: { overrides?: { message?: string } } | undefined;
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail({ isLive: false }) },
      },
      {
        handleRequest: (url, init) => {
          if (!url.endsWith("/api/runs/run-1/resume") || init?.method !== "POST") {
            return undefined;
          }
          resumeBody =
            typeof init.body === "string" && init.body.length > 0
              ? (JSON.parse(init.body) as { overrides?: { message?: string } })
              : undefined;
          return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    await user.type(message, "  Continue with shortcut  ");
    fireEvent.keyDown(message, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(resumeBody).toEqual({ overrides: { message: "Continue with shortcut" } });
    });
    await waitFor(() => {
      expect(message).toHaveValue("");
    });
  });

  it("blurs the Chat composer on Escape before closing the selected run", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    await user.type(message, "draft stays");
    expect(message).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(message).not.toHaveFocus();
    expect(message).toHaveValue("draft stays");
    expect(screen.getByRole("tablist", { name: "Run surface" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("tablist", { name: "Run surface" })).not.toBeInTheDocument();
    });
  });

  it("keeps the Chat composer editable for selected runs that cannot submit", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    let resumeRequestCount = 0;
    installFetchMock(
      {
        runs: [makeRun()],
        details: {
          "run-1": makeDetail({
            isLive: false,
            capabilities: {
              canResume: false,
            },
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (url.endsWith("/api/runs/run-1/resume") && init?.method === "POST") {
            resumeRequestCount += 1;
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    expect(message).not.toHaveAttribute("placeholder");
    await user.type(message, "draft for later");
    expect(message).toHaveValue("draft for later");

    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();
    fireEvent.keyDown(message, { key: "Enter", metaKey: true });
    expect(resumeRequestCount).toBe(0);
  });

  it("preserves the Chat composer draft and shows the API error after resume failure", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail({ isLive: false }) },
      },
      {
        handleRequest: (url, init) => {
          if (!url.endsWith("/api/runs/run-1/resume") || init?.method !== "POST") {
            return undefined;
          }
          return new Response(JSON.stringify({ error: { message: "resume temporarily failed" } }), {
            status: 500,
          });
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    await user.type(message, "retry this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const chat = await screen.findByLabelText("Run chat");
    expect(await within(chat).findAllByText("resume temporarily failed")).not.toHaveLength(0);
    expect(message).toHaveValue("retry this");
  });

  it("does not show a failed Chat resume error after the selected run changes", async () => {
    setStoredDashboardViewState({ activeRightSurface: "chat" });
    let resolveResume: ((response: Response) => void) | undefined;
    installFetchMock(
      {
        runs: [
          makeRun({ runId: "run-1", name: "First run", assignmentName: "First run" }),
          makeRun({ runId: "run-2", name: "Second run", assignmentName: "Second run" }),
        ],
        details: {
          "run-1": makeDetail({ runId: "run-1", name: "First run", isLive: false }),
          "run-2": makeDetail({ runId: "run-2", name: "Second run", isLive: false }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (!url.endsWith("/api/runs/run-1/resume") || init?.method !== "POST") {
            return undefined;
          }
          return new Promise<Response>((resolve) => {
            resolveResume = resolve;
          });
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/run-1");

    const message = await screen.findByLabelText("Message");
    await waitFor(() => {
      expect(message).toBeEnabled();
    });
    await user.type(message, "resume first run");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(resolveResume).toBeDefined();
    });

    await user.click(await findRunCard("Second run"));
    const secondRunChat = await screen.findByLabelText("Run chat");
    expect(screen.getAllByText("Second run").length).toBeGreaterThan(0);
    expect(secondRunChat).toBeInTheDocument();
    const secondRunMessage = screen.getByLabelText("Message");
    await user.type(secondRunMessage, "resume second run");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();

    resolveResume?.(
      new Response(JSON.stringify({ error: { message: "resume temporarily failed" } }), {
        status: 500,
      }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Message")).toBeEnabled();
    });
    expect(
      within(screen.getByLabelText("Run chat")).queryByText("resume temporarily failed"),
    ).toBeNull();
  });

  it("renders attempt history in the attempts tab with nested scroll-follow behavior", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 3,
          attempts: [
            {
              attemptNumber: 1,

              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "Initial prompt",
              transcript: "Attempt one output\n",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
            {
              attemptNumber: 2,

              attemptIndexInSession: 0,
              sessionIndex: 1,
              startedAt: "2026-04-13T05:03:00.000Z",
              endedAt: null,
              prompt: "## Continue working",
              transcript: "Streaming",
              notices: "\n\n- warning\n",
              exitCode: null,
              timedOut: false,
              live: true,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();

    expect(screen.getByRole("button", { name: "Attempts" })).toBeInTheDocument();
    const sessionTabs = await screen.findByRole("tablist", { name: "Sessions" });
    expect(within(sessionTabs).getByRole("tab", { name: "Session 1" })).toHaveTextContent("1");
    expect(within(sessionTabs).getByRole("tab", { name: "Session 2" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByText(/initial run/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/follow-up/i)).not.toBeInTheDocument();

    const detail = screen.getByLabelText("Run detail");
    const stickyControls = detail.querySelector(".timeline-sticky-controls");
    expect(stickyControls).not.toBeNull();
    expect(stickyControls?.querySelector('[role="tablist"][aria-label="Sessions"]')).not.toBeNull();
    expect(stickyControls?.querySelector('[role="tablist"][aria-label="Attempts"]')).toBeNull();
    expect(
      stickyControls?.querySelector('[role="tablist"][aria-label="Attempt view"]'),
    ).not.toBeNull();

    expect(screen.getByRole("tab", { name: "Response" })).toHaveAttribute("aria-selected", "true");
    const response = await screen.findByRole("region", { name: "Attempt response" });
    expect(response).toHaveTextContent("Streaming");
    expect(response).not.toHaveTextContent("warning");

    const scrollRegion = setTimelineScrollGeometry({
      clientHeight: 120,
      scrollHeight: 280,
      scrollTop: 160,
    });
    expect(scrollRegion.querySelector('[aria-label="Attempt response"]')).not.toBeNull();

    await user.click(await screen.findByRole("tab", { name: "Prompt" }));
    const prompt = screen.getByRole("region", { name: "Attempt prompt" });
    expect(
      within(prompt).getByRole("heading", { level: 2, name: "Continue working" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));
    const diagnostics = screen.getByRole("region", { name: "Attempt diagnostics" });
    expect(diagnostics).toHaveTextContent("warning");
    expect(diagnostics).not.toHaveTextContent("Streaming");

    await user.click(screen.getByRole("tab", { name: "Response" }));
    setTimelineScrollGeometry({
      clientHeight: 120,
      scrollHeight: 280,
      scrollTop: 160,
    });
    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 4,
      event: {
        type: "agent_message_delta",
        text: " live",
      },
    });
    defineElementMetric(scrollRegion, "scrollHeight", 360);

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Attempt response" })).toHaveTextContent(
        "Streaming live",
      );
    });
    await waitFor(() => {
      expect(scrollRegion.scrollTop).toBe(240);
    });

    defineElementMetric(scrollRegion, "scrollTop", 32);
    scrollRegion.dispatchEvent(new Event("scroll"));

    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 5,
      event: {
        type: "agent_message_delta",
        text: " detached",
      },
    });
    defineElementMetric(scrollRegion, "scrollHeight", 420);

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Attempt response" })).toHaveTextContent(
        "Streaming live detached",
      );
    });
    expect(scrollRegion.scrollTop).toBe(32);
  });

  it("shows a pending attempt preview before the first attempt starts", async () => {
    installFetchMock({
      runs: [
        makeRun({
          status: "initialized",
          effectiveStatus: "initialized",
          activeTask: null,
        }),
      ],
      details: {
        "run-1": makeDetail({
          status: "initialized",
          effectiveStatus: "initialized",
          isLive: false,
          activeTask: null,
          totalAttemptCount: 0,
          totalSessionCount: 0,
          message: "Review this handoff before launch.",
          pendingPrompt: "## Prepared prompt",
        }),
      },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 0,
          attempts: [],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    expect(await screen.findByRole("tab", { name: "Pending" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Attempts" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Attempt view" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Message" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Prompt" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Response" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Diagnostics" })).toBeInTheDocument();
    expect(screen.getByText("Review this handoff before launch.")).toBeInTheDocument();

    await user.click(await screen.findByRole("tab", { name: "Prompt" }));
    expect(screen.getByRole("heading", { level: 2, name: "Prepared prompt" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Response" }));
    expect(screen.getByText("No response yet — this run has not started.")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));
    expect(screen.getByText("No diagnostics yet — this run has not started.")).toBeInTheDocument();

    const detailSource = findEventSource("/api/runs/run-1/events/detail");
    detailSource.emitOpen();
    detailSource.emitMessage({
      type: "detail_updated",
      detail: makeDetail({
        status: "running",
        effectiveStatus: "running",
        isLive: true,
        totalAttemptCount: 1,
        totalSessionCount: 1,
        message: "Review this handoff before launch.",
        pendingPrompt: null,
      }),
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Response" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    expect(screen.getByText("Waiting for live response text…")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Live" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Pending" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(findEventSource("/api/runs/run-1/events/timeline")).toBeDefined();
    });
    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();
    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 1,
      event: {
        type: "attempt_started",
        attemptNumber: 1,

        attemptIndexInSession: 0,
        sessionIndex: 0,
        startedAt: "2026-04-13T05:00:00.000Z",
        prompt: "## Attempt prompt",
      },
    });

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: "Pending" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: "Message" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Response" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    expect(screen.getByText("Waiting for live response text…")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Message" }));
    expect(screen.getByRole("tab", { name: "Message" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Run message")).toHaveTextContent(
      "Review this handoff before launch.",
    );

    await user.click(await screen.findByRole("tab", { name: "Prompt" }));
    expect(screen.getByRole("heading", { level: 2, name: "Attempt prompt" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));
    expect(screen.getByText("No diagnostics have arrived yet.")).toBeInTheDocument();
  });

  it("moves to a hidden live response while a completed run resume waits for timeline history", async () => {
    const completedSession = {
      sessionIndex: 0,
      status: "success",
      startedAt: "2026-04-13T05:00:00.000Z",
      endedAt: "2026-04-13T05:02:00.000Z",
      exitCode: 0,
      message: null,
      firstAttemptNumber: 1,
      lastAttemptNumber: 1,
      attemptCount: 1,
      maxAttemptsPerSession: 3,
      backendSessionIdAtStart: "thread-1",
      backendSessionIdAtEnd: "thread-1",
    } satisfies RunDetail["sessions"][number];
    const runningSession = {
      sessionIndex: 1,
      status: "running",
      startedAt: "2026-04-13T05:03:00.000Z",
      endedAt: null,
      exitCode: null,
      message: null,
      firstAttemptNumber: 2,
      lastAttemptNumber: 2,
      attemptCount: 1,
      maxAttemptsPerSession: 3,
      backendSessionIdAtStart: "thread-2",
      backendSessionIdAtEnd: null,
    } satisfies RunDetail["sessions"][number];
    const timelineHistory: RunTimelineHistory = {
      runId: "run-1",
      lastCursor: 1,
      attempts: [
        {
          attemptNumber: 1,

          attemptIndexInSession: 0,
          sessionIndex: 0,
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: "2026-04-13T05:02:00.000Z",
          prompt: "Initial prompt",
          transcript: "Completed attempt",
          notices: "",
          exitCode: 0,
          timedOut: false,
          live: false,
          provenance: { kind: "task_runner" },
        },
      ],
    };
    let resolveSecondTimeline: ((response: Response | PromiseLike<Response>) => void) | undefined;
    let timelineRequestCount = 0;

    const fetchMock = installFetchMock(
      {
        runs: [
          makeRun({
            status: "success",
            effectiveStatus: "success",
            endedAt: "2026-04-13T05:02:00.000Z",
            totalAttemptCount: 1,
            totalSessionCount: 1,
            currentSession: null,
            lastSession: completedSession,
            activeTask: null,
          }),
        ],
        details: {
          "run-1": makeDetail({
            status: "success",
            effectiveStatus: "success",
            isLive: false,
            endedAt: "2026-04-13T05:02:00.000Z",
            totalAttemptCount: 1,
            totalSessionCount: 1,
            sessions: [completedSession],
            currentSession: null,
            lastSession: completedSession,
            activeTask: null,
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (!url.endsWith("/api/runs/run-1/timeline")) {
            return undefined;
          }
          timelineRequestCount += 1;
          if (timelineRequestCount === 1) {
            return new Response(JSON.stringify({ history: timelineHistory }), { status: 200 });
          }
          return new Promise<Response>((resolve) => {
            resolveSecondTimeline = resolve;
          });
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(0);
    expect(hasEventSource("/api/runs/run-1/events/timeline")).toBe(false);
    expect(hasEventSource("/api/runs/run-1/events/audit")).toBe(false);

    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Attempts" }));
    expect(await screen.findByRole("region", { name: "Attempt response" })).toHaveTextContent(
      "Completed attempt",
    );
    expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(1);
    expect(hasEventSource("/api/runs/run-1/events/timeline")).toBe(true);
    expect(hasEventSource("/api/runs/run-1/events/audit")).toBe(false);

    const detailSource = findEventSource("/api/runs/run-1/events/detail");
    detailSource.emitOpen();
    detailSource.emitMessage({
      type: "detail_updated",
      detail: makeDetail({
        status: "running",
        effectiveStatus: "running",
        isLive: true,
        endedAt: null,
        totalAttemptCount: 2,
        totalSessionCount: 2,
        sessions: [completedSession, runningSession],
        currentSession: runningSession,
        lastSession: runningSession,
        activeTask: {
          id: "resume",
          title: "Resume run",
        },
      }),
    });

    await waitFor(() => {
      expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(2);
    });
    expect(screen.getByRole("tab", { name: "Response" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Waiting for live response text…")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Live" })).not.toBeInTheDocument();
    expect(hasEventSource("/api/runs/run-1/events/audit")).toBe(false);

    await user.click(screen.getByRole("tab", { name: "Message" }));
    expect(screen.getByRole("tab", { name: "Message" })).toHaveAttribute("aria-selected", "true");

    const firstAttempt = timelineHistory.attempts[0];
    if (!firstAttempt) {
      throw new Error("expected first attempt");
    }
    timelineHistory.lastCursor = 2;
    timelineHistory.attempts = [
      firstAttempt,
      {
        attemptNumber: 2,

        attemptIndexInSession: 0,
        sessionIndex: 1,
        startedAt: "2026-04-13T05:03:00.000Z",
        endedAt: null,
        prompt: "## Resume prompt",
        transcript: "",
        notices: "",
        exitCode: null,
        timedOut: false,
        live: true,
        provenance: { kind: "task_runner" },
      },
    ];
    if (!resolveSecondTimeline) {
      throw new Error("expected deferred timeline history request");
    }
    resolveSecondTimeline(
      new Response(JSON.stringify({ history: timelineHistory }), { status: 200 }),
    );

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Session 2" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();
    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 3,
      event: {
        type: "agent_message_delta",
        text: "Resumed response",
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Attempt response" })).toHaveTextContent(
        "Resumed response",
      );
    });
    expect(fetchCallCount(fetchMock, (url) => url.endsWith("/api/runs/run-1/timeline"))).toBe(2);
    expect(hasEventSource("/api/runs/run-1/events/audit")).toBe(false);
  });

  it("auto-selects a newly started attempt and switches to response while viewing attempts", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 2,
          attempts: [
            {
              attemptNumber: 1,

              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "Initial prompt",
              transcript: "Attempt one output\n",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
            {
              attemptNumber: 2,

              attemptIndexInSession: 0,
              sessionIndex: 1,
              startedAt: "2026-04-13T05:03:00.000Z",
              endedAt: null,
              prompt: "## Continue working",
              transcript: "Streaming",
              notices: "",
              exitCode: null,
              timedOut: false,
              live: true,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();

    await user.click(await screen.findByRole("tab", { name: "Prompt" }));
    expect(screen.getByRole("heading", { level: 2, name: "Continue working" })).toBeInTheDocument();

    timelineSource.emitMessage({
      runId: "run-1",
      cursor: 3,
      event: {
        type: "attempt_started",
        attemptNumber: 3,

        attemptIndexInSession: 0,
        sessionIndex: 2,
        startedAt: "2026-04-13T05:04:00.000Z",
        prompt: "## Third prompt",
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Session 3" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    expect(screen.getByRole("tab", { name: "Response" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Waiting for live response text…")).toBeInTheDocument();
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
              attemptNumber: 1,

              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "Prompt",
              transcript: "nullable access:",
              notices: "Good - assignment is indeed nullable on RunDetail.\n\nNow the next note.",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();

    const response = await screen.findByRole("region", { name: "Attempt response" });
    expect(response).toHaveTextContent("nullable access:");
    expect(response).not.toHaveTextContent("Good - assignment is indeed nullable on RunDetail.");

    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));
    const diagnostics = screen.getByRole("region", { name: "Attempt diagnostics" });
    expect(
      within(diagnostics).getByText("Good - assignment is indeed nullable on RunDetail."),
    ).toBeInTheDocument();
    expect(within(diagnostics).getByText("Now the next note.")).toBeInTheDocument();
    expect(diagnostics).not.toHaveTextContent("nullable access:");
  });

  it("shows split empty states for completed attempts without transcript or diagnostics", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
      timelineHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          attempts: [
            {
              attemptNumber: 1,

              attemptIndexInSession: 0,
              sessionIndex: 0,
              startedAt: "2026-04-13T05:00:00.000Z",
              endedAt: "2026-04-13T05:02:00.000Z",
              prompt: "Prompt",
              transcript: "",
              notices: "",
              exitCode: 0,
              timedOut: false,
              live: false,
              provenance: { kind: "task_runner" },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();

    expect(
      await screen.findByText("This attempt produced no transcript response."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));
    expect(screen.getByText("This attempt produced no diagnostics.")).toBeInTheDocument();
  });

  it("uses a scrollable single-line run-section tab strip in the drawer", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(await screen.findByRole("tab", { name: "Info" }));

    const runSections = await screen.findByRole("navigation", { name: "Run sections" });
    expect(runSections).toHaveClass("tabs", "tabs--scrollable");
    expect(runSections.querySelectorAll(":scope > .tab")).toHaveLength(5);
    expect(
      [...runSections.querySelectorAll(":scope > .tab")].map((tab) =>
        tab.textContent?.replace(/\s+\S+\/\S+$/, "").trim(),
      ),
    ).toEqual(["Attachments", "Attempts", "Audit", "Data", "Dependencies"]);
  });

  it("omits Attempts but keeps Audit and Data in the passive run-section tab strip", async () => {
    installFetchMock({
      runs: [makeRun({ backend: "passive" })],
      details: {
        "run-1": makeDetail({
          backend: "passive",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(await screen.findByRole("tab", { name: "Info" }));

    const runSections = await screen.findByRole("navigation", { name: "Run sections" });
    expect(runSections.querySelectorAll(":scope > .tab")).toHaveLength(4);
    expect(
      [...runSections.querySelectorAll(":scope > .tab")].map((tab) =>
        tab.textContent?.replace(/\s+\S+\/\S+$/, "").trim(),
      ),
    ).toEqual(["Attachments", "Audit", "Data", "Dependencies"]);
    expect(within(runSections).getByRole("button", { name: "Audit" })).toBeInTheDocument();
    expect(within(runSections).getByRole("button", { name: "Data" })).toBeInTheDocument();
    expect(within(runSections).queryByRole("button", { name: "Attempts" })).not.toBeInTheDocument();
  });

  it("toggles audit ordering globally and keeps audit appends at the top in newest-first mode for non-live runs", async () => {
    installFetchMock({
      runs: [
        makeRun({
          activeTask: null,
          effectiveStatus: "success",
          endedAt: "2026-04-21T16:05:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          effectiveStatus: "success",
          endedAt: "2026-04-21T16:05:00.000Z",
          isLive: false,
          status: "success",
        }),
      },
      auditHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 2,
          events: [
            {
              runId: "run-1",
              cursor: 1,
              event: {
                type: "task.added",
                recordedAt: "2026-04-21T16:00:00.000Z",
                source: "task_command",
                hostMode: "embedded",
                fields: {
                  taskId: "task-old",
                  taskTitle: "Old task",
                },
              },
            },
            {
              runId: "run-1",
              cursor: 2,
              event: {
                type: "task.added",
                recordedAt: "2026-04-21T16:01:00.000Z",
                source: "task_command",
                hostMode: "embedded",
                fields: {
                  taskId: "task-new",
                  taskTitle: "New task",
                },
              },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));
    const auditSource = findEventSource("/api/runs/run-1/events/audit");
    auditSource.emitOpen();

    const auditPanel = await screen.findByLabelText("Audit");
    await waitFor(() =>
      expect(within(auditPanel).getByRole("button", { name: "Oldest first" })).toBeInTheDocument(),
    );

    let rows = within(within(auditPanel).getByRole("list", { name: "Audit events" })).getAllByRole(
      "listitem",
    );
    expect(rows[0]).toHaveTextContent("Old task");
    expect(rows[1]).toHaveTextContent("New task");

    await user.click(within(auditPanel).getByRole("button", { name: "Oldest first" }));
    expect(within(auditPanel).getByRole("button", { name: "Newest first" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    rows = within(within(auditPanel).getByRole("list", { name: "Audit events" })).getAllByRole(
      "listitem",
    );
    expect(rows[0]).toHaveTextContent("New task");
    expect(rows[1]).toHaveTextContent("Old task");
    expect(window.localStorage.getItem("agent-runner:web:dashboard-preferences")).toContain(
      '"auditNewestFirst":true',
    );

    auditSource.emitMessage({
      runId: "run-1",
      cursor: 3,
      event: {
        type: "task.added",
        recordedAt: "2026-04-21T16:02:00.000Z",
        source: "task_command",
        hostMode: "embedded",
        fields: {
          taskId: "task-live",
          taskTitle: "Live task",
        },
      },
    });

    await waitFor(() => {
      const updatedRows = within(
        within(auditPanel).getByRole("list", { name: "Audit events" }),
      ).getAllByRole("listitem");
      expect(updatedRows[0]).toHaveTextContent("Live task");
      expect(updatedRows[1]).toHaveTextContent("New task");
      expect(updatedRows[2]).toHaveTextContent("Old task");
    });
  });

  it("renders hook audit events with resolved hook names, task titles, and summaries", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail({
          resolvedHooks: [
            {
              hookId: "taskTransition:0:require-children-success",
              phase: "taskTransition",
              source: {
                name: "require-children-success",
              },
              resolvedPath: null,
              taskScopeId: null,
              when: null,
              config: {},
            },
          ],
          tasks: [
            {
              id: "apply_review_fixes",
              title: "Apply review fixes",
              body: "Update the code",
              status: "in_progress",
              notes: "",
            },
          ],
          activeTask: {
            id: "apply_review_fixes",
            title: "Apply review fixes",
          },
        }),
      },
      auditHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 1,
          events: [
            {
              runId: "run-1",
              cursor: 1,
              event: {
                type: "run.hook_recorded",
                recordedAt: "2026-04-21T16:00:00.000Z",
                source: "system",
                hostMode: "embedded",
                fields: {
                  phase: "taskTransition",
                  hookId: "taskTransition:0:require-children-success",
                  outcome: "rejected",
                  taskId: "apply_review_fixes",
                  summary: "Child runs are incomplete",
                },
              },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));
    const auditSource = findEventSource("/api/runs/run-1/events/audit");
    auditSource.emitOpen();

    const auditPanel = await screen.findByLabelText("Audit");
    const rows = within(
      within(auditPanel).getByRole("list", { name: "Audit events" }),
    ).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent(
      "Hook require-children-success rejected task transition for Apply review fixes: Child runs are incomplete.",
    );
  });

  it("filters audit events by hooks, tasks, and run types", async () => {
    installFetchMock({
      runs: [
        makeRun({
          effectiveStatus: "success",
          endedAt: "2026-04-21T16:05:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          effectiveStatus: "success",
          endedAt: "2026-04-21T16:05:00.000Z",
          isLive: false,
          resolvedHooks: [
            {
              hookId: "taskTransition:0:require-children-success",
              phase: "taskTransition",
              source: { name: "require-children-success" },
              resolvedPath: null,
              taskScopeId: null,
              when: null,
              config: {},
            },
          ],
          status: "success",
          tasks: [
            {
              id: "apply_review_fixes",
              title: "Apply review fixes",
              body: "Update the code",
              status: "completed",
              notes: "",
            },
          ],
        }),
      },
      auditHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 3,
          events: [
            {
              runId: "run-1",
              cursor: 1,
              event: {
                type: "run.hook_recorded",
                recordedAt: "2026-04-21T16:00:00.000Z",
                source: "system",
                hostMode: "embedded",
                fields: {
                  phase: "taskTransition",
                  hookId: "taskTransition:0:require-children-success",
                  outcome: "accepted",
                  taskId: "apply_review_fixes",
                },
              },
            },
            {
              runId: "run-1",
              cursor: 2,
              event: {
                type: "task.updated",
                recordedAt: "2026-04-21T16:01:00.000Z",
                source: "task_command",
                hostMode: "embedded",
                fields: {
                  taskId: "apply_review_fixes",
                  taskTitle: "Apply review fixes",
                  command: "set",
                  statusBefore: "in_progress",
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
                recordedAt: "2026-04-21T16:02:00.000Z",
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
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));
    const auditSource = findEventSource("/api/runs/run-1/events/audit");
    auditSource.emitOpen();

    const auditPanel = await screen.findByLabelText("Audit");
    const auditList = within(auditPanel).getByRole("list", { name: "Audit events" });

    expect(within(auditList).getAllByRole("listitem")).toHaveLength(3);

    await user.click(within(auditPanel).getByRole("tab", { name: "Hooks" }));
    expect(within(auditList).getAllByRole("listitem")).toHaveLength(1);
    expect(auditList).toHaveTextContent(
      "Hook require-children-success accepted task transition for Apply review fixes.",
    );

    await user.click(within(auditPanel).getByRole("tab", { name: "Tasks" }));
    expect(within(auditList).getAllByRole("listitem")).toHaveLength(1);
    expect(auditList).toHaveTextContent("Updated task Apply review fixes");

    await user.click(within(auditPanel).getByRole("tab", { name: "Run" }));
    expect(within(auditList).getAllByRole("listitem")).toHaveLength(1);
    expect(auditList).toHaveTextContent("Finished run as completed with 1/1 tasks complete.");

    await user.click(within(auditPanel).getByRole("tab", { name: "All" }));
    expect(within(auditList).getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows an empty state when the active audit filter has no matching events", async () => {
    installFetchMock({
      runs: [
        makeRun({
          effectiveStatus: "success",
          endedAt: "2026-04-21T16:05:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          effectiveStatus: "success",
          endedAt: "2026-04-21T16:05:00.000Z",
          isLive: false,
          resolvedHooks: [
            {
              hookId: "taskTransition:task:attach_artifacts:0:require-implementation-brief",
              phase: "taskTransition",
              source: { name: "require-implementation-brief" },
              resolvedPath: null,
              taskScopeId: "attach_artifacts",
              when: null,
              config: {},
            },
          ],
          status: "success",
          tasks: [
            {
              id: "attach_artifacts",
              title: "Attach the approved draft artifacts to the planning run",
              body: "Attach assignment-summary.md",
              status: "completed",
              notes: "",
            },
          ],
        }),
      },
      auditHistories: {
        "run-1": {
          runId: "run-1",
          lastCursor: 2,
          events: [
            {
              runId: "run-1",
              cursor: 1,
              event: {
                type: "run.hook_recorded",
                recordedAt: "2026-04-21T16:00:00.000Z",
                source: "task_command",
                hostMode: "embedded",
                fields: {
                  phase: "taskTransition",
                  hookId: "taskTransition:task:attach_artifacts:0:require-implementation-brief",
                  outcome: "accepted",
                  taskId: "attach_artifacts",
                },
              },
            },
            {
              runId: "run-1",
              cursor: 2,
              event: {
                type: "task.updated",
                recordedAt: "2026-04-21T16:01:00.000Z",
                source: "task_command",
                hostMode: "embedded",
                fields: {
                  taskId: "attach_artifacts",
                  taskTitle: "Attach the approved draft artifacts to the planning run",
                  command: "set",
                  statusBefore: "in_progress",
                  statusAfter: "completed",
                  notesChanged: false,
                },
              },
            },
          ],
        },
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));
    const auditSource = findEventSource("/api/runs/run-1/events/audit");
    auditSource.emitOpen();

    const auditPanel = await screen.findByLabelText("Audit");
    await user.click(within(auditPanel).getByRole("tab", { name: "Run" }));

    expect(within(auditPanel).getByText("No audit events match this filter")).toBeInTheDocument();
    expect(
      within(auditPanel).getByText(
        "Change the audit filter to view the other persisted events for this run.",
      ),
    ).toBeInTheDocument();
  });

  it("renders read-only vars and hook state data with local subtabs", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail({
          runtimeVars: {
            token: "token-123",
            count: 3,
            config: {
              enabled: true,
              retries: 2,
            },
          },
          hookState: {
            lastRun: {
              status: "ready",
            },
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("button", { name: "Data" }));

    const dataPanel = screen.getByLabelText("Data");
    const dataTabs = within(dataPanel).getByRole("tablist", { name: "Data view" });
    const varsTable = within(dataPanel).getByRole("table", { name: "Vars" });
    expect(within(dataTabs).getByRole("tab", { name: "Vars" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(varsTable).getByRole("columnheader", { name: "Key" })).toBeInTheDocument();
    expect(within(varsTable).getByRole("columnheader", { name: "Value" })).toBeInTheDocument();
    expect(within(varsTable).getByRole("rowheader", { name: "token" })).toBeInTheDocument();
    expect(within(varsTable).getByText("token-123")).toBeInTheDocument();
    expect(within(varsTable).getByRole("rowheader", { name: "config" })).toBeInTheDocument();
    expect(
      within(varsTable).getByText(/\{\s+"enabled": true,\s+"retries": 2\s+\}/s),
    ).toBeInTheDocument();
    expect(within(dataPanel).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(dataPanel).queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(
      within(dataPanel).queryByRole("button", { name: "Add dependency" }),
    ).not.toBeInTheDocument();

    await user.click(within(dataTabs).getByRole("tab", { name: "Hook state" }));

    const hookStateTable = within(dataPanel).getByRole("table", { name: "Hook state" });
    expect(within(dataTabs).getByRole("tab", { name: "Hook state" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(hookStateTable).getByRole("rowheader", { name: "lastRun" })).toBeInTheDocument();
    expect(within(hookStateTable).getByText(/\{\s+"status": "ready"\s+\}/s)).toBeInTheDocument();
  });

  it("edits reconfigurable vars and omits unchanged redacted values", async () => {
    const reconfigureBodies: Array<{ vars?: Record<string, string>; message?: string }> = [];
    installFetchMock(
      {
        runs: [
          makeRun({
            status: "initialized",
            totalAttemptCount: 0,
            totalSessionCount: 0,
            currentSession: null,
            lastSession: null,
            capabilities: {
              canArchive: true,
              canReady: true,
              canResume: false,
              canReconfigure: true,
            },
          }),
        ],
        details: {
          "run-1": makeDetail({
            status: "initialized",
            isLive: false,
            totalAttemptCount: 0,
            totalSessionCount: 0,
            sessions: [],
            currentSession: null,
            lastSession: null,
            activeTask: null,
            runtimeVars: {
              target: "alpha",
              secret: {
                redacted: true,
                source: "env",
                envName: "SECRET_TOKEN",
              },
            },
            capabilities: {
              canArchive: true,
              canReady: true,
              canResume: false,
              canReconfigure: true,
            },
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (url.endsWith("/api/runs/run-1/reconfigure") && init?.method === "POST") {
            reconfigureBodies.push(JSON.parse(init.body as string));
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("button", { name: "Data" }));

    const dataPanel = screen.getByLabelText("Data");
    await user.click(within(dataPanel).getByRole("button", { name: "Edit run vars" }));
    await user.clear(within(dataPanel).getByLabelText("Value for target"));
    await user.type(within(dataPanel).getByLabelText("Value for target"), "beta");
    expect(within(dataPanel).getByLabelText("Value for secret")).toBeDisabled();

    await user.click(within(dataPanel).getByRole("button", { name: "Save vars" }));

    await waitFor(() => expect(within(dataPanel).getByText("beta")).toBeInTheDocument());
    expect(reconfigureBodies).toEqual([{ vars: { target: "beta" } }]);
  });

  it("edits the initial run message only when reconfigure is available", async () => {
    const reconfigureBodies: Array<{ vars?: Record<string, string>; message?: string }> = [];
    installFetchMock(
      {
        runs: [
          makeRun({
            status: "initialized",
            totalAttemptCount: 0,
            totalSessionCount: 0,
            currentSession: null,
            lastSession: null,
            capabilities: {
              canArchive: true,
              canReady: true,
              canResume: false,
              canReconfigure: true,
            },
          }),
        ],
        details: {
          "run-1": makeDetail({
            status: "initialized",
            isLive: false,
            totalAttemptCount: 0,
            totalSessionCount: 0,
            sessions: [],
            currentSession: null,
            lastSession: null,
            activeTask: null,
            message: "Initial message",
            capabilities: {
              canArchive: true,
              canReady: true,
              canResume: false,
              canReconfigure: true,
            },
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (url.endsWith("/api/runs/run-1/reconfigure") && init?.method === "POST") {
            reconfigureBodies.push(JSON.parse(init.body as string));
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("button", { name: /^Attempts\b/ }));

    const attemptsPanel = screen.getByRole("region", { name: "Attempts" });
    expect(within(attemptsPanel).getByRole("button", { name: "Edit run message" })).toBeEnabled();
    await user.click(within(attemptsPanel).getByRole("button", { name: "Edit run message" }));
    await user.clear(within(attemptsPanel).getByLabelText("Message"));
    await user.type(within(attemptsPanel).getByLabelText("Message"), "Updated message");
    await user.click(within(attemptsPanel).getByRole("button", { name: "Save message" }));

    await waitFor(() =>
      expect(within(attemptsPanel).getByText("Updated message")).toBeInTheDocument(),
    );
    expect(reconfigureBodies).toEqual([{ message: "Updated message" }]);
  });

  it("keeps reconfigure drafts open when the server rejects a save", async () => {
    installFetchMock(
      {
        runs: [
          makeRun({
            status: "initialized",
            totalAttemptCount: 0,
            totalSessionCount: 0,
            currentSession: null,
            lastSession: null,
            capabilities: {
              canArchive: true,
              canReady: true,
              canResume: false,
              canReconfigure: true,
            },
          }),
        ],
        details: {
          "run-1": makeDetail({
            status: "initialized",
            isLive: false,
            totalAttemptCount: 0,
            totalSessionCount: 0,
            sessions: [],
            currentSession: null,
            lastSession: null,
            activeTask: null,
            runtimeVars: {
              target: "alpha",
            },
            capabilities: {
              canArchive: true,
              canReady: true,
              canResume: false,
              canReconfigure: true,
            },
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (url.endsWith("/api/runs/run-1/reconfigure") && init?.method === "POST") {
            return new Response(
              JSON.stringify({ error: { message: "server validation failed", code: "invalid" } }),
              { status: 400 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("button", { name: "Data" }));

    const dataPanel = screen.getByLabelText("Data");
    await user.click(within(dataPanel).getByRole("button", { name: "Edit run vars" }));
    await user.clear(within(dataPanel).getByLabelText("Value for target"));
    await user.type(within(dataPanel).getByLabelText("Value for target"), "beta");
    await user.click(within(dataPanel).getByRole("button", { name: "Save vars" }));

    expect(await screen.findByText("server validation failed")).toBeInTheDocument();
    expect(within(dataPanel).getByLabelText("Value for target")).toHaveValue("beta");
    expect(within(dataPanel).getByRole("button", { name: "Save vars" })).toBeInTheDocument();
  });

  it("hides run reconfigure edit affordances when the capability is unavailable", async () => {
    installFetchMock({
      runs: [
        makeRun({
          status: "initialized",
          totalAttemptCount: 0,
          totalSessionCount: 0,
          currentSession: null,
          lastSession: null,
        }),
      ],
      details: {
        "run-1": makeDetail({
          status: "initialized",
          isLive: false,
          totalAttemptCount: 0,
          totalSessionCount: 0,
          sessions: [],
          currentSession: null,
          lastSession: null,
          activeTask: null,
          message: "Initial message",
          runtimeVars: {
            target: "alpha",
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("button", { name: "Data" }));

    expect(screen.queryByRole("button", { name: "Edit run vars" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Attempts\b/ }));
    expect(screen.queryByRole("button", { name: "Edit run message" })).not.toBeInTheDocument();
  });

  it("shows empty states for missing vars and hook state data", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail({
          runtimeVars: {},
          hookState: undefined,
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(screen.getByRole("button", { name: "Data" }));

    const dataPanel = screen.getByLabelText("Data");
    expect(within(dataPanel).getByText("No vars")).toBeInTheDocument();

    await user.click(within(dataPanel).getByRole("tab", { name: "Hook state" }));
    expect(within(dataPanel).getByText("No hook state")).toBeInTheDocument();
  });

  it("reloads timeline history after a cursor gap instead of merging heuristically", async () => {
    const timelineHistory = {
      runId: "run-1",
      lastCursor: 1,
      attempts: [
        {
          attemptNumber: 1,

          attemptIndexInSession: 0,
          sessionIndex: 0,
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: null,
          prompt: "Initial prompt",
          transcript: "Before gap",
          notices: "",
          exitCode: null,
          timedOut: false,
          live: true,
          provenance: { kind: "task_runner" },
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
    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    const timelineSource = findEventSource("/api/runs/run-1/events/timeline");
    timelineSource.emitOpen();

    expect(await screen.findByRole("region", { name: "Attempt response" })).toHaveTextContent(
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
      expect(screen.getByRole("region", { name: "Attempt response" })).toHaveTextContent(
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
              canEditPending: true,
              canDeletePending: true,
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
              canEditPending: true,
              canDeletePending: true,
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
      screen.queryByRole("heading", { name: /^Initialized(?: \(\d+\))?$/ }),
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
              canEditPending: true,
              canDeletePending: true,
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
              canEditPending: true,
              canDeletePending: true,
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

  it("shows ended and exit code in the summary for completed runs and removes the Timing tab", async () => {
    installFetchMock({
      runs: [
        makeRun({
          status: "success",
          endedAt: "2026-04-13T05:05:00.000Z",
          activeTask: null,
          capabilities: {
            canAbort: false,
            canResume: false,
          },
        }),
      ],
      details: {
        "run-1": makeDetail({
          status: "success",
          endedAt: "2026-04-13T05:05:00.000Z",
          exitCode: 0,
          activeTask: null,
          capabilities: {
            canAbort: false,
            canResume: false,
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const summary = await screen.findByLabelText("Run summary");
    expect(within(summary).getByText("Ended")).toBeInTheDocument();
    expect(within(summary).getByText("Exit code")).toBeInTheDocument();
    expect(within(summary).getByText("0")).toBeInTheDocument();
    expect(within(summary).getByRole("button", { name: /copy cwd path/i })).toBeInTheDocument();
    expect(
      within(summary).getByRole("button", { name: /copy workspace path/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Timing" })).not.toBeInTheDocument();
  });

  it("omits ended and exit code from the summary for live runs", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const summary = await screen.findByLabelText("Run summary");
    expect(within(summary).queryByText("Ended")).not.toBeInTheDocument();
    expect(within(summary).queryByText("Exit code")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Timing" })).not.toBeInTheDocument();
  });

  it("shows ended without exit code when a run ended without an exit code", async () => {
    installFetchMock({
      runs: [
        makeRun({
          status: "success",
          endedAt: "2026-04-13T05:05:00.000Z",
          activeTask: null,
          capabilities: {
            canAbort: false,
            canResume: false,
          },
        }),
      ],
      details: {
        "run-1": makeDetail({
          status: "success",
          endedAt: "2026-04-13T05:05:00.000Z",
          exitCode: null,
          activeTask: null,
          capabilities: {
            canAbort: false,
            canResume: false,
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const summary = await screen.findByLabelText("Run summary");
    expect(within(summary).getByText("Ended")).toBeInTheDocument();
    expect(within(summary).queryByText("Exit code")).not.toBeInTheDocument();
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

  it("shows compact schedule indicators on run cards", async () => {
    const futureSchedule = {
      enabled: true,
      runAt: "2099-04-25T12:00:00.000Z",
      recurrence: null,
    };
    const pausedSchedule = {
      ...futureSchedule,
      enabled: false,
      runAt: "2099-04-26T12:00:00.000Z",
    };
    const dueSchedule = {
      ...futureSchedule,
      runAt: "2020-04-25T12:00:00.000Z",
    };
    installFetchMock({
      runs: [
        makeRun({
          runId: "scheduled-future",
          name: "Future schedule",
          assignmentName: "Future schedule",
          schedule: futureSchedule,
          scheduleState: "future",
        }),
        makeRun({
          runId: "scheduled-paused",
          name: "Paused schedule",
          assignmentName: "Paused schedule",
          schedule: pausedSchedule,
          scheduleState: "paused",
        }),
        makeRun({
          runId: "scheduled-due",
          name: "Due schedule",
          assignmentName: "Due schedule",
          schedule: dueSchedule,
          scheduleState: "due",
        }),
      ],
      details: {
        "scheduled-future": makeDetail({ runId: "scheduled-future", schedule: futureSchedule }),
        "scheduled-paused": makeDetail({ runId: "scheduled-paused", schedule: pausedSchedule }),
        "scheduled-due": makeDetail({ runId: "scheduled-due", schedule: dueSchedule }),
      },
    });

    await renderApp();

    const futureIndicator = within(await findRunCard("Future schedule")).getByLabelText(
      "Scheduled run: scheduled",
    );
    expect(futureIndicator).toHaveAttribute("title", "Scheduled run: scheduled");
    expect(
      within(await findRunCard("Paused schedule")).getByLabelText("Scheduled run: paused"),
    ).toBeInTheDocument();
    expect(
      within(await findRunCard("Due schedule")).getByLabelText("Scheduled run: due"),
    ).toBeInTheDocument();
  });

  it("filters board-visible runs to scheduled only and persists the quick toggle", async () => {
    const schedule = {
      enabled: true,
      runAt: "2099-04-25T12:00:00.000Z",
      recurrence: null,
    };
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-scheduled",
          assignmentName: "Scheduled dashboard",
          name: "Scheduled dashboard",
          schedule,
          scheduleState: "future",
        }),
        makeRun({
          runId: "run-plain",
          assignmentName: "Plain dashboard",
          name: "Plain dashboard",
          schedule: null,
          scheduleState: "none",
        }),
      ],
      details: {
        "run-scheduled": makeDetail({
          runId: "run-scheduled",
          assignment: {
            name: "Scheduled dashboard",
            sourcePath: "/tmp/scheduled-a.md",
          },
          schedule,
          scheduleState: "future",
        }),
        "run-plain": makeDetail({
          runId: "run-plain",
          assignment: {
            name: "Plain dashboard",
            sourcePath: "/tmp/plain-a.md",
          },
          schedule: null,
          scheduleState: "none",
        }),
      },
    });

    const user = userEvent.setup();
    const view = await renderApp();
    await findRunCard("Scheduled dashboard");
    expect(screen.getByRole("button", { name: /plain dashboard/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show scheduled runs only/i }));

    expect(await findRunCard("Scheduled dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /plain dashboard/i })).not.toBeInTheDocument();
    expect(screen.getByText("scheduled only")).toBeInTheDocument();

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      showScheduledOnly: true,
    });

    view.unmount();
    queryClient.clear();

    await renderApp();
    expect(await findRunCard("Scheduled dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /plain dashboard/i })).not.toBeInTheDocument();
  });

  it("renders recurring schedule detail and enables or disables schedules from the drawer", async () => {
    const schedule = {
      enabled: false,
      runAt: "2099-04-25T12:00:00.000Z",
      recurrence: {
        schedule: {
          type: "cron" as const,
          expression: "30 9 * * *",
          timezone: "UTC",
        },
        mode: "clone" as const,
        continueOnFailure: true,
      },
    };
    const detail = makeDetail({
      schedule,
      scheduleState: "paused",
    });
    const fetchMock = installFetchMock({
      runs: [makeRun({ schedule, scheduleState: "paused" })],
      details: { "run-1": detail },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const scheduleRegion = await screen.findByLabelText("Schedule");
    expect(within(scheduleRegion).getAllByText("Paused")).toHaveLength(2);
    expect(within(scheduleRegion).getByText("At 09:30 AM")).toBeInTheDocument();
    expect(within(scheduleRegion).getByText("30 9 * * *")).toBeInTheDocument();
    expect(within(scheduleRegion).getByText("UTC")).toBeInTheDocument();
    expect(within(scheduleRegion).getByText("Clone run")).toBeInTheDocument();
    expect(within(scheduleRegion).getByText("Yes")).toBeInTheDocument();

    const enableButton = within(scheduleRegion).getByRole("button", { name: "Enable" });
    enableButton.focus();
    expect(enableButton).toHaveFocus();
    await user.click(enableButton);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/schedule/enable", {
        method: "POST",
        headers: { accept: "application/json" },
      }),
    );
    expect(await within(scheduleRegion).findByRole("button", { name: "Disable" })).toBeEnabled();

    const clearButton = within(scheduleRegion).getByRole("button", { name: "Clear" });
    clearButton.focus();
    expect(clearButton).toHaveFocus();
    await user.click(clearButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/schedule", {
        method: "DELETE",
        headers: { accept: "application/json" },
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Schedule")).not.toBeInTheDocument());
  });

  it("clears one-time schedules from the detail drawer", async () => {
    const schedule = {
      enabled: true,
      runAt: "2099-04-25T12:00:00.000Z",
      recurrence: null,
    };
    const fetchMock = installFetchMock({
      runs: [makeRun({ schedule, scheduleState: "future" })],
      details: {
        "run-1": makeDetail({
          schedule,
          scheduleState: "future",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const scheduleRegion = await screen.findByLabelText("Schedule");
    expect(within(scheduleRegion).getByText("One-time")).toBeInTheDocument();
    const clearButton = within(scheduleRegion).getByRole("button", { name: "Clear" });
    clearButton.focus();
    expect(clearButton).toHaveFocus();
    await user.click(clearButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/schedule", {
        method: "DELETE",
        headers: { accept: "application/json" },
      }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Schedule")).not.toBeInTheDocument());
  });

  it("falls back to document copy when clipboard access is unavailable", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();

    const navigatorWithoutClipboard = Object.create(navigator) as Navigator;
    Object.defineProperty(navigatorWithoutClipboard, "clipboard", {
      configurable: true,
      value: undefined,
    });
    vi.stubGlobal("navigator", navigatorWithoutClipboard);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });

    await renderApp();

    await user.click(await findRunCard("Build dashboard"));
    await screen.findByLabelText("Run detail");
    await user.click(screen.getByRole("button", { name: /copy backend session id/i }));

    expect(await screen.findByText("Copied backend session id.")).toBeInTheDocument();
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector(".notice-stack--bottom")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Dismiss notice" }));
    await waitFor(() => {
      expect(screen.queryByText("Copied backend session id.")).not.toBeInTheDocument();
      expect(document.querySelector(".notice-stack--bottom")).toBeNull();
    });
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
    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Tasks",
      }),
    );

    expect(screen.queryByText("Ship the web UI")).not.toBeInTheDocument();
    expect(screen.queryByText("working")).not.toBeInTheDocument();

    const taskHeader = screen.getByRole("button", { name: /build ui/i, expanded: false });
    await user.click(taskHeader);

    expect(await screen.findByText("Ship the web UI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /build ui/i, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Instructions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Task notes" })).toBeInTheDocument();

    expect(screen.queryByText("working")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Task notes" }));
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

  it("clears then blurs a focused search before closing the selected run detail", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Build dashboard"));
    const searchInput = screen.getByPlaceholderText("Search runs");
    await user.type(searchInput, "build");

    expect(searchInput).toHaveValue("build");
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(searchInput).toHaveValue("");
    expect(searchInput).toHaveFocus();
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(searchInput).not.toHaveFocus();
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByLabelText("Run detail")).not.toBeInTheDocument();
    });
  });

  it("blurs the focused search on Enter while preserving the current query", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Build dashboard"));
    const searchInput = screen.getByPlaceholderText("Search runs");
    await user.type(searchInput, "build");

    expect(searchInput).toHaveValue("build");
    expect(searchInput).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(searchInput).toHaveValue("build");
    expect(searchInput).not.toHaveFocus();
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
  });

  it("focuses the run search with Ctrl+F", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    const runCard = await findRunCard("Build dashboard");
    runCard.focus();
    expect(runCard).toHaveFocus();

    await user.keyboard("{Control>}{f}{/Control}");

    expect(screen.getByPlaceholderText("Search runs")).toHaveFocus();
  });

  it("toggles Filters open and closed with Ctrl+Shift+F", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    const runCard = await findRunCard("Build dashboard");
    runCard.focus();
    expect(runCard).toHaveFocus();

    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    expect(await screen.findByRole("dialog", { name: "Filters" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Repo" })).toHaveFocus();
    });

    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
    });

    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    expect(await screen.findByRole("dialog", { name: "Filters" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Repo" })).toHaveFocus();
    });
  });

  it("applies exact-match structured filters and keeps options stable while filters are active", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-a-codex",
          repo: "repo-a",
          agentName: "implementer",
          backend: "codex",
          assignmentName: "Repo A Codex",
          name: "Repo A Codex",
        }),
        makeRun({
          runId: "run-a-passive",
          repo: "repo-a",
          agentName: "reviewer",
          backend: "passive",
          assignmentName: "Repo A Passive",
          name: "Repo A Passive",
        }),
        makeRun({
          runId: "run-b-claude",
          repo: "repo-b",
          agentName: "implementer",
          backend: "claude",
          assignmentName: "Repo B Claude",
          name: "Repo B Claude",
        }),
      ],
      details: {},
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Repo A Codex");
    const filtersDialog = await openFilters(user);
    expect(filtersDialog).not.toHaveAttribute("data-modal");

    expect(
      within(screen.getByRole("combobox", { name: "Backend" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["", "claude", "codex", "passive"]);

    await user.selectOptions(screen.getByRole("combobox", { name: "Repo" }), "repo-a");
    expect(await findRunCard("Repo A Codex")).toBeInTheDocument();
    expect(await findRunCard("Repo A Passive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repo B Claude/i })).not.toBeInTheDocument();

    expect(filtersDialog).toBeInTheDocument();
    expect(
      within(screen.getByRole("combobox", { name: "Backend" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["", "claude", "codex", "passive"]);

    await user.selectOptions(screen.getByRole("combobox", { name: "Agent" }), "reviewer");
    expect(await findRunCard("Repo A Passive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repo A Codex/i })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Backend" }), "claude");
    expect(await screen.findByText("No matching runs")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Backend" }), "");
    expect(await findRunCard("Repo A Passive")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Agent" }), "");
    expect(await findRunCard("Repo A Codex")).toBeInTheDocument();
    expect(await findRunCard("Repo A Passive")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(await findRunCard("Repo A Codex")).toBeInTheDocument();
    expect(await findRunCard("Repo A Passive")).toBeInTheDocument();
    expect(await findRunCard("Repo B Claude")).toBeInTheDocument();
  });

  it("uses native modal dismissal for filters on mobile", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === "(max-width: 900px)",
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
    installFetchMock({
      runs: [makeRun()],
      details: {},
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    const filtersDialog = await openFilters(user);
    expect(filtersDialog).toHaveAttribute("data-modal", "true");

    nativeCancel(filtersDialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
    });
  });

  it("persists structured filters across reloads while keeping search transient", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-a-codex",
          repo: "repo-a",
          agentName: "implementer",
          backend: "codex",
          assignmentName: "Repo A Codex",
          name: "Repo A Codex",
        }),
        makeRun({
          runId: "run-a-passive",
          repo: "repo-a",
          agentName: "reviewer",
          backend: "passive",
          assignmentName: "Repo A Passive",
          name: "Repo A Passive",
        }),
        makeRun({
          runId: "run-b-claude",
          repo: "repo-b",
          agentName: "implementer",
          backend: "claude",
          assignmentName: "Repo B Claude",
          name: "Repo B Claude",
        }),
      ],
      details: {},
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Repo A Codex");

    await openFilters(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Repo" }), "repo-a");
    await user.type(screen.getByPlaceholderText("Search runs"), "Passive");

    expect(await findRunCard("Repo A Passive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repo A Codex/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repo B Claude/i })).not.toBeInTheDocument();

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      structuredFilters: {
        repo: "repo-a",
        agent: null,
        backend: null,
        runGroupId: null,
      },
    });

    cleanup();
    queryClient.clear();

    await renderApp();
    await findRunCard("Repo A Codex");

    expect(screen.getByPlaceholderText("Search runs")).toHaveValue("");
    expect(await findRunCard("Repo A Codex")).toBeInTheDocument();
    expect(await findRunCard("Repo A Passive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repo B Claude/i })).not.toBeInTheDocument();

    await openFilters(user);
    expect(screen.getByRole("combobox", { name: "Repo" })).toHaveValue("repo-a");
  });

  it("uses bare-board Escape as a final fallback to clear only structured filters", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-a",
          repo: "repo-a",
          agentName: "implementer",
          backend: "codex",
          assignmentName: "Repo A pinned",
          name: "Repo A pinned",
          pinned: true,
        }),
        makeRun({
          runId: "run-b",
          repo: "repo-b",
          agentName: "reviewer",
          backend: "claude",
          assignmentName: "Repo B unpinned",
          name: "Repo B unpinned",
          pinned: false,
        }),
        makeRun({
          runId: "run-c",
          repo: "repo-c",
          agentName: "reviewer",
          backend: "passive",
          assignmentName: "Repo C pinned",
          name: "Repo C pinned",
          pinned: true,
        }),
      ],
      details: {},
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Repo A pinned");

    await openFilters(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Repo" }), "repo-a");
    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /show pinned runs only/i }));
    await user.type(screen.getByPlaceholderText("Search runs"), "Repo");

    expect(await findRunCard("Repo A pinned")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repo B unpinned/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repo C pinned/i })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.getByPlaceholderText("Search runs")).toHaveValue("");
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Search runs"));
    expect(screen.queryByRole("button", { name: /Repo C pinned/i })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(screen.getByPlaceholderText("Search runs"));
    expect(screen.queryByRole("button", { name: /Repo C pinned/i })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(await findRunCard("Repo A pinned")).toBeInTheDocument();
    expect(await findRunCard("Repo C pinned")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Repo B unpinned/i })).not.toBeInTheDocument();

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      showPinnedOnly: true,
      structuredFilters: {
        repo: null,
        agent: null,
        backend: null,
        runGroupId: null,
      },
    });
  });

  it("applies and clears structured filters from run-card badges without breaking card selection", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-a-codex",
          repo: "repo-a",
          agentName: "implementer",
          backend: "codex",
          assignmentName: "Repo A Codex",
          name: "Repo A Codex",
        }),
        makeRun({
          runId: "run-b-claude",
          repo: "repo-b",
          agentName: "reviewer",
          backend: "claude",
          assignmentName: "Repo B Claude",
          name: "Repo B Claude",
        }),
      ],
      details: {
        "run-a-codex": makeDetail({
          runId: "run-a-codex",
          repo: "repo-a",
          agent: {
            name: "implementer",
            sourcePath: null,
          },
          assignment: {
            name: "Repo A Codex",
            sourcePath: "/tmp/repo-a-codex.md",
          },
          backend: "codex",
          name: "Repo A Codex",
        }),
        "run-b-claude": makeDetail({
          runId: "run-b-claude",
          repo: "repo-b",
          agent: {
            name: "reviewer",
            sourcePath: null,
          },
          assignment: {
            name: "Repo B Claude",
            sourcePath: "/tmp/repo-b-claude.md",
          },
          backend: "claude",
          name: "Repo B Claude",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    const repoACard = await findRunCard("Repo A Codex");
    await user.click(repoACard);
    await screen.findByLabelText("Run detail");

    const selectedRepoACard = await findRunCard("Repo A Codex");
    await user.click(within(selectedRepoACard).getByLabelText("Filter by repo repo-a"));
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Repo B Claude/i })).not.toBeInTheDocument();
    });

    await user.click(
      within(await findRunCard("Repo A Codex")).getByLabelText("Filter by repo repo-a"),
    );
    expect(await findRunCard("Repo B Claude")).toBeInTheDocument();

    const repoBCard = await findRunCard("Repo B Claude");
    await user.click(within(repoBCard).getByLabelText("Filter by backend claude"));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Repo A Codex/i })).not.toBeInTheDocument();
    });

    const filteredCard = await findRunCard("Repo B Claude");
    await user.click(filteredCard);
    expect(filteredCard).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
  });

  it("renders group toggles in the card header and reapplies after clearing from filters", async () => {
    const groupRuns = [
      makeRun({
        runId: "run-root",
        runGroupId: "run-root",
        assignmentName: "Group root",
        name: "Group root",
      }),
      makeRun({
        runId: "run-child",
        parentRunId: "run-root",
        runGroupId: "run-root",
        assignmentName: "Group child",
        name: "Group child",
      }),
    ];
    const fetchMock = installFetchMock({
      runs: [
        ...groupRuns,
        makeRun({
          runId: "run-outside",
          assignmentName: "Outside run",
          name: "Outside run",
        }),
      ],
      details: {
        "run-root": makeDetail({
          runId: "run-root",
          runGroupId: "run-root",
          assignment: { name: "Group root", sourcePath: "/tmp/group-root-assignment.md" },
          name: "Group root",
        }),
        "run-child": makeDetail({
          runId: "run-child",
          parentRunId: "run-root",
          runGroupId: "run-root",
          assignment: { name: "Group child", sourcePath: "/tmp/group-child-assignment.md" },
          name: "Group child",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    const rootCard = await findRunCard("Group root");
    const childCard = await findRunCard("Group child");
    expect(within(rootCard).getByText("run-root")).toBeInTheDocument();
    expect(within(rootCard).queryByText("run-root/run-root")).not.toBeInTheDocument();
    expect(within(childCard).getByText("run-root/run-child")).toBeInTheDocument();
    expect(within(rootCard).getByLabelText("Filter by run group run-root")).toBeInTheDocument();
    expect(within(childCard).getByLabelText("Filter by run group run-root")).toBeInTheDocument();
    expect(
      within(await findRunCard("Outside run")).getByLabelText("Filter by run group run-outside"),
    ).toBeInTheDocument();

    await user.click(within(childCard).getByLabelText("Filter by run group run-root"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs?includeArchived=false&runGroupId=run-root",
        expect.objectContaining({
          headers: { accept: "application/json" },
        }),
      ),
    );
    expect(await findRunCard("Group root")).toBeInTheDocument();
    expect(await findRunCard("Group child")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Outside run/i })).not.toBeInTheDocument();

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      structuredFilters: {
        runGroupId: "run-root",
      },
    });

    await openFilters(user);
    expect(screen.getByRole("textbox", { name: "Run group" })).toHaveValue("run-root");
    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(await findRunCard("Outside run")).toBeInTheDocument();

    await user.click(
      within(await findRunCard("Group child")).getByLabelText("Filter by run group run-root"),
    );

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Outside run/i })).not.toBeInTheDocument();
    });
  });

  it("filters by run group from the detail sidebar group id", async () => {
    const groupRuns = [
      makeRun({
        runId: "run-root",
        runGroupId: "run-root",
        assignmentName: "Group root",
        name: "Group root",
      }),
      makeRun({
        runId: "run-child",
        parentRunId: "run-root",
        runGroupId: "run-root",
        assignmentName: "Group child",
        name: "Group child",
      }),
    ];
    const fetchMock = installFetchMock({
      runs: [
        ...groupRuns,
        makeRun({
          runId: "run-outside",
          assignmentName: "Outside run",
          name: "Outside run",
        }),
      ],
      details: {
        "run-root": makeDetail({
          runId: "run-root",
          runGroupId: "run-root",
          assignment: { name: "Group root", sourcePath: "/tmp/group-root-assignment.md" },
          name: "Group root",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Group root"));

    const drawer = await screen.findByLabelText("Run detail");
    expect(within(drawer).getAllByText("run-root").length).toBeGreaterThan(0);
    expect(within(drawer).queryByText("run-root/run-root")).not.toBeInTheDocument();

    const groupFilterButton = within(drawer).getByRole("button", {
      name: "Filter by run group run-root",
    });
    expect(groupFilterButton).toHaveAttribute("aria-pressed", "false");

    await user.click(groupFilterButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs?includeArchived=false&runGroupId=run-root",
        expect.objectContaining({
          headers: { accept: "application/json" },
        }),
      ),
    );
    expect(await findRunCard("Group root")).toBeInTheDocument();
    expect(await findRunCard("Group child")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Outside run/i })).not.toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: "Filter by run group run-root" }),
    ).toHaveAttribute("aria-pressed", "true");

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      structuredFilters: {
        runGroupId: "run-root",
      },
    });

    await user.click(within(drawer).getByRole("button", { name: "Filter by run group run-root" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs?includeArchived=false",
        expect.objectContaining({
          headers: { accept: "application/json" },
        }),
      ),
    );
    expect(await findRunCard("Outside run")).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: "Filter by run group run-root" }),
    ).toHaveAttribute("aria-pressed", "false");
    const storedAfterToggle = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(storedAfterToggle ? JSON.parse(storedAfterToggle) : null).toMatchObject({
      structuredFilters: {
        runGroupId: null,
      },
    });
  });

  it("composes the group filter with search, pinned, notes, and archived dashboard filters", async () => {
    const groupRuns = [
      makeRun({
        runId: "run-root",
        runGroupId: "run-root",
        assignmentName: "Group root",
        name: "Group root",
        notePresent: true,
      }),
      makeRun({
        runId: "run-child",
        parentRunId: "run-root",
        runGroupId: "run-root",
        assignmentName: "Group child",
        name: "Group child",
        pinned: true,
      }),
      makeRun({
        runId: "run-archived",
        parentRunId: "run-root",
        runGroupId: "run-root",
        assignmentName: "Archived group",
        name: "Archived group",
        archivedAt: "2026-04-13T06:00:00.000Z",
        notePresent: true,
        status: "success",
        pinned: true,
      }),
    ];
    installFetchMock({
      runs: [
        ...groupRuns,
        makeRun({
          runId: "run-outside",
          assignmentName: "Outside run",
          name: "Outside run",
          notePresent: true,
          pinned: true,
        }),
      ],
      details: {},
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(
      within(await findRunCard("Group root")).getByLabelText("Filter by run group run-root"),
    );

    await user.type(screen.getByPlaceholderText("Search runs"), "child");
    expect(await findRunCard("Group child")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Group root/i })).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("Search runs"));
    await user.click(screen.getByRole("button", { name: /show pinned runs only/i }));
    expect(await findRunCard("Group child")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Group root/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show pinned runs only/i }));
    await user.click(screen.getByRole("button", { name: /show runs with notes only/i }));
    expect(await findRunCard("Group root")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Group child/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archived group/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show archived runs/i }));
    expect(await findRunCard("Archived group")).toBeInTheDocument();
  });

  it("shows the board error panel for failing group queries and retries the same group scope", async () => {
    let failGroupFetch = true;
    const groupRuns = [
      makeRun({
        runId: "run-root",
        runGroupId: "run-root",
        assignmentName: "Group root",
        name: "Group root",
      }),
      makeRun({
        runId: "run-child",
        parentRunId: "run-root",
        runGroupId: "run-root",
        assignmentName: "Group child",
        name: "Group child",
      }),
    ];
    const fetchMock = installFetchMock(
      {
        runs: groupRuns,
        details: {},
      },
      {
        handleRequest: (url) => {
          if (!url.includes("/api/runs?includeArchived=false&runGroupId=run-root")) {
            return undefined;
          }
          if (failGroupFetch) {
            return new Response(
              JSON.stringify({
                error: {
                  code: "COMMAND_ERROR",
                  message: 'run group "missing-group" could not be loaded',
                },
              }),
              { status: 422 },
            );
          }
          return new Response(JSON.stringify({ runs: groupRuns }), { status: 200 });
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(
      within(await findRunCard("Group root")).getByLabelText("Filter by run group run-root"),
    );

    expect(
      await screen.findByRole("heading", { name: "Run board failed to load" }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/run group "missing-group" could not be loaded/i)).toBeInTheDocument();

    failGroupFetch = false;
    await user.click(screen.getByRole("button", { name: "Retry board load" }));

    expect(await findRunCard("Group child")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs?includeArchived=false&runGroupId=run-root",
      expect.objectContaining({
        headers: { accept: "application/json" },
      }),
    );
  });

  it("navigates between selected runs with arrow keys", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-pending",
          assignmentName: "Pending dashboard",
          effectiveStatus: "initialized",
          name: "Pending dashboard",
          status: "initialized",
        }),
        makeRun({
          runId: "run-running",
          assignmentName: "Running dashboard",
          name: "Running dashboard",
        }),
        makeRun({
          activeTask: null,
          effectiveStatus: "success",
          runId: "run-completed",
          assignmentName: "Completed dashboard",
          name: "Completed dashboard",
          status: "success",
        }),
      ],
      details: {
        "run-pending": makeDetail({
          runId: "run-pending",
          effectiveStatus: "initialized",
          assignment: {
            name: "Pending dashboard",
            sourcePath: "/tmp/pending-a.md",
          },
          name: "Pending dashboard",
          status: "initialized",
        }),
        "run-running": makeDetail({
          runId: "run-running",
          assignment: {
            name: "Running dashboard",
            sourcePath: "/tmp/running-a.md",
          },
          name: "Running dashboard",
        }),
        "run-completed": makeDetail({
          runId: "run-completed",
          activeTask: null,
          effectiveStatus: "success",
          assignment: {
            name: "Completed dashboard",
            sourcePath: "/tmp/completed-a.md",
          },
          name: "Completed dashboard",
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Pending dashboard"));
    expect(screen.getByRole("button", { name: /pending dashboard/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("{ArrowRight}");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /running dashboard/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(screen.getByRole("button", { name: /running dashboard/i })).toHaveFocus();
    expect(screen.getByRole("button", { name: /pending dashboard/i })).not.toHaveFocus();
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /completed dashboard/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(screen.getByRole("button", { name: /completed dashboard/i })).toHaveFocus();
    expect(screen.getByRole("button", { name: /running dashboard/i })).not.toHaveFocus();
  });

  it("suppresses board and search shortcuts while the detail drawer is fullscreen", async () => {
    let resumeBody: { overrides?: { message?: string } } | undefined;
    installFetchMock(
      {
        runs: [
          makeRun({
            runId: "initialized-fullscreen",
            assignmentName: "Initialized fullscreen",
            name: "Initialized fullscreen",
            status: "initialized",
            effectiveStatus: "initialized",
            activeTask: null,
          }),
          makeRun({
            runId: "neighbor-fullscreen",
            assignmentName: "Neighbor fullscreen",
            name: "Neighbor fullscreen",
          }),
        ],
        details: {
          "initialized-fullscreen": makeDetail({
            runId: "initialized-fullscreen",
            status: "initialized",
            effectiveStatus: "initialized",
            isLive: false,
            backendSessionId: null,
            name: "Initialized fullscreen",
            assignment: {
              name: "Initialized fullscreen",
              sourcePath: "/tmp/fullscreen-a.md",
            },
            tasks: [
              {
                id: "setup",
                title: "Setup",
                body: "Prepare the run",
                status: "pending",
                notes: "",
              },
            ],
            capabilities: {
              canArchive: true,
              canUnarchive: false,
              canResume: true,
              taskMutation: {
                canAdd: false,
                canEditPending: false,
                canDeletePending: false,
                canEditNotes: false,
                canSetStatus: false,
              },
            },
          }),
          "neighbor-fullscreen": makeDetail({
            runId: "neighbor-fullscreen",
            assignment: {
              name: "Neighbor fullscreen",
              sourcePath: "/tmp/fullscreen-c.md",
            },
            name: "Neighbor fullscreen",
          }),
        },
      },
      {
        handleRequest: async (url, init) => {
          if (url.endsWith("/api/runs/initialized-fullscreen/resume")) {
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

    await user.click(await findRunCard("Initialized fullscreen"));
    await user.click(await screen.findByRole("button", { name: "Expand drawer to full width" }));

    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Run surface" })).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText("Search runs");
    expect(searchInput).not.toHaveFocus();

    await user.keyboard("{Control>}{f}{/Control}");
    expect(searchInput).not.toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: /initialized fullscreen/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /neighbor fullscreen/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.keyboard("{Enter}");
    const firstResumeDialog = await screen.findByRole("dialog", { name: "Resume run" });
    expect(resumeBody).toBeUndefined();

    nativeCancel(firstResumeDialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    const backdropDialog = await screen.findByRole("dialog", { name: "Resume run" });
    await user.click(backdropDialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Resume run" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Expand drawer to full width" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByLabelText("Run detail")).not.toBeInTheDocument();
    });
  });

  it("toggles drawer fullscreen with Shift+F when a run detail is open", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-fullscreen-toggle",
          assignmentName: "Fullscreen toggle",
          name: "Fullscreen toggle",
        }),
      ],
      details: {
        "run-fullscreen-toggle": makeDetail({
          runId: "run-fullscreen-toggle",
          assignment: {
            name: "Fullscreen toggle",
            sourcePath: "/tmp/fullscreen-toggle-a.md",
          },
          name: "Fullscreen toggle",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Fullscreen toggle"));
    expect(screen.getByRole("button", { name: "Expand drawer to full width" })).toBeInTheDocument();

    await user.keyboard("{Shift>}f{/Shift}");
    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(window.localStorage.getItem("agent-runner:web:dashboard-view-state")).toContain(
      '"drawerFullscreen":true',
    );

    await user.keyboard("{Shift>}f{/Shift}");
    expect(screen.getByRole("button", { name: "Expand drawer to full width" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(window.localStorage.getItem("agent-runner:web:dashboard-view-state")).toContain(
      '"drawerFullscreen":false',
    );
  });

  it("scrolls an offscreen target column into view during arrow-key navigation", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-running-shortcuts",
          assignmentName: "Running shortcuts",
          name: "Running shortcuts",
        }),
        makeRun({
          activeTask: null,
          effectiveStatus: "success",
          runId: "run-completed-shortcuts",
          assignmentName: "Completed shortcuts",
          name: "Completed shortcuts",
          status: "success",
        }),
      ],
      details: {
        "run-running-shortcuts": makeDetail({
          runId: "run-running-shortcuts",
          assignment: {
            name: "Running shortcuts",
            sourcePath: "/tmp/running-shortcuts-a.md",
          },
          name: "Running shortcuts",
        }),
        "run-completed-shortcuts": makeDetail({
          runId: "run-completed-shortcuts",
          activeTask: null,
          effectiveStatus: "success",
          assignment: {
            name: "Completed shortcuts",
            sourcePath: "/tmp/completed-shortcuts-a.md",
          },
          name: "Completed shortcuts",
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Running shortcuts"));

    const scrollTo = vi.fn();
    setBoardGeometry({
      clientWidth: 260,
      columns: [
        { key: "running", left: 0, width: 180 },
        { key: "completed", left: 200, width: 180 },
      ],
      scrollLeft: 0,
      scrollTo,
      scrollWidth: 420,
    });
    scrollTo.mockClear();

    await user.keyboard("{ArrowRight}");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /completed shortcuts/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", left: 160 });
  });

  it("scrolls the selected card into view within a column during vertical arrow navigation", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-running-1",
          assignmentName: "Running shortcuts 1",
          name: "Running shortcuts 1",
        }),
        makeRun({
          runId: "run-running-2",
          assignmentName: "Running shortcuts 2",
          name: "Running shortcuts 2",
        }),
        makeRun({
          runId: "run-running-3",
          assignmentName: "Running shortcuts 3",
          name: "Running shortcuts 3",
        }),
      ],
      details: {
        "run-running-1": makeDetail({
          runId: "run-running-1",
          assignment: {
            name: "Running shortcuts 1",
            sourcePath: "/tmp/running-shortcuts-1-a.md",
          },
          name: "Running shortcuts 1",
        }),
        "run-running-2": makeDetail({
          runId: "run-running-2",
          assignment: {
            name: "Running shortcuts 2",
            sourcePath: "/tmp/running-shortcuts-2-a.md",
          },
          name: "Running shortcuts 2",
        }),
        "run-running-3": makeDetail({
          runId: "run-running-3",
          assignment: {
            name: "Running shortcuts 3",
            sourcePath: "/tmp/running-shortcuts-3-a.md",
          },
          name: "Running shortcuts 3",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Running shortcuts 1"));

    setBoardGeometry({
      clientWidth: 260,
      columns: [{ key: "running", left: 0, width: 220 }],
      scrollLeft: 0,
      scrollWidth: 260,
    });
    const scrollTo = vi.fn(({ top }: { top: number }) => {
      defineElementMetric(
        getBoardColumn("Running").querySelector(".col-body") as Element,
        "scrollTop",
        top,
      );
    });
    setColumnBodyGeometry({
      columnName: "Running",
      clientHeight: 140,
      scrollTo,
      scrollTop: 0,
      cards: [
        { runId: "run-running-1", top: 12, height: 60 },
        { runId: "run-running-2", top: 82, height: 60 },
        { runId: "run-running-3", top: 152, height: 60 },
      ],
    });
    scrollTo.mockClear();

    await user.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /running shortcuts 2/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 2 });

    await user.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /running shortcuts 3/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 72 });

    scrollTo.mockClear();

    await user.keyboard("{ArrowUp}");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /running shortcuts 2/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(scrollTo).not.toHaveBeenCalled();

    await user.keyboard("{ArrowUp}");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /running shortcuts 1/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 0 });
  });

  it("scrolls a top-clipped card flush with the column body when arrow navigation lands on it", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-running-1",
          assignmentName: "Running shortcuts 1",
          name: "Running shortcuts 1",
        }),
        makeRun({
          runId: "run-running-2",
          assignmentName: "Running shortcuts 2",
          name: "Running shortcuts 2",
        }),
        makeRun({
          runId: "run-running-3",
          assignmentName: "Running shortcuts 3",
          name: "Running shortcuts 3",
        }),
      ],
      details: {
        "run-running-1": makeDetail({
          runId: "run-running-1",
          assignment: {
            name: "Running shortcuts 1",
            sourcePath: "/tmp/running-shortcuts-1-a.md",
          },
          name: "Running shortcuts 1",
        }),
        "run-running-2": makeDetail({
          runId: "run-running-2",
          assignment: {
            name: "Running shortcuts 2",
            sourcePath: "/tmp/running-shortcuts-2-a.md",
          },
          name: "Running shortcuts 2",
        }),
        "run-running-3": makeDetail({
          runId: "run-running-3",
          assignment: {
            name: "Running shortcuts 3",
            sourcePath: "/tmp/running-shortcuts-3-a.md",
          },
          name: "Running shortcuts 3",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Running shortcuts 3"));

    setBoardGeometry({
      clientWidth: 260,
      columns: [{ key: "running", left: 0, width: 220 }],
      scrollLeft: 0,
      scrollWidth: 260,
    });
    const scrollTo = vi.fn(({ top }: { top: number }) => {
      defineElementMetric(
        getBoardColumn("Running").querySelector(".col-body") as Element,
        "scrollTop",
        top,
      );
    });
    setColumnBodyGeometry({
      columnName: "Running",
      clientHeight: 140,
      scrollTo,
      scrollTop: 86,
      cards: [
        { runId: "run-running-1", top: 12, height: 60 },
        { runId: "run-running-2", top: 82, height: 60 },
        { runId: "run-running-3", top: 152, height: 60 },
      ],
    });
    scrollTo.mockClear();

    await user.keyboard("{ArrowUp}");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /running shortcuts 2/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 82 });
  });

  it("skips collapsed columns during arrow-key navigation", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-running-shortcuts",
          assignmentName: "Running shortcuts",
          name: "Running shortcuts",
        }),
        makeRun({
          activeTask: null,
          effectiveStatus: "success",
          runId: "run-completed-shortcuts",
          assignmentName: "Completed shortcuts",
          name: "Completed shortcuts",
          status: "success",
        }),
        makeRun({
          activeTask: null,
          effectiveStatus: "blocked",
          runId: "run-blocked-shortcuts",
          assignmentName: "Blocked shortcuts",
          name: "Blocked shortcuts",
          status: "blocked",
        }),
      ],
      details: {
        "run-running-shortcuts": makeDetail({
          runId: "run-running-shortcuts",
          assignment: {
            name: "Running shortcuts",
            sourcePath: "/tmp/running-shortcuts-a.md",
          },
          name: "Running shortcuts",
        }),
        "run-completed-shortcuts": makeDetail({
          runId: "run-completed-shortcuts",
          activeTask: null,
          effectiveStatus: "success",
          assignment: {
            name: "Completed shortcuts",
            sourcePath: "/tmp/completed-shortcuts-a.md",
          },
          name: "Completed shortcuts",
          status: "success",
        }),
        "run-blocked-shortcuts": makeDetail({
          runId: "run-blocked-shortcuts",
          activeTask: null,
          effectiveStatus: "blocked",
          assignment: {
            name: "Blocked shortcuts",
            sourcePath: "/tmp/blocked-shortcuts-a.md",
          },
          name: "Blocked shortcuts",
          status: "blocked",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Running shortcuts");

    const blockedColumn = getBoardColumn("Blocked");
    await user.click(
      within(blockedColumn).getByRole("button", { name: "Collapse Blocked column" }),
    );
    await waitFor(() => {
      expect(blockedColumn).toHaveAttribute("data-collapsed", "true");
    });

    await user.click(await findRunCard("Completed shortcuts"));
    expect(screen.getByRole("button", { name: /completed shortcuts/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("button", { name: /completed shortcuts/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
  });

  it("navigates between runs and settings through the shell", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(
      getSidebarNavigation().getByRole("button", { name: "Settings", current: "page" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Keybindings/ }));
    expect(await screen.findByRole("heading", { name: "Keybindings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dashboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Navigate runs")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: Ctrl + F")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: Ctrl + Shift + F")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: Ctrl + Shift + P")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: Ctrl + Shift + N")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: Ctrl + Shift + A")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: Ctrl + Shift + E")).toBeInTheDocument();
    expect(screen.getByText("Toggle notes-only filter")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: C")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: D")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: F")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: I")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: Shift + F")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut: T")).toBeInTheDocument();
    expect(screen.getByText("Switch to Chat")).toBeInTheDocument();
    expect(screen.getByText("Switch to Diffs")).toBeInTheDocument();
    expect(screen.getByText("Switch to Info")).toBeInTheDocument();
    expect(screen.getByText("Switch to Files")).toBeInTheDocument();
    expect(screen.getByText("Switch to Tasks")).toBeInTheDocument();

    await user.click(getSidebarNavigation().getByRole("button", { name: "Runs" }));

    expect(await screen.findByPlaceholderText("Search runs")).toBeInTheDocument();
    expect(
      getSidebarNavigation().getByRole("button", { name: "Runs", current: "page" }),
    ).toBeInTheDocument();
  });

  it("leaves settings on escape after opening them from the runs dashboard", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "General" })).not.toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("Search runs")).toBeInTheDocument();
  });

  it("leaves settings on escape from a deep-linked settings route", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp("/settings/general");
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "General" })).not.toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("Search runs")).toBeInTheDocument();
  });

  it("leaves settings on escape after switching sections within settings", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp("/settings/general");
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Keybindings/ }));
    expect(await screen.findByRole("heading", { name: "Keybindings" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Keybindings" })).not.toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("Search runs")).toBeInTheDocument();
  });

  it("saves and clears the daemon token from Settings while refreshing active run requests", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/runs") && requestHeader(init, "authorization") === null,
        ),
      ).toBe(true);
    });

    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "General" });

    await user.type(screen.getByLabelText("Daemon token"), "  saved-token  ");
    await user.click(screen.getByRole("button", { name: "Save token" }));

    expect(window.localStorage.getItem(DAEMON_TOKEN_STORAGE_KEY)).toBe("saved-token");
    const beforeTokenReturn = fetchMock.mock.calls.length;
    await user.click(getSidebarNavigation().getByRole("button", { name: "Runs" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls
          .slice(beforeTokenReturn)
          .some(
            ([url, init]) =>
              String(url).includes("/api/runs") &&
              requestHeader(init, "authorization") === "Bearer saved-token",
          ),
      ).toBe(true);
    });

    const beforeClear = fetchMock.mock.calls.length;
    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "General" });
    await user.click(screen.getByRole("button", { name: "Clear token" }));
    await user.click(getSidebarNavigation().getByRole("button", { name: "Runs" }));

    expect(window.localStorage.getItem(DAEMON_TOKEN_STORAGE_KEY)).toBeNull();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls
          .slice(beforeClear)
          .some(
            ([url, init]) =>
              String(url).includes("/api/runs") && requestHeader(init, "authorization") === null,
          ),
      ).toBe(true);
    });
  });

  it("routes run-list unauthorized responses to daemon token Settings", async () => {
    installFetchMock(
      {
        runs: [],
        details: {},
      },
      {
        handleRequest: (url, init) => {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs" && (!init?.method || init.method === "GET")) {
            return new Response(
              JSON.stringify({
                error: {
                  code: "UNAUTHENTICATED",
                  message: "daemon authentication required",
                },
              }),
              { status: 401 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    expect(
      await screen.findByText("Daemon token required", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Settings" }));

    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByLabelText("Daemon token")).toBeInTheDocument();
  });

  it("routes run-detail unauthorized responses to daemon token Settings", async () => {
    installFetchMock(
      {
        runs: [makeRun()],
        details: { "run-1": makeDetail() },
      },
      {
        handleRequest: (url, init) => {
          const parsed = new URL(url, "http://agent-runner.test");
          if (parsed.pathname === "/api/runs/run-1" && (!init?.method || init.method === "GET")) {
            return new Response(
              JSON.stringify({
                error: {
                  code: "UNAUTHENTICATED",
                  message: "daemon authentication required",
                },
              }),
              { status: 401 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    expect(
      await screen.findByText("Daemon token required", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Settings" }));

    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByLabelText("Daemon token")).toBeInTheDocument();
  });

  it("persists the detail drawer width after resizing it from the keyboard separator", async () => {
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

    const storedViewState = window.localStorage.getItem("agent-runner:web:dashboard-view-state");
    expect(storedViewState ? JSON.parse(storedViewState) : null).toEqual({
      viewMode: "board",
      collapsedColumnKeys: [],
      drawerWidth: 570,
      activeRightSurface: "detail",
      drawerFullscreen: false,
      diffsSidebarWidth: 272,
      filesSidebarWidth: 240,
      diffsViewMode: "unified",
    });

    cleanup();
    queryClient.clear();

    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const restoredDrawer = await screen.findByLabelText("Run detail");
    expect(restoredDrawer.style.getPropertyValue("--drawer-width")).toBe("570px");
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
    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Tasks",
      }),
    );
    await user.click(screen.getByRole("button", { name: /render markdown/i, expanded: false }));

    expect(await screen.findByText("Done when:")).toBeInTheDocument();
    const bulletOne = screen.getByText("bullet one");
    expect(bulletOne).toBeInTheDocument();
    expect(bulletOne.tagName).toBe("LI");

    await user.click(screen.getByRole("button", { name: "Task notes" }));
    expect(await screen.findByText("npm run check")).toBeInTheDocument();
    expect(screen.getByText("npm run check").tagName).toBe("CODE");
  });

  it("manages tasks with add, edit, status, notes, and delete controls", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail({
          capabilities: {
            taskMutation: {
              canAdd: true,
              canEditPending: true,
              canDeletePending: true,
              canEditNotes: true,
              canSetStatus: true,
            },
          },
          lockedFields: [],
          tasks: [
            {
              id: "draft",
              title: "Draft task",
              body: "Initial body",
              status: "pending",
              notes: "Initial notes",
            },
          ],
          tasksCompleted: 0,
          tasksTotal: 1,
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));
    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Tasks",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(await screen.findByRole("dialog", { name: "Create task" })).toBeInTheDocument();
    expect(screen.queryByText("Reference preview")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Manual task");
    await user.type(screen.getByLabelText("Description"), "Manual task body");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button", { name: /Manual task/ })
          .some((button) => button.classList.contains("task-header")),
      ).toBe(true);
    });

    expect(screen.queryByLabelText("Task status for Draft task")).not.toBeInTheDocument();
    const draftHeader = screen
      .getAllByRole("button", { name: /Draft task/ })
      .find((button) => button.classList.contains("task-header"));
    if (!draftHeader) {
      throw new Error("Draft task header was not rendered");
    }
    await user.click(draftHeader);
    const draftArticle = draftHeader.closest("article");
    if (!draftArticle) {
      throw new Error("Draft task article was not rendered");
    }
    expect(within(draftArticle).queryByRole("button", { name: "Edit Draft task" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit tasks" }));
    expect(screen.getByRole("button", { name: "Exit task edit mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Task status for Draft task")).toBeInTheDocument();

    await user.click(within(draftArticle).getByRole("button", { name: "Edit Draft task" }));
    await user.clear(within(draftArticle).getByLabelText("Title"));
    await user.type(within(draftArticle).getByLabelText("Title"), "Edited task");
    await user.clear(within(draftArticle).getByLabelText("Body"));
    await user.type(within(draftArticle).getByLabelText("Body"), "Edited body");
    await user.click(within(draftArticle).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button", { name: /Edited task/ })
          .some((button) => button.classList.contains("task-header")),
      ).toBe(true);
    });

    await user.selectOptions(screen.getByLabelText("Task status for Edited task"), "completed");
    await waitFor(() => {
      expect(screen.getByLabelText("Task status for Edited task")).toHaveValue("completed");
    });

    const editedHeaderForNotes = screen
      .getAllByRole("button", { name: /Edited task/ })
      .find((button) => button.classList.contains("task-header"));
    if (!editedHeaderForNotes) {
      throw new Error("Edited task header was not rendered");
    }
    if (editedHeaderForNotes.getAttribute("aria-expanded") !== "true") {
      await user.click(editedHeaderForNotes);
    }
    await user.click(await screen.findByRole("button", { name: "Task notes" }));
    const editedArticle = editedHeaderForNotes.closest("article");
    if (!editedArticle) {
      throw new Error("Edited task article was not rendered");
    }
    await user.click(within(editedArticle).getByRole("button", { name: "Edit Edited task" }));
    await user.clear(within(editedArticle).getByLabelText("Notes"));
    await user.type(within(editedArticle).getByLabelText("Notes"), "Replaced notes");
    await user.click(within(editedArticle).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(within(editedArticle).getByText("Replaced notes")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Delete Manual task" }));
    const deleteTaskDialog = await screen.findByRole("dialog", { name: "Delete task?" });
    expect(within(deleteTaskDialog).getByText(/Manual task/)).toBeInTheDocument();
    await user.click(within(deleteTaskDialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Manual task/ })).not.toBeInTheDocument();
    });
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
    expect(await screen.findByText("No matching runs")).toBeInTheDocument();
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
          },
        }),
        "run-search": makeDetail({
          runId: "run-search",
          name: "Search-only name",
          assignment: {
            name: "Different assignment",
            sourcePath: "/tmp/assignment.md",
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
    const longName = "plan feature · /home/kevin/worktrees/agent-runner-run-names";
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
          },
        }),
      },
    });

    await renderApp();

    const card = await screen.findByRole("button", { name: /plan feature/i });
    const title = card.querySelector(".card-title");
    expect(title).not.toBeNull();
    expect(card).toHaveAttribute("title", longName);
    expect(title).toHaveTextContent("plan feature · /home/kevin/worktrees/agen...");
    expect(card).not.toHaveTextContent(longName);
  });

  it("preserves the full active task title on cards while rendering it in the truncation wrapper", async () => {
    const longTaskTitle =
      "Investigate the long-running resume-start UX regression before the card layout expands unexpectedly";
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-long-task",
          assignmentName: "plan-feature",
          activeTask: { id: "long-task", title: longTaskTitle },
        }),
      ],
      details: {
        "run-long-task": makeDetail({
          runId: "run-long-task",
          assignment: {
            name: "plan-feature",
            sourcePath: "/tmp/assignment.md",
          },
          activeTask: { id: "long-task", title: longTaskTitle },
        }),
      },
    });

    await renderApp();

    const card = await screen.findByRole("button", { name: /plan-feature/i });
    const activeTask = card.querySelector(".active-task");
    const activeTaskText = card.querySelector(".active-task__text");
    expect(activeTask).not.toBeNull();
    expect(activeTaskText).not.toBeNull();
    expect(activeTask).toHaveAttribute("title", longTaskTitle);
    expect(activeTaskText).toHaveTextContent(longTaskTitle);
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
    const callsBeforeSave = fetchMock.mock.calls.length;
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
    const callsAfterSave = fetchMock.mock.calls
      .slice(callsBeforeSave)
      .map(([input]) => (typeof input === "string" ? input : input.toString()));
    expect(callsAfterSave).toEqual(["/api/runs/run-1/name"]);
  });

  it("previews and edits run notes from the card, then reuses the same note state in the drawer", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ notePresent: true })],
      details: {
        "run-1": makeDetail({
          note: "Initial note preview",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    const card = await findRunCard("Build dashboard");
    const cardContainer = card.closest(".card");
    if (!cardContainer) {
      throw new Error("expected card container");
    }

    const noteButton = within(cardContainer as HTMLElement).getByRole("button", {
      name: /preview or edit note for run run-1/i,
    });
    await user.hover(noteButton);
    expect(await screen.findByText("Initial note preview")).toBeInTheDocument();

    await user.click(noteButton);
    const noteInput = await screen.findByRole("textbox", {
      name: /run note for build dashboard/i,
    });
    expect(noteInput).toHaveFocus();
    await user.clear(noteInput);
    await user.type(noteInput, "# Dashboard polish{enter}{enter}Saved from card");
    const callsBeforeSave = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await user.click(card);
    await user.click(screen.getByRole("tab", { name: "Info" }));
    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Notes",
      }),
    );

    expect(await screen.findByText("Dashboard polish")).toBeInTheDocument();
    expect(screen.getByText("Saved from card")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/note",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ note: "# Dashboard polish\n\nSaved from card" }),
      }),
    );
    const callsAfterSave = fetchMock.mock.calls
      .slice(callsBeforeSave)
      .map(([input]) => (typeof input === "string" ? input : input.toString()));
    expect(callsAfterSave.filter((url) => url === "/api/runs/run-1/note")).toEqual([
      "/api/runs/run-1/note",
    ]);
  });

  it("defaults the card note dialog to preview mode for touch-style pointers", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches:
          query === "(hover: none)" ||
          query === "(pointer: coarse)" ||
          query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
    installFetchMock({
      runs: [makeRun({ notePresent: true })],
      details: {
        "run-1": makeDetail({
          note: "Touch-first note",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    const card = await findRunCard("Build dashboard");
    const cardContainer = card.closest(".card");
    if (!cardContainer) {
      throw new Error("expected card container");
    }

    await user.click(
      within(cardContainer as HTMLElement).getByRole("button", {
        name: /preview or edit note for run run-1/i,
      }),
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View" })).not.toBeInTheDocument();
    expect(await screen.findByText("Touch-first note")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /run note for build dashboard/i }),
    ).not.toBeInTheDocument();
  });

  it("closes the card note dialog on outside click", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    const card = await findRunCard("Build dashboard");
    const cardContainer = card.closest(".card");
    if (!cardContainer) {
      throw new Error("expected card container");
    }

    await user.click(
      within(cardContainer as HTMLElement).getByRole("button", {
        name: /add note for run run-1/i,
      }),
    );
    const noteDialog = await screen.findByRole("dialog", { name: "Build dashboard" });
    const noteDialogSurface = noteDialog.querySelector(".note-dialog");
    if (!noteDialogSurface) {
      throw new Error("expected note dialog surface");
    }

    fireEvent.click(noteDialogSurface);

    expect(screen.getByRole("dialog", { name: "Build dashboard" })).toBeInTheDocument();

    fireEvent.click(noteDialog);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Build dashboard" })).not.toBeInTheDocument();
    });
  });

  it("closes the card note dialog from editor Cancel", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    const card = await findRunCard("Build dashboard");
    const cardContainer = card.closest(".card");
    if (!cardContainer) {
      throw new Error("expected card container");
    }

    await user.click(
      within(cardContainer as HTMLElement).getByRole("button", {
        name: /add note for run run-1/i,
      }),
    );
    expect(await screen.findByRole("dialog", { name: "Build dashboard" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Build dashboard" })).not.toBeInTheDocument();
    });
  });

  it("closes the card note dialog from no-op Save without sending a note request", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp();

    const card = await findRunCard("Build dashboard");
    const cardContainer = card.closest(".card");
    if (!cardContainer) {
      throw new Error("expected card container");
    }

    await user.click(
      within(cardContainer as HTMLElement).getByRole("button", {
        name: /add note for run run-1/i,
      }),
    );
    expect(await screen.findByRole("dialog", { name: "Build dashboard" })).toBeInTheDocument();

    const callsBeforeSave = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Build dashboard" })).not.toBeInTheDocument();
    });
    expect(
      fetchMock.mock.calls
        .slice(callsBeforeSave)
        .some(([input]) => String(input).endsWith("/api/runs/run-1/note")),
    ).toBe(false);
  });

  it("shows backend-session editing only for passive runs and preserves the row when empty", async () => {
    installFetchMock({
      runs: [
        makeRun({ runId: "passive-run", assignmentName: "Passive run", backend: "passive" }),
        makeRun({ runId: "codex-run", assignmentName: "Codex run", backend: "codex" }),
      ],
      details: {
        "passive-run": makeDetail({
          runId: "passive-run",
          backend: "passive",
          model: null,
          effort: null,
          name: "Passive run",
          assignment: {
            name: "Passive run",
            sourcePath: "/tmp/a.md",
          },
          backendSessionId: null,
          capabilities: { canResume: false },
        }),
        "codex-run": makeDetail({
          runId: "codex-run",
          backend: "codex",
          name: "Codex run",
          assignment: {
            name: "Codex run",
            sourcePath: "/tmp/a.md",
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Passive run"));
    expect(screen.queryByRole("button", { name: "Timing" })).not.toBeInTheDocument();
    expect(await screen.findByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit backend session/i })).toBeInTheDocument();

    await user.click(await findRunCard("Codex run"));
    expect(await screen.findByText("thread-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit backend session/i })).not.toBeInTheDocument();
  });

  it("saves and clears passive backend sessions from the detail drawer", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ runId: "passive-run", assignmentName: "Passive run", backend: "passive" })],
      details: {
        "passive-run": makeDetail({
          runId: "passive-run",
          backend: "passive",
          model: null,
          effort: null,
          name: "Passive run",
          assignment: {
            name: "Passive run",
            sourcePath: "/tmp/a.md",
          },
          backendSessionId: "thread-1",
          capabilities: { canResume: false },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Passive run"));

    await user.click(await screen.findByRole("button", { name: /edit backend session/i }));
    const input = screen.getByRole("textbox", { name: /backend session/i });
    await user.clear(input);
    await user.type(input, "thread-99");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText("thread-99")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/passive-run/backend-session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ backendSessionId: "thread-99" }),
      }),
    );

    await user.click(screen.getByRole("button", { name: /edit backend session/i }));
    await user.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => expect(screen.getByText("Not set")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/passive-run/backend-session/clear",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("treats saving an empty passive backend-session draft as a clear action", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ runId: "passive-run", assignmentName: "Passive run", backend: "passive" })],
      details: {
        "passive-run": makeDetail({
          runId: "passive-run",
          backend: "passive",
          model: null,
          effort: null,
          name: "Passive run",
          assignment: {
            name: "Passive run",
            sourcePath: "/tmp/a.md",
          },
          backendSessionId: "thread-1",
          capabilities: { canResume: false },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Passive run"));

    await user.click(await screen.findByRole("button", { name: /edit backend session/i }));
    const input = screen.getByRole("textbox", { name: /backend session/i });
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText("Not set")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/passive-run/backend-session/clear",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/runs/passive-run/backend-session",
      expect.objectContaining({
        body: JSON.stringify({ backendSessionId: "" }),
      }),
    );
  });

  it("cancels passive backend-session edits with Escape without mutating", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ runId: "passive-run", assignmentName: "Passive run", backend: "passive" })],
      details: {
        "passive-run": makeDetail({
          runId: "passive-run",
          backend: "passive",
          model: null,
          effort: null,
          name: "Passive run",
          assignment: {
            name: "Passive run",
            sourcePath: "/tmp/a.md",
          },
          backendSessionId: null,
          capabilities: { canResume: false },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Passive run"));
    await user.click(await screen.findByRole("button", { name: /edit backend session/i }));

    const input = screen.getByRole("textbox", { name: /backend session/i });
    await user.type(input, "thread-cancel");
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: /backend session/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/backend-session")),
    ).toHaveLength(0);
  });

  it("edits archived passive backend sessions from the detail drawer", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          runId: "archived-passive",
          assignmentName: "Archived passive run",
          backend: "passive",
          archivedAt: "2026-04-13T06:00:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "archived-passive": makeDetail({
          runId: "archived-passive",
          backend: "passive",
          model: null,
          effort: null,
          name: "Archived passive run",
          status: "success",
          archivedAt: "2026-04-13T06:00:00.000Z",
          assignment: {
            name: "Archived passive run",
            sourcePath: "/tmp/a.md",
          },
          capabilities: {
            canArchive: false,
            canUnarchive: true,
            canResume: false,
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /show archived runs/i }));
    await user.click(await findRunCard("Archived passive run"));
    await user.click(await screen.findByRole("button", { name: /edit backend session/i }));

    const input = screen.getByRole("textbox", { name: /backend session/i });
    await user.clear(input);
    await user.type(input, "archived-thread-2");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByText("archived-thread-2")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/archived-passive/backend-session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ backendSessionId: "archived-thread-2" }),
      }),
    );
  });

  it("edits run groups for non-running runs and shows inline validation errors", async () => {
    const postedGroups: string[] = [];
    installFetchMock(
      {
        runs: [
          makeRun({
            runId: "run-1",
            runGroupId: "group-a",
            status: "initialized",
            effectiveStatus: "initialized",
            name: "Grouped run",
          }),
        ],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            runGroupId: "group-a",
            status: "initialized",
            effectiveStatus: "initialized",
            name: "Grouped run",
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (/\/api\/runs\/run-1\/group$/.test(url) && init?.method === "POST") {
            const body =
              typeof init.body === "string" && init.body.length > 0
                ? (JSON.parse(init.body) as { runGroupId?: string })
                : {};
            if (body.runGroupId) {
              postedGroups.push(body.runGroupId);
            }
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Grouped run"));
    await waitFor(() => expect(screen.getAllByText("group-a/run-1").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "Edit run group" }));
    const groupInput = screen.getByRole("textbox", { name: "Run group" });
    await user.clear(groupInput);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Run group cannot be empty.")).toBeInTheDocument();

    await user.type(groupInput, "group-b");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(postedGroups).toEqual(["group-b"]));
    await waitFor(() => expect(screen.getAllByText("group-b/run-1").length).toBeGreaterThan(0));
  });

  it("persists compact toolbar sort controls", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: {
        "run-1": makeDetail(),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Build dashboard");

    expect(screen.getByRole("combobox", { name: "Sort by started time" })).toHaveValue("startedAt");
    expect(screen.getByRole("button", { name: "Latest first" })).toHaveAttribute(
      "title",
      "Latest first",
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort by started time" }),
      "updatedAt",
    );
    expect(screen.getByRole("combobox", { name: "Sort by last updated" })).toHaveValue("updatedAt");

    await user.click(screen.getByRole("button", { name: "Latest first" }));
    expect(screen.getByRole("button", { name: "Earliest first" })).toHaveAttribute(
      "title",
      "Earliest first",
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort by last updated" }),
      "endedAt",
    );
    expect(screen.getByRole("combobox", { name: "Sort by ended time" })).toHaveValue("endedAt");

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toEqual(
      expect.objectContaining({
        sortField: "endedAt",
        sortDirection: "asc",
      }),
    );
  });

  it("keeps toolbar toggles and settings rows synchronized through persisted preferences", async () => {
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
          },
          capabilities: {
            canArchive: false,
            canUnarchive: true,
            canResume: true,
            taskMutation: {
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
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
    expect(screen.queryByTitle("Archived dashboard")).not.toBeInTheDocument();
    expect(getBoardColumn("Failed")).toBeInTheDocument();
    expect(getBoardColumn("Blocked")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Aborted(?: \(\d+\))?$/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show archived runs/i }));
    await user.click(screen.getByRole("button", { name: /hide empty columns/i }));
    await user.click(screen.getByRole("button", { name: /collapse failure states/i }));
    expect(await screen.findByTitle("Archived dashboard")).toBeInTheDocument();
    expect(getBoardColumn("Blocked")).toBeInTheDocument();
    expect(getBoardColumn("Error")).toBeInTheDocument();
    expect(getBoardColumn("Aborted")).toBeInTheDocument();

    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();

    const collapseFailureStates = screen.getByRole("checkbox", {
      name: "Collapse failure states",
    });
    const showArchived = screen.getByRole("checkbox", { name: "Show archived runs" });
    const showScheduledOnly = screen.getByRole("checkbox", {
      name: "Show scheduled runs only",
    });
    const showPinnedOnly = screen.getByRole("checkbox", { name: "Show pinned runs only" });
    const boardSortField = screen.getByRole("combobox", { name: "Board sort field" });
    const boardSortDirection = screen.getByRole("combobox", { name: "Board sort direction" });
    const visibleFocusIndicators = screen.getByRole("checkbox", {
      name: "Visible focus indicators",
    });
    const appShell = document.querySelector(".app");
    expect(appShell).toHaveAttribute("data-focus-indicators", "off");
    expect(screen.queryByRole("checkbox", { name: "Hide empty columns" })).not.toBeInTheDocument();
    expect(collapseFailureStates).not.toBeChecked();
    expect(showArchived).toBeChecked();
    expect(showScheduledOnly).not.toBeChecked();
    expect(showPinnedOnly).not.toBeChecked();
    expect(boardSortField).toHaveValue("startedAt");
    expect(boardSortDirection).toHaveValue("desc");
    expect(visibleFocusIndicators).not.toBeChecked();

    await user.selectOptions(boardSortField, "updatedAt");
    await user.click(visibleFocusIndicators);
    expect(boardSortField).toHaveValue("updatedAt");
    expect(visibleFocusIndicators).toBeChecked();
    expect(appShell).toHaveAttribute("data-focus-indicators", "on");

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toEqual({
      hideEmptyColumns: false,
      collapseFailureStates: false,
      showArchived: true,
      showNotesOnly: false,
      showScheduledOnly: false,
      showPinnedOnly: false,
      sortField: "updatedAt",
      sortDirection: "desc",
      auditNewestFirst: false,
      visibleFocusIndicators: true,
      themeMode: "auto",
      structuredFilters: {
        repo: null,
        agent: null,
        backend: null,
        runGroupId: null,
      },
    });

    view.unmount();
    queryClient.clear();
    await renderApp();
    await findRunCard("Build dashboard");
    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show archived runs" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Board sort field" })).toHaveValue("updatedAt");
    expect(screen.getByRole("combobox", { name: "Board sort direction" })).toHaveValue("desc");
    expect(screen.getByRole("checkbox", { name: "Visible focus indicators" })).toBeChecked();
    expect(document.querySelector(".app")).toHaveAttribute("data-focus-indicators", "on");

    await user.click(getSidebarNavigation().getByRole("button", { name: "Runs" }));
    expect(await screen.findByTitle("Archived dashboard")).toBeInTheDocument();
    expect(getBoardColumn("Error")).toBeInTheDocument();
    expect(getBoardColumn("Aborted")).toBeInTheDocument();
  });

  it("uses separate archived and hidden list queries when toggling archived visibility", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({ assignmentName: "Active dashboard", name: "Active dashboard" }),
        makeRun({
          runId: "run-archived",
          assignmentName: "Archived dashboard",
          archivedAt: "2026-04-13T06:00:00.000Z",
          name: "Archived dashboard",
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: { name: "Active dashboard", sourcePath: "/tmp/active.md" },
          name: "Active dashboard",
        }),
        "run-archived": makeDetail({
          runId: "run-archived",
          archivedAt: "2026-04-13T06:00:00.000Z",
          assignment: { name: "Archived dashboard", sourcePath: "/tmp/archived.md" },
          name: "Archived dashboard",
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    expect(await findRunCard("Active dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archived dashboard/i })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs?includeArchived=false",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(
      queryClient
        .getQueryData<RunSummary[]>(runQueryKeys.list({ includeArchived: false, runGroupId: null }))
        ?.map((run) => run.runId),
    ).toEqual(["run-1"]);

    await user.click(screen.getByRole("button", { name: /show archived runs/i }));
    expect(await findRunCard("Archived dashboard")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs?includeArchived=true",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(
      queryClient
        .getQueryData<RunSummary[]>(runQueryKeys.list({ includeArchived: true, runGroupId: null }))
        ?.map((run) => run.runId)
        .sort(),
    ).toEqual(["run-1", "run-archived"]);

    await user.click(screen.getByRole("button", { name: /show archived runs/i }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Archived dashboard/i })).not.toBeInTheDocument();
    });
    expect(
      queryClient.getQueryState(runQueryKeys.list({ includeArchived: true, runGroupId: null })),
    ).toBeUndefined();
  });

  it("removes archived list queries after archived visibility is toggled off from settings", async () => {
    setStoredDashboardPreferences({ showArchived: true });
    installFetchMock({
      runs: [
        makeRun({ assignmentName: "Active dashboard", name: "Active dashboard" }),
        makeRun({
          runId: "run-archived",
          assignmentName: "Archived dashboard",
          archivedAt: "2026-04-13T06:00:00.000Z",
          name: "Archived dashboard",
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: { name: "Active dashboard", sourcePath: "/tmp/active.md" },
          name: "Active dashboard",
        }),
        "run-archived": makeDetail({
          runId: "run-archived",
          archivedAt: "2026-04-13T06:00:00.000Z",
          assignment: { name: "Archived dashboard", sourcePath: "/tmp/archived.md" },
          name: "Archived dashboard",
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    expect(await findRunCard("Archived dashboard")).toBeInTheDocument();
    const archivedKey = runQueryKeys.list({ includeArchived: true, runGroupId: null });
    expect(queryClient.getQueryState(archivedKey)).toBeDefined();

    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Show archived runs" }));
    expect(screen.getByRole("checkbox", { name: "Show archived runs" })).not.toBeChecked();

    await user.click(getSidebarNavigation().getByRole("button", { name: "Runs" }));
    expect(await findRunCard("Active dashboard")).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryState(archivedKey)).toBeUndefined());
    expect(screen.queryByRole("button", { name: /Archived dashboard/i })).not.toBeInTheDocument();
  });

  it("sorts pinned runs first within each status column and persists the pinned-only filter", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "running-pinned",
          assignmentName: "Pinned running",
          name: "Pinned running",
          pinned: true,
          startedAt: "2026-04-13T05:00:00.000Z",
        }),
        makeRun({
          runId: "running-newest",
          assignmentName: "Newest running",
          name: "Newest running",
          startedAt: "2026-04-13T05:05:00.000Z",
        }),
        makeRun({
          runId: "completed-pinned",
          assignmentName: "Pinned completed",
          name: "Pinned completed",
          pinned: true,
          startedAt: "2026-04-13T04:50:00.000Z",
          status: "success",
        }),
        makeRun({
          runId: "completed-newest",
          assignmentName: "Newest completed",
          name: "Newest completed",
          startedAt: "2026-04-13T05:10:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "running-pinned": makeDetail({
          runId: "running-pinned",
          name: "Pinned running",
          pinned: true,
          assignment: {
            name: "Pinned running",
            sourcePath: "/tmp/pinned-running.md",
          },
          startedAt: "2026-04-13T05:00:00.000Z",
        }),
        "running-newest": makeDetail({
          runId: "running-newest",
          name: "Newest running",
          assignment: {
            name: "Newest running",
            sourcePath: "/tmp/newest-running.md",
          },
          startedAt: "2026-04-13T05:05:00.000Z",
        }),
        "completed-pinned": makeDetail({
          runId: "completed-pinned",
          name: "Pinned completed",
          pinned: true,
          assignment: {
            name: "Pinned completed",
            sourcePath: "/tmp/pinned-completed.md",
          },
          startedAt: "2026-04-13T04:50:00.000Z",
          status: "success",
        }),
        "completed-newest": makeDetail({
          runId: "completed-newest",
          name: "Newest completed",
          assignment: {
            name: "Newest completed",
            sourcePath: "/tmp/newest-completed.md",
          },
          startedAt: "2026-04-13T05:10:00.000Z",
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Pinned running");

    expect(getColumnRunNames("Running")).toEqual(["Pinned running", "Newest running"]);
    expect(getColumnRunNames("Completed")).toEqual(["Pinned completed", "Newest completed"]);

    await user.click(screen.getByRole("button", { name: /show pinned runs only/i }));
    expect(await findRunCard("Pinned running")).toBeInTheDocument();
    expect(await findRunCard("Pinned completed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /newest running/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /newest completed/i })).not.toBeInTheDocument();

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      showPinnedOnly: true,
    });

    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("checkbox", { name: "Show pinned runs only" })).toBeChecked();
  });

  it("filters board-visible runs to notes only and persists the quick toggle", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-noted",
          assignmentName: "Noted dashboard",
          name: "Noted dashboard",
          notePresent: true,
        }),
        makeRun({
          runId: "run-plain",
          assignmentName: "Plain dashboard",
          name: "Plain dashboard",
          notePresent: false,
        }),
      ],
      details: {
        "run-noted": makeDetail({
          runId: "run-noted",
          assignment: {
            name: "Noted dashboard",
            sourcePath: "/tmp/noted-a.md",
          },
          note: "already tracked",
        }),
        "run-plain": makeDetail({
          runId: "run-plain",
          assignment: {
            name: "Plain dashboard",
            sourcePath: "/tmp/plain-a.md",
          },
          note: null,
        }),
      },
    });

    const user = userEvent.setup();
    const view = await renderApp();
    await findRunCard("Noted dashboard");
    expect(screen.getByRole("button", { name: /plain dashboard/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show runs with notes only/i }));

    expect(await findRunCard("Noted dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /plain dashboard/i })).not.toBeInTheDocument();

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      showNotesOnly: true,
    });

    view.unmount();
    queryClient.clear();

    await renderApp();
    expect(await findRunCard("Noted dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /plain dashboard/i })).not.toBeInTheDocument();
  });

  it("pins a selected run and updates canonical timestamps from the mutation result", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ assignmentName: "Build dashboard" })],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Build dashboard",
            sourcePath: "/tmp/a.md",
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const callsBefore = fetchMock.mock.calls.length;
    await user.click(await screen.findByRole("button", { name: "Pin run" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin run" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    const callsAfter = fetchMock.mock.calls
      .slice(callsBefore)
      .map(([input]) => (typeof input === "string" ? input : input.toString()));
    expect(callsAfter).toEqual(["/api/runs/run-1/pinned"]);
  });

  it("opens the selected run Notes tab with n, focuses the editor, and saves with Alt+Enter", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ assignmentName: "Build dashboard" })],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Build dashboard",
            sourcePath: "/tmp/a.md",
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    await user.keyboard("n");
    const tablist = await screen.findByRole("tablist", { name: "Run surface" });
    expect(within(tablist).getByRole("tab", { name: "Notes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("dialog", { name: "Build dashboard" })).not.toBeInTheDocument();

    await user.keyboard("n");
    const noteInput = await screen.findByRole("textbox", {
      name: /run note for build dashboard/i,
    });
    expect(noteInput).toHaveFocus();

    const callsBeforeSuppressedPin = fetchMock.mock.calls.length;
    await user.type(noteInput, "Keyboard note");
    await user.keyboard("p");
    expect(
      fetchMock.mock.calls
        .slice(callsBeforeSuppressedPin)
        .some(([input]) => String(input).endsWith("/api/runs/run-1/pinned")),
    ).toBe(false);
    expect(noteInput).toHaveValue("Keyboard notep");

    fireEvent.keyDown(noteInput, { altKey: true, key: "Enter" });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-1/note",
        expect.objectContaining({
          body: JSON.stringify({ note: "Keyboard notep" }),
          method: "POST",
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: /run note for build dashboard/i }),
      ).not.toBeInTheDocument(),
    );

    await user.keyboard("n");
    const dirtyNoteInput = await screen.findByRole("textbox", {
      name: /run note for build dashboard/i,
    });
    await user.type(dirtyNoteInput, " dirty");
    await user.keyboard("{Escape}");
    const confirmDialog = await screen.findByRole("dialog", { name: "Save note changes?" });
    await user.click(within(confirmDialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Save note changes?" })).not.toBeInTheDocument(),
    );
    expect(dirtyNoteInput).toHaveFocus();
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("dialog", { name: "Save note changes?" })).getByRole(
        "button",
        {
          name: "Discard",
        },
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: /run note for build dashboard/i }),
      ).not.toBeInTheDocument(),
    );

    const callsBeforePin = fetchMock.mock.calls.length;
    await user.keyboard("p");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unpin run" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    const callsAfterPin = fetchMock.mock.calls
      .slice(callsBeforePin)
      .map(([input]) => (typeof input === "string" ? input : input.toString()));
    expect(callsAfterPin).toEqual(["/api/runs/run-1/pinned"]);
  });

  it("toggles archive for the selected run with a", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Archive ready",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Archive ready",
            sourcePath: "/tmp/archive-a.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Archive ready"));

    const callsBeforeArchive = fetchMock.mock.calls.length;
    await user.keyboard("{Shift>}a{/Shift}");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-1/archive",
        expect.objectContaining({
          method: "POST",
        }),
      ),
    );

    const callsAfterArchive = fetchMock.mock.calls
      .slice(callsBeforeArchive)
      .map(([input]) => (typeof input === "string" ? input : input.toString()));
    expect(callsAfterArchive).toEqual(["/api/runs/run-1/archive"]);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Archive ready/i })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/runs/run-1");
  });

  it("opens the run action menu on right-click without selecting the card", async () => {
    installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Menu ready",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Menu ready",
            sourcePath: "/tmp/menu-ready.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    await renderApp();
    const card = await findRunCard("Menu ready");
    expect(router.state.location.pathname).toBe("/");

    expect(fireEvent.contextMenu(document.body, { clientX: 4, clientY: 4 })).toBe(true);
    expect(fireEvent.contextMenu(card, { clientX: 48, clientY: 56 })).toBe(false);

    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());
    const menu = getRunActionMenuElement();
    expect(within(menu).getByText("Archive")).toBeInTheDocument();
    expect(within(menu).getByText("Archive + Delete")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByLabelText("Run detail")).not.toBeInTheDocument();

    fireEvent.pointerDown(document.body, { clientX: 2, clientY: 2 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).not.toBeInTheDocument());
  });

  it("activates primary run action menu items for the menu run", async () => {
    let startBody: { overrides?: { message?: string } } | undefined;
    const fetchMock = installFetchMock(
      {
        runs: [
          makeRun({
            runId: "run-ready",
            assignmentName: "Ready from menu",
            status: "initialized",
            totalAttemptCount: 0,
            capabilities: {
              canReady: true,
              canResume: false,
            },
          }),
          makeRun({
            runId: "run-start",
            assignmentName: "Start from menu",
            status: "ready",
            totalAttemptCount: 0,
            capabilities: {
              canReady: false,
              canResume: true,
            },
          }),
        ],
        details: {
          "run-ready": makeDetail({
            runId: "run-ready",
            assignment: {
              name: "Ready from menu",
              sourcePath: "/tmp/ready-from-menu.md",
            },
            status: "initialized",
            totalAttemptCount: 0,
            capabilities: {
              canReady: true,
              canResume: false,
            },
          }),
          "run-start": makeDetail({
            runId: "run-start",
            assignment: {
              name: "Start from menu",
              sourcePath: "/tmp/start-from-menu.md",
            },
            status: "ready",
            totalAttemptCount: 0,
            capabilities: {
              canReady: false,
              canResume: true,
            },
          }),
        },
      },
      {
        handleRequest: async (url, init) => {
          if (url.endsWith("/api/runs/run-start/resume") && init?.method === "POST") {
            startBody =
              typeof init.body === "string"
                ? (JSON.parse(init.body) as { overrides?: { message?: string } })
                : undefined;
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    fireEvent.contextMenu(await findRunCard("Ready from menu"), { clientX: 48, clientY: 56 });
    await user.click(within(getRunActionMenuElement()).getByText("Ready"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-ready/ready",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(router.state.location.pathname).toBe("/");

    fireEvent.contextMenu(await findRunCard("Start from menu"), { clientX: 48, clientY: 56 });
    await user.click(within(getRunActionMenuElement()).getByText("Start"));
    await waitFor(() => {
      expect(startBody).toEqual({ overrides: {} });
    });
    expect(router.state.location.pathname).toBe("/");
  });

  it("opens the resume dialog from an unselected run action menu", async () => {
    let resumeRequestCount = 0;
    installFetchMock(
      {
        runs: [
          makeRun({
            runId: "run-resume",
            assignmentName: "Resume from menu",
            status: "success",
            capabilities: {
              canReady: false,
              canResume: true,
            },
          }),
        ],
        details: {
          "run-resume": makeDetail({
            runId: "run-resume",
            assignment: {
              name: "Resume from menu",
              sourcePath: "/tmp/resume-from-menu.md",
            },
            status: "success",
            tasks: [
              {
                id: "orient",
                title: "Orient",
                body: "Read the repo",
                status: "completed",
                notes: "done",
              },
              {
                id: "ship",
                title: "Ship it",
                body: "Land the change",
                status: "completed",
                notes: "done",
              },
            ],
            tasksCompleted: 2,
            tasksTotal: 2,
            capabilities: {
              canReady: false,
              canResume: true,
            },
          }),
        },
      },
      {
        handleRequest: async (url, init) => {
          if (url.endsWith("/api/runs/run-resume/resume") && init?.method === "POST") {
            resumeRequestCount += 1;
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    fireEvent.contextMenu(await findRunCard("Resume from menu"), { clientX: 48, clientY: 56 });
    await user.click(within(getRunActionMenuElement()).getByText("Resume"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/run-resume"));
    const resumeDialog = await screen.findByRole("dialog", { name: "Resume run" });
    expect(within(resumeDialog).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(resumeDialog).getByLabelText("Message")).toBeInTheDocument();
    expect(resumeRequestCount).toBe(0);
  });

  it("uses menu Archive and Unarchive without selecting the card", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          runId: "run-archive",
          assignmentName: "Archive from menu",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
        makeRun({
          runId: "run-unarchive",
          archivedAt: "2026-04-13T06:00:00.000Z",
          assignmentName: "Unarchive from menu",
          capabilities: {
            canArchive: false,
            canDelete: true,
            canReset: false,
            canResume: false,
            canUnarchive: true,
          },
          status: "success",
        }),
      ],
      details: {
        "run-archive": makeDetail({
          runId: "run-archive",
          assignment: {
            name: "Archive from menu",
            sourcePath: "/tmp/archive-from-menu.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
        "run-unarchive": makeDetail({
          runId: "run-unarchive",
          archivedAt: "2026-04-13T06:00:00.000Z",
          assignment: {
            name: "Unarchive from menu",
            sourcePath: "/tmp/unarchive-from-menu.md",
          },
          capabilities: {
            canArchive: false,
            canDelete: true,
            canReset: false,
            canResume: false,
            canUnarchive: true,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    fireEvent.contextMenu(await findRunCard("Archive from menu"), { clientX: 48, clientY: 56 });
    await user.click(within(getRunActionMenuElement()).getByText("Archive"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-archive/archive",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(router.state.location.pathname).toBe("/");

    await user.click(await screen.findByRole("button", { name: /show archived runs/i }));
    fireEvent.contextMenu(await findRunCard("Unarchive from menu"), { clientX: 48, clientY: 56 });
    await user.click(within(getRunActionMenuElement()).getByText("Unarchive"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-unarchive/unarchive",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(router.state.location.pathname).toBe("/");
  });

  it("closes the run action menu on Escape without closing the selected run", async () => {
    installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Menu escape",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Menu escape",
            sourcePath: "/tmp/menu-escape.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    const card = await findRunCard("Menu escape");
    await user.click(card);
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/run-1"));
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    fireEvent.contextMenu(await findRunCard("Menu escape"), { clientX: 48, clientY: 56 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(document.querySelector(".run-action-menu")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/runs/run-1");
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
  });

  it("closes an open run action menu before Shift+D opens selected-run confirmation", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-selected",
          assignmentName: "Selected cleanup",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
        makeRun({
          runId: "run-menu",
          assignmentName: "Menu cleanup",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-selected": makeDetail({
          runId: "run-selected",
          assignment: {
            name: "Selected cleanup",
            sourcePath: "/tmp/selected-cleanup.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
        "run-menu": makeDetail({
          runId: "run-menu",
          assignment: {
            name: "Menu cleanup",
            sourcePath: "/tmp/menu-cleanup.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Selected cleanup"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/run-selected"));

    fireEvent.contextMenu(await findRunCard("Menu cleanup"), { clientX: 48, clientY: 56 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());
    await user.keyboard("{Shift>}d{/Shift}");

    expect(
      await screen.findByRole("dialog", { name: "Archive and delete run?" }),
    ).toBeInTheDocument();
    expect(document.querySelector(".run-action-menu")).not.toBeInTheDocument();
  });

  it("does not open the run action menu from mouse pointerdown", async () => {
    installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Mouse pointer menu",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Mouse pointer menu",
            sourcePath: "/tmp/mouse-pointer-menu.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    await renderApp();
    const card = await findRunCard("Mouse pointer menu");

    dispatchPointerEvent(card, "pointerdown", {
      button: 0,
      clientX: 64,
      clientY: 72,
      pointerType: "mouse",
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 540));
    });

    expect(document.querySelector(".run-action-menu")).not.toBeInTheDocument();
  });

  it("opens the run action menu on touch long-press and shows empty menus", async () => {
    installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Long press menu",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
        makeRun({
          runId: "run-empty",
          assignmentName: "No menu actions",
          capabilities: {
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Long press menu",
            sourcePath: "/tmp/long-press-menu.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
        "run-empty": makeDetail({
          runId: "run-empty",
          assignment: {
            name: "No menu actions",
            sourcePath: "/tmp/no-menu-actions.md",
          },
          capabilities: {
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    await renderApp();
    const menuCard = await findRunCard("Long press menu");
    expect(router.state.location.pathname).toBe("/");

    dispatchPointerEvent(menuCard, "pointerdown", {
      button: 0,
      clientX: 64,
      clientY: 72,
      pointerType: "touch",
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 540));
    });

    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByLabelText("Run detail")).not.toBeInTheDocument();

    dispatchPointerEvent(await findRunCard("No menu actions"), "pointerdown", {
      button: 0,
      clientX: 70,
      clientY: 80,
      pointerType: "touch",
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 540));
    });

    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByLabelText("Run detail")).not.toBeInTheDocument();
    const emptyMenu = getRunActionMenuElement();
    expect(emptyMenu).toHaveAttribute("aria-label", "Run actions for run-empty");
    expect(within(emptyMenu).getByText("No available actions")).toBeInTheDocument();
  });

  it("clears long-press click suppression when no synthetic click arrives", async () => {
    installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Long press clears",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Long press clears",
            sourcePath: "/tmp/long-press-clears.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    const card = await findRunCard("Long press clears");

    dispatchPointerEvent(card, "pointerdown", {
      button: 0,
      clientX: 64,
      clientY: 72,
      pointerType: "touch",
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 540));
    });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());

    fireEvent.pointerDown(document.body, { clientX: 2, clientY: 2 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).not.toBeInTheDocument());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 940));
    });
    await user.click(card);

    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/run-1"));
  });

  it("closes the run action menu when the menu target leaves the run list", async () => {
    installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Removed menu target",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Removed menu target",
            sourcePath: "/tmp/removed-menu-target.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    await renderApp();
    fireEvent.contextMenu(await findRunCard("Removed menu target"), { clientX: 40, clientY: 48 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitMessage({ type: "summary_removed", runId: "run-1" });

    await waitFor(() => expect(document.querySelector(".run-action-menu")).not.toBeInTheDocument());
  });

  it("requires confirmation before menu Archive + Delete runs archive then delete", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Cleanup from menu",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Cleanup from menu",
            sourcePath: "/tmp/cleanup-from-menu.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    fireEvent.contextMenu(await findRunCard("Cleanup from menu"), { clientX: 40, clientY: 48 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());
    await user.click(within(getRunActionMenuElement()).getByText("Archive + Delete"));
    expect(screen.getByRole("button", { name: "Archive + Delete" })).toBeInTheDocument();

    const callsBeforeCancel = fetchMutationUrls(fetchMock).length;
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMutationUrls(fetchMock)).toHaveLength(callsBeforeCancel);

    fireEvent.contextMenu(await findRunCard("Cleanup from menu"), { clientX: 40, clientY: 48 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());
    await user.click(within(getRunActionMenuElement()).getByText("Archive + Delete"));
    await user.click(screen.getByRole("button", { name: "Archive + Delete" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-1/archive",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(fetchMutationUrls(fetchMock).slice(-2)).toEqual([
      "/api/runs/run-1/archive",
      "/api/runs/run-1",
    ]);
  });

  it("keeps the archive failure visible when menu Archive + Delete cannot delete", async () => {
    const fetchMock = installFetchMock(
      {
        runs: [
          makeRun({
            assignmentName: "Cleanup delete failure",
            capabilities: {
              canArchive: true,
              canReset: false,
              canResume: false,
            },
            status: "success",
          }),
        ],
        details: {
          "run-1": makeDetail({
            assignment: {
              name: "Cleanup delete failure",
              sourcePath: "/tmp/cleanup-delete-failure.md",
            },
            capabilities: {
              canArchive: true,
              canReset: false,
              canResume: false,
            },
            status: "success",
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (url.endsWith("/api/runs/run-1") && init?.method === "DELETE") {
            return new Response(JSON.stringify({ error: { message: "delete failed" } }), {
              status: 500,
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    fireEvent.contextMenu(await findRunCard("Cleanup delete failure"), {
      clientX: 40,
      clientY: 48,
    });
    await user.click(within(getRunActionMenuElement()).getByText("Archive + Delete"));
    await user.click(screen.getByRole("button", { name: "Archive + Delete" }));

    await waitFor(() =>
      expect(fetchMutationUrls(fetchMock).slice(-2)).toEqual([
        "/api/runs/run-1/archive",
        "/api/runs/run-1",
      ]),
    );
  });

  it("re-checks destructive capabilities before submitting menu confirmation", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Capability changed cleanup",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Capability changed cleanup",
            sourcePath: "/tmp/capability-changed-cleanup.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Capability changed cleanup"));
    fireEvent.contextMenu(await findRunCard("Capability changed cleanup"), {
      clientX: 40,
      clientY: 48,
    });
    await user.click(within(getRunActionMenuElement()).getByText("Archive + Delete"));
    expect(
      await screen.findByRole("dialog", { name: "Archive and delete run?" }),
    ).toBeInTheDocument();

    const detailSource = findEventSource("/api/runs/run-1/events/detail");
    detailSource.emitMessage({
      type: "detail_updated",
      detail: makeDetail({
        assignment: {
          name: "Capability changed cleanup",
          sourcePath: "/tmp/capability-changed-cleanup.md",
        },
        capabilities: {
          canArchive: false,
          canReset: false,
          canResume: false,
        },
        status: "success",
      }),
    });

    await user.click(screen.getByRole("button", { name: "Archive + Delete" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Archive and delete run?" }),
      ).not.toBeInTheDocument(),
    );
    expect(fetchMutationUrls(fetchMock)).toEqual([]);
  });

  it("requires confirmation before menu Delete deletes an archived run", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          runId: "run-archived",
          assignmentName: "Delete from menu",
          archivedAt: "2026-04-13T06:00:00.000Z",
          capabilities: {
            canArchive: false,
            canDelete: true,
            canResume: false,
            canUnarchive: true,
          },
          status: "success",
        }),
      ],
      details: {
        "run-archived": makeDetail({
          runId: "run-archived",
          archivedAt: "2026-04-13T06:00:00.000Z",
          assignment: {
            name: "Delete from menu",
            sourcePath: "/tmp/delete-from-menu.md",
          },
          capabilities: {
            canArchive: false,
            canDelete: true,
            canResume: false,
            canUnarchive: true,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /show archived runs/i }));

    fireEvent.contextMenu(await findRunCard("Delete from menu"), { clientX: 42, clientY: 50 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());
    await user.click(within(getRunActionMenuElement()).getByText("Delete"));
    const firstDialog = screen.getByRole("dialog", { name: "Delete run?" });
    expect(within(firstDialog).getByRole("button", { name: "Delete" })).toBeInTheDocument();

    const callsBeforeCancel = fetchMutationUrls(fetchMock).length;
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMutationUrls(fetchMock)).toHaveLength(callsBeforeCancel);

    fireEvent.contextMenu(await findRunCard("Delete from menu"), { clientX: 42, clientY: 50 });
    await waitFor(() => expect(document.querySelector(".run-action-menu")).toBeInTheDocument());
    await user.click(within(getRunActionMenuElement()).getByText("Delete"));
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete run?" })).getByRole("button", {
        name: "Delete",
      }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-archived",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(fetchMutationUrls(fetchMock).slice(-1)).toEqual(["/api/runs/run-archived"]);
  });

  it("leaves Shift+D unhandled when the selected run cannot archive or delete", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          assignmentName: "No cleanup shortcut",
          capabilities: {
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "No cleanup shortcut",
            sourcePath: "/tmp/no-cleanup-shortcut.md",
          },
          capabilities: {
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("No cleanup shortcut"));

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "D",
      shiftKey: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("button", { name: "Archive + Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /delete run/i })).not.toBeInTheDocument();
    expect(fetchMutationUrls(fetchMock)).toEqual([]);
  });

  it("uses Shift+D to confirm Archive + Delete or Delete for the selected run", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          assignmentName: "Shortcut cleanup",
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
        makeRun({
          runId: "run-archived",
          assignmentName: "Shortcut archived delete",
          archivedAt: "2026-04-13T06:00:00.000Z",
          capabilities: {
            canArchive: false,
            canDelete: true,
            canResume: false,
            canUnarchive: true,
          },
          status: "success",
        }),
      ],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Shortcut cleanup",
            sourcePath: "/tmp/shortcut-cleanup.md",
          },
          capabilities: {
            canArchive: true,
            canReset: false,
            canResume: false,
          },
          status: "success",
        }),
        "run-archived": makeDetail({
          runId: "run-archived",
          archivedAt: "2026-04-13T06:00:00.000Z",
          assignment: {
            name: "Shortcut archived delete",
            sourcePath: "/tmp/shortcut-archived-delete.md",
          },
          capabilities: {
            canArchive: false,
            canDelete: true,
            canResume: false,
            canUnarchive: true,
          },
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Shortcut cleanup"));

    await user.keyboard("{Shift>}d{/Shift}");
    expect(await screen.findByRole("button", { name: "Archive + Delete" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMutationUrls(fetchMock).filter((url) => url.includes("run-1"))).toEqual([]);

    await user.keyboard("{Shift>}d{/Shift}");
    await user.click(await screen.findByRole("button", { name: "Archive + Delete" }));
    await waitFor(() =>
      expect(fetchMutationUrls(fetchMock)).toEqual(["/api/runs/run-1/archive", "/api/runs/run-1"]),
    );

    await user.click(await screen.findByRole("button", { name: /show archived runs/i }));
    await user.click(await findRunCard("Shortcut archived delete"));
    await user.keyboard("{Shift>}d{/Shift}");
    const deleteDialog = await screen.findByRole("dialog", { name: "Delete run?" });
    expect(within(deleteDialog).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchMutationUrls(fetchMock).slice(-1)).toEqual(["/api/runs/run-archived"]),
    );
  });

  it("suppresses Shift+D while another selected-run action is pending", async () => {
    let resolveArchive: (() => void) | undefined;
    const fetchMock = installFetchMock(
      {
        runs: [
          makeRun({
            assignmentName: "Pending cleanup",
            capabilities: {
              canArchive: true,
              canReset: false,
              canResume: false,
            },
            status: "success",
          }),
        ],
        details: {
          "run-1": makeDetail({
            assignment: {
              name: "Pending cleanup",
              sourcePath: "/tmp/pending-cleanup.md",
            },
            capabilities: {
              canArchive: true,
              canReset: false,
              canResume: false,
            },
            status: "success",
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (url.endsWith("/api/runs/run-1/archive") && init?.method === "POST") {
            return new Promise<Response>((resolve) => {
              resolveArchive = () =>
                resolve(
                  new Response(
                    JSON.stringify({
                      result: {
                        archivedAt: "2026-04-13T06:00:00.000Z",
                        changed: true,
                        runId: "run-1",
                        status: "success",
                        updatedAt: "2026-04-13T05:00:00.000Z",
                      },
                    }),
                    { status: 200 },
                  ),
                );
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Pending cleanup"));
    await user.keyboard("{Shift>}a{/Shift}");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-1/archive",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    await user.keyboard("{Shift>}d{/Shift}");
    expect(screen.queryByRole("button", { name: "Archive + Delete" })).not.toBeInTheDocument();

    resolveArchive?.();
  });

  it("uses Ctrl+Shift shortcuts for board filters without replacing plain selected-run actions", async () => {
    const schedule = {
      enabled: true,
      runAt: "2099-04-25T12:00:00.000Z",
      recurrence: null,
    };
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-pinned-noted",
          assignmentName: "Pinned noted",
          name: "Pinned noted",
          notePresent: true,
          pinned: true,
        }),
        makeRun({
          runId: "run-plain",
          assignmentName: "Plain run",
          name: "Plain run",
          notePresent: false,
        }),
        makeRun({
          runId: "run-scheduled",
          assignmentName: "Scheduled run",
          name: "Scheduled run",
          schedule,
          scheduleState: "future",
        }),
        makeRun({
          runId: "run-archived",
          archivedAt: "2026-04-13T06:00:00.000Z",
          assignmentName: "Archived noted",
          name: "Archived noted",
          notePresent: true,
          pinned: true,
          status: "success",
        }),
      ],
      details: {
        "run-pinned-noted": makeDetail({
          runId: "run-pinned-noted",
          assignment: {
            name: "Pinned noted",
            sourcePath: "/tmp/pinned-noted-a.md",
          },
          note: "keep visible",
          pinned: true,
        }),
        "run-plain": makeDetail({
          runId: "run-plain",
          assignment: {
            name: "Plain run",
            sourcePath: "/tmp/plain-run-a.md",
          },
          note: null,
        }),
        "run-scheduled": makeDetail({
          runId: "run-scheduled",
          assignment: {
            name: "Scheduled run",
            sourcePath: "/tmp/scheduled-run-a.md",
          },
          schedule,
          scheduleState: "future",
        }),
        "run-archived": makeDetail({
          runId: "run-archived",
          assignment: {
            name: "Archived noted",
            sourcePath: "/tmp/archived-noted-a.md",
          },
          archivedAt: "2026-04-13T06:00:00.000Z",
          note: "archived note",
          pinned: true,
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Pinned noted"));

    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    expect(screen.getByRole("button", { name: /show scheduled runs only/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await findRunCard("Scheduled run")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /plain run/i })).not.toBeInTheDocument();

    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    expect(screen.getByRole("button", { name: /show scheduled runs only/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");
    expect(screen.getByRole("button", { name: /show runs with notes only/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("button", { name: /plain run/i })).not.toBeInTheDocument();

    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    expect(screen.getByRole("button", { name: /show pinned runs only/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
    expect(screen.getByRole("button", { name: /show archived runs/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await findRunCard("Archived noted")).toBeInTheDocument();

    await user.keyboard("{Control>}{Shift>}e{/Shift}{/Control}");
    expect(screen.getByRole("button", { name: /hide empty columns/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(getBoardColumn("Aborted")).toBeInTheDocument();
  });

  it("restores the in-scope dashboard preferences to defaults from settings", async () => {
    installFetchMock({
      runs: [
        makeRun(),
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
    await renderApp("/settings/general");
    await screen.findByRole("heading", { name: "General" });

    expect(screen.queryByRole("checkbox", { name: "Hide empty columns" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Collapse failure states" }));
    await user.click(screen.getByRole("checkbox", { name: "Show archived runs" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Board sort field" }),
      "updatedAt",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Theme mode" }), "dark");
    await user.click(screen.getByRole("checkbox", { name: "Visible focus indicators" }));
    expect(document.querySelector(".app")).toHaveAttribute("data-focus-indicators", "on");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    await user.click(screen.getByRole("button", { name: "Restore defaults" }));

    expect(screen.queryByRole("checkbox", { name: "Hide empty columns" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Collapse failure states" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Show archived runs" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Board sort field" })).toHaveValue("startedAt");
    expect(screen.getByRole("combobox", { name: "Board sort direction" })).toHaveValue("desc");
    expect(screen.getByRole("combobox", { name: "Theme mode" })).toHaveValue("auto");
    expect(screen.getByRole("checkbox", { name: "Visible focus indicators" })).not.toBeChecked();
    expect(document.querySelector(".app")).toHaveAttribute("data-focus-indicators", "off");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(screen.getByRole("button", { name: "Restore defaults" })).toBeDisabled();

    await user.click(getSidebarNavigation().getByRole("button", { name: "Runs" }));

    expect(await screen.findByPlaceholderText("Search runs")).toBeInTheDocument();
    expect(screen.queryByTitle("Archived dashboard")).not.toBeInTheDocument();
    expect(getBoardColumn("Failed")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Aborted(?: \(\d+\))?$/ }),
    ).not.toBeInTheDocument();
  });

  it("does not render a settings row for hide empty columns", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp("/settings/general");
    await screen.findByRole("heading", { name: "General" });

    await user.click(screen.getByRole("checkbox", { name: "Show archived runs" }));

    expect(screen.queryByRole("checkbox", { name: "Hide empty columns" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reset Hide empty columns to default" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show archived runs" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Collapse failure states" })).toBeChecked();

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toEqual({
      hideEmptyColumns: true,
      collapseFailureStates: true,
      showArchived: true,
      showNotesOnly: false,
      showScheduledOnly: false,
      showPinnedOnly: false,
      sortField: "startedAt",
      sortDirection: "desc",
      auditNewestFirst: false,
      visibleFocusIndicators: false,
      themeMode: "auto",
      structuredFilters: {
        repo: null,
        agent: null,
        backend: null,
        runGroupId: null,
      },
    });
  });

  it("resets visible focus indicators without affecting the other settings", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp("/settings/general");
    await screen.findByRole("heading", { name: "General" });

    await user.click(screen.getByRole("checkbox", { name: "Show archived runs" }));
    await user.click(screen.getByRole("checkbox", { name: "Visible focus indicators" }));
    expect(document.querySelector(".app")).toHaveAttribute("data-focus-indicators", "on");

    await user.click(
      screen.getByRole("button", { name: "Reset Visible focus indicators to default" }),
    );

    expect(screen.getByRole("checkbox", { name: "Show archived runs" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Visible focus indicators" })).not.toBeChecked();
    expect(document.querySelector(".app")).toHaveAttribute("data-focus-indicators", "off");

    const stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toEqual({
      hideEmptyColumns: true,
      collapseFailureStates: true,
      showArchived: true,
      showNotesOnly: false,
      showScheduledOnly: false,
      showPinnedOnly: false,
      sortField: "startedAt",
      sortDirection: "desc",
      auditNewestFirst: false,
      visibleFocusIndicators: false,
      themeMode: "auto",
      structuredFilters: {
        repo: null,
        agent: null,
        backend: null,
        runGroupId: null,
      },
    });
  });

  it("persists and resets theme mode from settings", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const user = userEvent.setup();
    await renderApp("/settings/general");
    await screen.findByRole("heading", { name: "General" });

    const themeMode = screen.getByRole("combobox", { name: "Theme mode" });
    expect(themeMode).toHaveValue("auto");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(screen.getByRole("button", { name: "Restore defaults" })).toBeDisabled();

    await user.selectOptions(themeMode, "dark");
    expect(themeMode).toHaveValue("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("button", { name: "Restore defaults" })).toBeEnabled();

    let stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toEqual(
      expect.objectContaining({ themeMode: "dark" }),
    );

    await user.selectOptions(themeMode, "light");
    expect(themeMode).toHaveValue("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    stored = window.localStorage.getItem("agent-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toEqual(
      expect.objectContaining({ themeMode: "light" }),
    );

    await user.selectOptions(themeMode, "auto");
    expect(themeMode).toHaveValue("auto");
    expect(document.documentElement).not.toHaveAttribute("data-theme");

    await user.selectOptions(themeMode, "dark");
    await user.click(screen.getByRole("button", { name: "Reset Theme mode to default" }));
    expect(themeMode).toHaveValue("auto");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(screen.getByRole("button", { name: "Restore defaults" })).toBeDisabled();
  });

  it("keeps selected-card styling independent from focus-indicator suppression", () => {
    const css = readFileSync(join(process.cwd(), "src", "run-dashboard.css"), "utf8");

    expect(css).toContain('.app[data-focus-indicators="off"] :focus-visible');
    expect(css).toMatch(
      /\.app\[data-focus-indicators="off"\]\s+:focus-visible\s*\{\s*outline:\s*none;\s*\}/s,
    );
    expect(css).toMatch(
      /\n\.card\.selected\s*\{\s*border-color:\s*var\(--ring\);\s*box-shadow:\s*0 0 0 1px var\(--ring\), var\(--shadow-card\);\s*\}/s,
    );
  });

  it("defines forced theme selectors alongside automatic dark mode", () => {
    const css = readFileSync(join(process.cwd(), "src", "run-dashboard.css"), "utf8");
    const normalizeDeclarations = (declarations: string | undefined) =>
      declarations
        ?.split("\n")
        .map((line) => line.trim())
        .filter(Boolean) ?? [];
    const forcedDarkRootDeclarations = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(
      css,
    )?.[1];
    const automaticDarkRootDeclarations =
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}\s*\}/.exec(
        css,
      )?.[1];
    const forcedDarkScrollbarDeclarations =
      /:root\[data-theme="dark"\] ::-webkit-scrollbar-thumb,\s*:root\[data-theme="dark"\]::-webkit-scrollbar-thumb\s*\{([\s\S]*?)\n\s*\}/.exec(
        css,
      )?.[1];
    const automaticDarkScrollbarDeclarations =
      /:root:not\(\[data-theme="light"\]\) ::-webkit-scrollbar-thumb,\s*:root:not\(\[data-theme="light"\]\)::-webkit-scrollbar-thumb\s*\{([\s\S]*?)\n\s*\}/.exec(
        css,
      )?.[1];
    const forcedDarkScrollbarHoverDeclarations =
      /:root\[data-theme="dark"\] ::-webkit-scrollbar-thumb:hover,\s*:root\[data-theme="dark"\]::-webkit-scrollbar-thumb:hover\s*\{([\s\S]*?)\n\s*\}/.exec(
        css,
      )?.[1];
    const automaticDarkScrollbarHoverDeclarations =
      /:root:not\(\[data-theme="light"\]\) ::-webkit-scrollbar-thumb:hover,\s*:root:not\(\[data-theme="light"\]\)::-webkit-scrollbar-thumb:hover\s*\{([\s\S]*?)\n\s*\}/.exec(
        css,
      )?.[1];

    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toMatch(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{/s,
    );
    expect(css).toContain(':root[data-theme="dark"]::-webkit-scrollbar-thumb');
    expect(css).toContain(':root:not([data-theme="light"])::-webkit-scrollbar-thumb');
    expect(forcedDarkRootDeclarations).toBeDefined();
    expect(automaticDarkRootDeclarations).toBeDefined();
    expect(forcedDarkScrollbarDeclarations).toBeDefined();
    expect(automaticDarkScrollbarDeclarations).toBeDefined();
    expect(forcedDarkScrollbarHoverDeclarations).toBeDefined();
    expect(automaticDarkScrollbarHoverDeclarations).toBeDefined();
    expect(normalizeDeclarations(forcedDarkRootDeclarations)).toEqual(
      normalizeDeclarations(automaticDarkRootDeclarations),
    );
    expect(normalizeDeclarations(forcedDarkScrollbarDeclarations)).toEqual(
      normalizeDeclarations(automaticDarkScrollbarDeclarations),
    );
    expect(normalizeDeclarations(forcedDarkScrollbarHoverDeclarations)).toEqual(
      normalizeDeclarations(automaticDarkScrollbarHoverDeclarations),
    );
  });

  it("bootstraps a stored forced theme before the app module loads", () => {
    const indexHtml = readFileSync(join(process.cwd(), "index.html"), "utf8");
    const scriptMatches = [
      ...indexHtml.matchAll(/<script(?<attributes>[^>]*)>(?<body>[\s\S]*?)<\/script>/g),
    ];
    const bootstrapScript = scriptMatches.find((match) =>
      (match.groups?.body ?? "").includes(PREFERENCES_STORAGE_KEY),
    );
    const bootstrapAttributes = bootstrapScript?.groups?.attributes ?? "";
    const bootstrapBody = bootstrapScript?.groups?.body ?? "";
    const bootstrapIndex = bootstrapScript?.index ?? -1;
    const appModuleIndex = indexHtml.indexOf('<script type="module" src="/src/main.tsx"></script>');

    expect(bootstrapScript).toBeDefined();
    expect(bootstrapAttributes).not.toMatch(/\b(?:async|defer)\b/);
    expect(bootstrapAttributes).not.toMatch(/\btype\s*=\s*["']module["']/);
    expect(bootstrapIndex).toBeLessThan(appModuleIndex);
    expect(bootstrapBody).toContain("document.documentElement.dataset.theme = themeMode");
    expect(bootstrapBody).toContain("delete document.documentElement.dataset.theme");
  });

  it("keeps the run-section tab strip tall enough to render clipped labels", () => {
    const css = readFileSync(join(process.cwd(), "src", "run-dashboard.css"), "utf8");

    expect(css).toMatch(/\n\.tabs\s*\{[\s\S]*min-height:\s*41px;[\s\S]*\}/);
  });

  it("layers the resume dialog above fullscreen drawers", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    const resumeDialogLayer = /\.resume-dialog-backdrop\s*\{[\s\S]*?z-index:\s*(\d+);/.exec(css);
    const fullscreenDrawerLayer = /\.drawer--fullscreen\s*\{[\s\S]*?z-index:\s*(\d+);/.exec(css);

    expect(resumeDialogLayer).not.toBeNull();
    expect(fullscreenDrawerLayer).not.toBeNull();
    expect(resumeDialogLayer?.[1]).toBe("60");
    expect(fullscreenDrawerLayer?.[1]).toBe("40");
    expect(css).toMatch(
      /\.drawer--fullscreen\s*\{[\s\S]*?top:\s*0;[\s\S]*?right:\s*0;[\s\S]*?left:\s*0;/,
    );
    expect(css).toMatch(/\.drawer--fullscreen\s*\{[\s\S]*?width:\s*auto;/);
    expect(css).toMatch(/\.drawer--fullscreen\s*\{[\s\S]*?min-width:\s*0;/);
  });

  it("keeps the Chat composer textarea custom and non-resizable", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    const chatSurfaceRule = /\.chat-composer__surface\s*\{[\s\S]*?\n\}/.exec(css);
    const chatTextareaRule = /\.chat-composer textarea\s*\{[\s\S]*?\n\}/.exec(css);
    const chatSendRule = /\.chat-composer__send\s*\{[\s\S]*?\n\}/.exec(css);

    expect(chatSurfaceRule?.[0]).toContain("position: relative;");
    expect(chatSurfaceRule?.[0]).toContain("box-shadow: inset 0 0 0 1px var(--border);");
    expect(chatTextareaRule?.[0]).toContain("resize: none;");
    expect(chatTextareaRule?.[0]).toContain("border: 0;");
    expect(chatTextareaRule?.[0]).toContain("background: transparent;");
    expect(chatSendRule?.[0]).toContain("position: absolute;");
    expect(chatSendRule?.[0]).toContain("bottom: 10px;");
  });

  it("hides inactive selected-run surface bodies from layout", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    const hiddenDrawerBodyRule = /\.drawer-body\[hidden\]\s*\{[\s\S]*?\n\}/.exec(css);

    expect(hiddenDrawerBodyRule?.[0]).toContain("display: none;");
  });

  it("shows mobile selected-run surfaces as full-viewport overlays", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");

    expect(css).toMatch(
      /@media \(max-width: 899px\)[\s\S]*?\.dashboard-right-surfaces\s*\{\s*position: fixed;\s*inset: 0;\s*z-index: 50;\s*flex-direction: column;\s*background: var\(--background\);\s*\}/,
    );
    expect(css).toMatch(
      /@media \(max-width: 899px\)[\s\S]*?\.drawer-sheet-backdrop\s*\{\s*display: none;\s*\}/,
    );
  });

  it("clamps the transient drawer width to the current viewport", async () => {
    installFetchMock({
      runs: [makeRun()],
      details: { "run-1": makeDetail() },
    });

    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
      writable: true,
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    const drawer = await screen.findByLabelText("Run detail");
    const handle = screen.getByRole("separator", { name: /resize detail drawer/i });
    handle.focus();
    await user.keyboard("{End}");

    await waitFor(() => expect(drawer.getAttribute("style")).toContain("--drawer-width: 564px"));

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
      writable: true,
    });
  });

  it("falls back to defaults when stored dashboard preferences are malformed", async () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-preferences",
      JSON.stringify({
        collapseFailureStates: "yes",
        hideEmptyColumns: "no",
        showArchived: "sure",
        sortField: "changedAt",
        sortDirection: "newest",
        visibleFocusIndicators: "sure",
        themeMode: "system",
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

    expect(screen.queryByTitle("Archived dashboard")).not.toBeInTheDocument();
    expect(getBoardColumn("Failed")).toBeInTheDocument();
    expect(getBoardColumn("Blocked")).toBeInTheDocument();

    const hideEmptyColumnsButton = screen.getByRole("button", { name: /hide empty columns/i });
    expect(hideEmptyColumnsButton).toHaveAttribute("aria-pressed", "true");
    expect(hideEmptyColumnsButton.querySelector('path[d="m20 17-5-5 5-5"]')).not.toBeNull();
    expect(hideEmptyColumnsButton.querySelector('path[d="m4 17 5-5-5-5"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: /collapse failure states/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /show archived runs/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(await findRunCard("Build dashboard"));
    const drawer = await screen.findByLabelText("Run detail");
    expect(drawer.style.getPropertyValue("--drawer-width")).toBe("540px");
    expect(getBoardColumn("Running")).toHaveAttribute("data-collapsed", "false");

    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Board sort field" })).toHaveValue("startedAt");
    expect(screen.getByRole("combobox", { name: "Board sort direction" })).toHaveValue("desc");
    expect(screen.getByRole("combobox", { name: "Theme mode" })).toHaveValue("auto");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
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
    expect(window.localStorage.getItem("agent-runner:web:dashboard-view-state")).toBe(
      JSON.stringify({
        viewMode: "board",
        collapsedColumnKeys: ["running"],
        drawerWidth: 540,
        activeRightSurface: "detail",
        drawerFullscreen: false,
        diffsSidebarWidth: 272,
        filesSidebarWidth: 240,
        diffsViewMode: "unified",
      }),
    );
    expect(
      within(runningColumn).getByRole("button", { name: "Expand Running column" }),
    ).toBeInTheDocument();
    expect(runningColumn.querySelector(".col-collapsed-count")).toHaveTextContent("1");

    await user.click(runningColumn);

    await waitFor(() => {
      expect(runningColumn).toHaveAttribute("data-collapsed", "false");
    });
    expect(window.localStorage.getItem("agent-runner:web:dashboard-view-state")).toBe(
      JSON.stringify({
        viewMode: "board",
        collapsedColumnKeys: [],
        drawerWidth: 540,
        activeRightSurface: "detail",
        drawerFullscreen: false,
        diffsSidebarWidth: 272,
        filesSidebarWidth: 240,
        diffsViewMode: "unified",
      }),
    );
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

  it("hydrates saved collapsed columns and leaves unsaved columns expanded", async () => {
    setStoredDashboardPreferences({
      hideEmptyColumns: false,
    });
    setStoredDashboardViewState({
      collapsedColumnKeys: ["running"],
    });
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

    await renderApp();
    await findRunCard("Done dashboard");

    expect(getBoardColumn("Running")).toHaveAttribute("data-collapsed", "true");
    expect(getBoardColumn("Completed")).toHaveAttribute("data-collapsed", "false");
  });

  it("renders split-status columns with Completed last", async () => {
    setStoredDashboardPreferences({
      collapseFailureStates: false,
      hideEmptyColumns: false,
    });
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-pending",
          activeTask: null,
          assignmentName: "Pending dashboard",
          name: "Pending dashboard",
          status: "initialized",
        }),
        makeRun({
          runId: "run-running",
          assignmentName: "Running dashboard",
          name: "Running dashboard",
          status: "running",
        }),
        makeRun({
          runId: "run-blocked",
          activeTask: null,
          assignmentName: "Blocked dashboard",
          name: "Blocked dashboard",
          status: "blocked",
        }),
        makeRun({
          runId: "run-error",
          activeTask: null,
          assignmentName: "Broken dashboard",
          name: "Broken dashboard",
          status: "error",
        }),
        makeRun({
          runId: "run-exhausted",
          activeTask: null,
          assignmentName: "Exhausted dashboard",
          name: "Exhausted dashboard",
          status: "exhausted",
        }),
        makeRun({
          runId: "run-aborted",
          activeTask: null,
          assignmentName: "Aborted dashboard",
          name: "Aborted dashboard",
          status: "aborted",
        }),
        makeRun({
          runId: "run-completed",
          activeTask: null,
          effectiveStatus: "success",
          assignmentName: "Completed dashboard",
          name: "Completed dashboard",
          status: "success",
        }),
      ],
      details: {
        "run-pending": makeDetail({
          runId: "run-pending",
          activeTask: null,
          status: "initialized",
        }),
        "run-running": makeDetail({
          runId: "run-running",
          status: "running",
        }),
        "run-blocked": makeDetail({
          runId: "run-blocked",
          activeTask: null,
          status: "blocked",
        }),
        "run-error": makeDetail({
          runId: "run-error",
          activeTask: null,
          status: "error",
        }),
        "run-exhausted": makeDetail({
          runId: "run-exhausted",
          activeTask: null,
          status: "exhausted",
        }),
        "run-aborted": makeDetail({
          runId: "run-aborted",
          activeTask: null,
          status: "aborted",
        }),
        "run-completed": makeDetail({
          runId: "run-completed",
          activeTask: null,
          effectiveStatus: "success",
          status: "success",
        }),
      },
    });

    await renderApp();
    await findRunCard("Running dashboard");

    expect(getBoardColumnTitles()).toEqual([
      "Initialized",
      "Ready",
      "Running",
      "Blocked",
      "Error",
      "Exhausted",
      "Aborted",
      "Completed",
    ]);
  });

  it("renders collapsed failure columns with Completed last", async () => {
    setStoredDashboardPreferences({
      collapseFailureStates: true,
      hideEmptyColumns: false,
    });
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-pending",
          activeTask: null,
          assignmentName: "Pending dashboard",
          name: "Pending dashboard",
          status: "initialized",
        }),
        makeRun({
          runId: "run-running",
          assignmentName: "Running dashboard",
          name: "Running dashboard",
          status: "running",
        }),
        makeRun({
          runId: "run-blocked",
          activeTask: null,
          assignmentName: "Blocked dashboard",
          name: "Blocked dashboard",
          status: "blocked",
        }),
        makeRun({
          runId: "run-error",
          activeTask: null,
          assignmentName: "Broken dashboard",
          name: "Broken dashboard",
          status: "error",
        }),
        makeRun({
          runId: "run-aborted",
          activeTask: null,
          assignmentName: "Aborted dashboard",
          name: "Aborted dashboard",
          status: "aborted",
        }),
        makeRun({
          runId: "run-completed",
          activeTask: null,
          effectiveStatus: "success",
          assignmentName: "Completed dashboard",
          name: "Completed dashboard",
          status: "success",
        }),
      ],
      details: {
        "run-pending": makeDetail({
          runId: "run-pending",
          activeTask: null,
          status: "initialized",
        }),
        "run-running": makeDetail({
          runId: "run-running",
          status: "running",
        }),
        "run-blocked": makeDetail({
          runId: "run-blocked",
          activeTask: null,
          status: "blocked",
        }),
        "run-error": makeDetail({
          runId: "run-error",
          activeTask: null,
          status: "error",
        }),
        "run-aborted": makeDetail({
          runId: "run-aborted",
          activeTask: null,
          status: "aborted",
        }),
        "run-completed": makeDetail({
          runId: "run-completed",
          activeTask: null,
          effectiveStatus: "success",
          status: "success",
        }),
      },
    });

    await renderApp();
    await findRunCard("Running dashboard");

    expect(getBoardColumnTitles()).toEqual([
      "Initialized",
      "Ready",
      "Running",
      "Blocked",
      "Failed",
      "Aborted",
      "Completed",
    ]);
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

    expect(screen.queryByRole("button", { name: "Initialized (0)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ready (0)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aborted (0)" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Blocked (1)" }));

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });
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

  it("keeps jump buttons visible when all non-empty columns already fit", async () => {
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
      expect(screen.getByRole("button", { name: "Running (1)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Completed (1)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Blocked (1)" })).toBeInTheDocument();
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
              canEditPending: false,
              canDeletePending: false,
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
          },
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: true,
            taskMutation: {
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
              canEditNotes: false,
              canSetStatus: false,
            },
          },
        }),
        passive: makeDetail({
          runId: "passive",
          status: "success",
          backend: "passive",
          assignment: { name: "Passive run", sourcePath: "/tmp/a.md" },
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: false,
            taskMutation: {
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
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
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();

    await user.click(getCloseDetailButton());
    await user.click(await findRunCard("Passive run"));
    expect(await screen.findByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
  });

  it("confirms Reset inline before sending the reset request", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ runId: "resumable", assignmentName: "Resumable run", status: "success" })],
      details: {
        resumable: makeDetail({
          runId: "resumable",
          status: "success",
          assignment: {
            name: "Resumable run",
            sourcePath: "/tmp/a.md",
          },
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canReset: true,
            canDelete: false,
            canResume: true,
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Resumable run"));

    await user.click(await screen.findByRole("button", { name: "Reset" }));

    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm reset run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel reset run" })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith("/api/runs/resumable/reset") && init?.method === "POST",
      ),
    ).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Cancel reset run" }));

    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm reset run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel reset run" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: "Confirm reset run" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith("/api/runs/resumable/reset") && init?.method === "POST",
        ),
      ).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ready" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm reset run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel reset run" })).not.toBeInTheDocument();
  });

  it("deletes archived runs from the web detail drawer", async () => {
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          runId: "run-archived",
          assignmentName: "Archived run",
          archivedAt: "2026-04-13T06:00:00.000Z",
          status: "success",
          capabilities: {
            canArchive: false,
            canUnarchive: true,
            canReset: true,
            canDelete: true,
            canResume: false,
          },
        }),
      ],
      details: {
        "run-archived": makeDetail({
          runId: "run-archived",
          status: "success",
          archivedAt: "2026-04-13T06:00:00.000Z",
          assignment: {
            name: "Archived run",
            sourcePath: "/tmp/a.md",
          },
          capabilities: {
            canArchive: false,
            canUnarchive: true,
            canReset: true,
            canDelete: true,
            canResume: false,
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await screen.findByRole("button", { name: /show archived runs/i }));
    await user.click(await findRunCard("Archived run"));

    expect(await screen.findByRole("button", { name: "Delete" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm delete run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel delete run" })).toBeInTheDocument();
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith("/api/runs/run-archived") && init?.method === "DELETE",
      ),
    ).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Cancel delete run" }));
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm delete run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel delete run" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete run" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Run detail")).not.toBeInTheDocument();
    });
    expect(screen.queryByTitle("Archived run")).not.toBeInTheDocument();
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
          },
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: true,
            taskMutation: {
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
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

  it("closes a resume dialog on outside click without sending a request", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ runId: "resumable", assignmentName: "Resumable run", status: "success" })],
      details: {
        resumable: makeDetail({
          runId: "resumable",
          status: "success",
          assignment: {
            name: "Resumable run",
            sourcePath: "/tmp/a.md",
          },
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: true,
            taskMutation: {
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
              canEditNotes: false,
              canSetStatus: false,
            },
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Resumable run"));
    await user.click(await screen.findByRole("button", { name: "Resume" }));

    const resumeDialog = await screen.findByRole("dialog", { name: "Resume run" });
    const resumeDialogSurface = resumeDialog.querySelector(".resume-dialog");
    if (!resumeDialogSurface) {
      throw new Error("expected resume dialog surface");
    }
    const callsBeforeClose = fetchMock.mock.calls.length;

    fireEvent.click(resumeDialogSurface);

    expect(screen.getByRole("dialog", { name: "Resume run" })).toBeInTheDocument();

    fireEvent.click(resumeDialog);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
    expect(
      fetchMock.mock.calls
        .slice(callsBeforeClose)
        .some(([input]) => String(input).endsWith("/api/runs/resumable/resume")),
    ).toBe(false);
  });

  it("keeps a resume dialog open while native close paths fire during pending resume", async () => {
    let resolveResume: ((response: Response) => void) | undefined;
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
            },
            capabilities: {
              canArchive: true,
              canUnarchive: false,
              canResume: true,
              taskMutation: {
                canAdd: false,
                canEditPending: false,
                canDeletePending: false,
                canEditNotes: false,
                canSetStatus: false,
              },
            },
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (url.endsWith("/api/runs/resumable/resume")) {
            return new Promise<Response>((resolve) => {
              resolveResume = resolve;
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Resumable run"));
    await user.click(await screen.findByRole("button", { name: "Resume" }));

    const resumeDialog = await screen.findByRole("dialog", { name: "Resume run" });
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(within(resumeDialog).getByRole("button", { name: "Resuming..." })).toBeDisabled();
    });
    expect(within(resumeDialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    nativeCancel(resumeDialog);
    expect(screen.getByRole("dialog", { name: "Resume run" })).toBeInTheDocument();

    fireEvent.click(resumeDialog);
    expect(screen.getByRole("dialog", { name: "Resume run" })).toBeInTheDocument();

    if (!resolveResume) {
      throw new Error("expected pending resume request");
    }
    resolveResume(new Response(JSON.stringify({ runId: "resumable" }), { status: 200 }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
  });

  it("keeps the drawer open when native cancel closes the resume dialog", async () => {
    installFetchMock({
      runs: [makeRun({ runId: "resumable", assignmentName: "Resumable run", status: "success" })],
      details: {
        resumable: makeDetail({
          runId: "resumable",
          status: "success",
          assignment: {
            name: "Resumable run",
            sourcePath: "/tmp/a.md",
          },
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: true,
            taskMutation: {
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
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

    const resumeDialog = await screen.findByRole("dialog", { name: "Resume run" });

    nativeCancel(resumeDialog);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("shows Ready for initialized runs and promotes from fullscreen Enter without opening the dialog", async () => {
    let readyRequested = false;
    const fetchMock = installFetchMock(
      {
        runs: [
          makeRun({
            runId: "initialized",
            assignmentName: "Initialized run",
            status: "initialized",
            activeTask: null,
          }),
        ],
        details: {
          initialized: makeDetail({
            runId: "initialized",
            status: "initialized",
            isLive: false,
            backendSessionId: null,
            assignment: {
              name: "Initialized run",
              sourcePath: "/tmp/a.md",
            },
            tasks: [
              {
                id: "setup",
                title: "Setup",
                body: "Prepare the run",
                status: "pending",
                notes: "",
              },
            ],
            capabilities: {
              canArchive: true,
              canUnarchive: false,
              canReady: true,
              canResume: false,
              taskMutation: {
                canAdd: false,
                canEditPending: false,
                canDeletePending: false,
                canEditNotes: false,
                canSetStatus: false,
              },
            },
          }),
        },
      },
      {
        handleRequest: async (url, init) => {
          if (url.endsWith("/api/runs/initialized/ready") && init?.method === "POST") {
            readyRequested = true;
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    const initializedRunCard = await findRunCard("Initialized run");
    await user.click(initializedRunCard);

    const readyButton = await screen.findByRole("button", { name: "Ready" });
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(readyButton).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Expand drawer to full width" }));
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(readyRequested).toBe(true);
    });
  });

  it("starts selected ready runs with fullscreen Enter without opening the resume dialog", async () => {
    let resumeBody: { overrides?: { message?: string } } | undefined;
    installFetchMock(
      {
        runs: [
          makeRun({
            runId: "ready-enter",
            assignmentName: "Ready from keyboard",
            name: "Ready from keyboard",
            status: "ready",
            effectiveStatus: "ready",
            activeTask: null,
          }),
        ],
        details: {
          "ready-enter": makeDetail({
            runId: "ready-enter",
            status: "ready",
            effectiveStatus: "ready",
            isLive: false,
            backendSessionId: null,
            totalAttemptCount: 0,
            name: "Ready from keyboard",
            assignment: {
              name: "Ready from keyboard",
              sourcePath: "/tmp/keyboard-a.md",
            },
            tasks: [
              {
                id: "setup",
                title: "Setup",
                body: "Prepare the run",
                status: "pending",
                notes: "",
              },
            ],
            capabilities: {
              canArchive: true,
              canUnarchive: false,
              canReady: false,
              canResume: true,
              taskMutation: {
                canAdd: false,
                canEditPending: false,
                canDeletePending: false,
                canEditNotes: false,
                canSetStatus: false,
              },
            },
          }),
        },
      },
      {
        handleRequest: async (url, init) => {
          if (url.endsWith("/api/runs/ready-enter/resume")) {
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
    await user.click(await findRunCard("Ready from keyboard"));
    await user.click(screen.getByRole("button", { name: "Expand drawer to full width" }));

    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(resumeBody).toEqual({ overrides: {} });
    });
  });

  it("opens the resume dialog with Enter for selected resumable runs", async () => {
    let resumeRequestCount = 0;
    installFetchMock(
      {
        runs: [
          makeRun({
            runId: "resumable-enter",
            assignmentName: "Resumable from keyboard",
            name: "Resumable from keyboard",
            status: "success",
            effectiveStatus: "success",
          }),
        ],
        details: {
          "resumable-enter": makeDetail({
            runId: "resumable-enter",
            status: "success",
            effectiveStatus: "success",
            name: "Resumable from keyboard",
            assignment: {
              name: "Resumable from keyboard",
              sourcePath: "/tmp/resume-a.md",
            },
            capabilities: {
              canArchive: true,
              canUnarchive: false,
              canReady: false,
              canResume: true,
              taskMutation: {
                canAdd: false,
                canEditPending: false,
                canDeletePending: false,
                canEditNotes: false,
                canSetStatus: false,
              },
            },
          }),
        },
      },
      {
        handleRequest: async (url) => {
          if (url.endsWith("/api/runs/resumable-enter/resume")) {
            resumeRequestCount += 1;
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Resumable from keyboard"));

    await user.keyboard("{Enter}");

    expect(await screen.findByRole("dialog", { name: "Resume run" })).toBeInTheDocument();
    expect(resumeRequestCount).toBe(0);
  });

  it("does not swallow Enter on unrelated focused buttons when the selected run cannot resume", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "passive-enter",
          assignmentName: "Passive keyboard run",
          backend: "passive",
          name: "Passive keyboard run",
        }),
      ],
      details: {
        "passive-enter": makeDetail({
          runId: "passive-enter",
          backend: "passive",
          name: "Passive keyboard run",
          assignment: {
            name: "Passive keyboard run",
            sourcePath: "/tmp/passive-enter-a.md",
          },
          capabilities: { canResume: false },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Passive keyboard run"));

    const settingsButton = getSidebarNavigation().getByRole("button", { name: "Settings" });
    settingsButton.focus();
    expect(settingsButton).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("shows an optional-message disclosure for incomplete-task resumes and can send without a message", async () => {
    let resumeBody: { overrides?: { message?: string } } | undefined;
    const fetchMock = installFetchMock(
      {
        runs: [makeRun({ runId: "resumable", assignmentName: "Resumable run", status: "success" })],
        details: {
          resumable: makeDetail({
            runId: "resumable",
            status: "success",
            assignment: {
              name: "Resumable run",
              sourcePath: "/tmp/a.md",
            },
            capabilities: {
              canArchive: true,
              canUnarchive: false,
              canResume: true,
              taskMutation: {
                canAdd: false,
                canEditPending: false,
                canDeletePending: false,
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
    const resumableRunCard = await findRunCard("Resumable run");
    await user.click(resumableRunCard);
    await user.click(await screen.findByRole("button", { name: "Resume" }));

    const sendButton = await screen.findByRole("button", { name: "Send" });
    const disclosureButton = screen.getByRole("button", { name: "Optional message" });
    expect(disclosureButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox", { name: "Optional message" })).not.toBeInTheDocument();
    expect(sendButton).toBeEnabled();

    await user.click(sendButton);

    await waitFor(() => {
      expect(resumeBody).toEqual({ overrides: {} });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    });
  });

  it("requires a resume message before enabling send when no incomplete tasks remain", async () => {
    installFetchMock({
      runs: [makeRun({ runId: "resumable", assignmentName: "Resumable run", status: "success" })],
      details: {
        resumable: makeDetail({
          runId: "resumable",
          status: "success",
          assignment: {
            name: "Resumable run",
            sourcePath: "/tmp/a.md",
          },
          tasks: [
            {
              id: "orient",
              title: "Orient",
              body: "Read the repo",
              status: "completed",
              notes: "done",
            },
            {
              id: "ship",
              title: "Ship it",
              body: "Land the change",
              status: "completed",
              notes: "done",
            },
          ],
          tasksCompleted: 2,
          tasksTotal: 2,
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: true,
            taskMutation: {
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
              canEditNotes: false,
              canSetStatus: false,
            },
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    const resumableRunCard = await findRunCard("Resumable run");
    await user.click(resumableRunCard);
    await user.click(await screen.findByRole("button", { name: "Resume" }));

    const sendButton = await screen.findByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();
    expect(
      screen.getByText("Send a follow-up message describing what the run should do next."),
    ).toBeInTheDocument();

    await user.type(
      await within(screen.getByRole("dialog", { name: "Resume run" })).findByLabelText("Message"),
      "Pick up the failing tests.",
    );

    await waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
  });

  it("sends an optional resume message when the disclosure is expanded", async () => {
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
            },
            capabilities: {
              canArchive: true,
              canUnarchive: false,
              canResume: true,
              taskMutation: {
                canAdd: false,
                canEditPending: false,
                canDeletePending: false,
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
    const resumableRunCard = await findRunCard("Resumable run");
    await user.click(resumableRunCard);
    await user.click(await screen.findByRole("button", { name: "Resume" }));
    await user.click(screen.getByRole("button", { name: "Optional message" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Optional message" }),
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

  it("treats blocked tasks as incomplete for the resume dialog flow", async () => {
    installFetchMock({
      runs: [makeRun({ runId: "blocked-run", assignmentName: "Blocked run", status: "blocked" })],
      details: {
        "blocked-run": makeDetail({
          runId: "blocked-run",
          status: "blocked",
          assignment: {
            name: "Blocked run",
            sourcePath: "/tmp/a.md",
          },
          tasks: [
            {
              id: "triage",
              title: "Triage",
              body: "Investigate the blocker",
              status: "blocked",
              notes: "Waiting on dependency",
            },
          ],
          tasksCompleted: 0,
          tasksTotal: 1,
          capabilities: {
            canArchive: true,
            canUnarchive: false,
            canResume: true,
            taskMutation: {
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
              canEditNotes: false,
              canSetStatus: false,
            },
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    const blockedRunCard = await findRunCard("Blocked run");
    await user.click(blockedRunCard);
    await user.click(await screen.findByRole("button", { name: "Resume" }));

    const sendButton = await screen.findByRole("button", { name: "Send" });
    const disclosureButton = screen.getByRole("button", { name: "Optional message" });
    expect(disclosureButton).toHaveAttribute("aria-expanded", "false");
    expect(sendButton).toBeEnabled();
  });

  it("updates the selected run action label and flow from detail SSE state changes", async () => {
    let resumeBody: { overrides?: { message?: string } } | undefined;
    installFetchMock(
      {
        runs: [
          makeRun({
            runId: "run-1",
            status: "success",
          }),
        ],
        details: {
          "run-1": makeDetail({
            status: "success",
            tasks: [
              {
                id: "ship",
                title: "Ship it",
                body: "Land the change",
                status: "completed",
                notes: "done",
              },
            ],
            tasksCompleted: 1,
            tasksTotal: 1,
            capabilities: {
              canResume: true,
              canAbort: false,
            },
          }),
        },
      },
      {
        handleRequest: async (url, init) => {
          if (url.endsWith("/api/runs/run-1/resume")) {
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
    await user.click(await findRunCard("Build dashboard"));

    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();

    findEventSource("/api/runs/run-1/events/detail").emitMessage({
      type: "detail_updated",
      detail: makeDetail({
        runId: "run-1",
        status: "ready",
        isLive: false,
        backendSessionId: null,
        endedAt: null,
        activeTask: null,
        totalAttemptCount: 0,
        tasks: [
          {
            id: "setup",
            title: "Setup",
            body: "Prepare the run",
            status: "pending",
            notes: "",
          },
        ],
        tasksCompleted: 0,
        tasksTotal: 1,
        capabilities: {
          canReady: false,
          canResume: true,
          canAbort: false,
        },
      }),
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(resumeBody).toEqual({ overrides: {} });
    });
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
            },
            capabilities: {
              canArchive: true,
              canUnarchive: false,
              canResume: true,
              taskMutation: {
                canAdd: false,
                canEditPending: false,
                canDeletePending: false,
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
      expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
    });
  });

  it("prevents horizontal wheel gestures from escaping the board and drawers", async () => {
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Gesture run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Gesture run",
            attachments: [
              makeAttachment({
                id: "att-md",
                name: "notes.md",
                mimeType: "text/markdown; charset=utf-8",
              }),
            ],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-md\/content$/.test(url)) {
            return new Response(attachmentMermaidMarkdown, {
              status: 200,
              headers: { "content-type": "text/markdown; charset=utf-8" },
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Gesture run");

    const board = setBoardGeometry({
      clientWidth: 320,
      columns: [{ key: "running", left: 0, width: 280 }],
      scrollWidth: 960,
    });
    await waitFor(() => {
      dispatchHorizontalWheel(board);
      expect(board.scrollLeft).toBe(80);
    });

    await user.click(await findRunCard("Gesture run"));
    await waitFor(() => {
      const detailWheel = dispatchHorizontalWheel(screen.getByLabelText("Run detail"));
      expect(detailWheel.defaultPrevented).toBe(true);
    });

    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));
    await user.click(screen.getByRole("button", { name: /^Preview notes\.md$/ }));
    await waitFor(() => {
      const previewWheel = dispatchHorizontalWheel(screen.getByLabelText("Attachment preview"));
      expect(previewWheel.defaultPrevented).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: /Expand drawer to full width/i }));
    await waitFor(() => {
      const fullscreenPreviewWheel = dispatchHorizontalWheel(
        screen.getByLabelText("Attachment preview"),
      );
      expect(fullscreenPreviewWheel.defaultPrevented).toBe(true);
    });
  });

  it("restores the previously snapped board column after closing detail", async () => {
    installFetchMock({
      runs: [
        makeRun({ runId: "run-1", name: "First run", status: "running" }),
        makeRun({ runId: "run-2", name: "Second run", status: "success" }),
      ],
      details: {
        "run-1": makeDetail({ runId: "run-1", name: "First run", status: "running" }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("First run");
    await findRunCard("Second run");

    const board = setBoardGeometry({
      clientWidth: 320,
      columns: [
        { key: "running", left: 0, width: 280 },
        { key: "completed", left: 320, width: 280 },
      ],
      scrollLeft: 300,
      scrollWidth: 960,
    });
    board.dispatchEvent(new Event("scroll"));

    await user.click(await findRunCard("First run"));
    await screen.findByLabelText("Run detail");
    await user.click(getCloseDetailButton());

    const restoredBoard = setBoardGeometry({
      clientWidth: 320,
      columns: [
        { key: "running", left: 0, width: 280 },
        { key: "completed", left: 320, width: 280 },
      ],
      scrollLeft: 0,
      scrollWidth: 960,
    });

    await waitFor(() => {
      expect(restoredBoard.scrollLeft).toBe(300);
    });
  });

  it("confirms Abort inline before sending the abort request", async () => {
    const state = {
      runs: [makeRun({ capabilities: { canAbort: true, abortReason: undefined } })],
      details: {
        "run-1": makeDetail({ capabilities: { canAbort: true, abortReason: undefined } }),
      },
    };
    const fetchMock = installFetchMock(state, {
      handleRequest: (url, init) => {
        if (url.endsWith("/api/runs/run-1/abort") && init?.method === "POST") {
          const detail = state.details["run-1"];
          const run = state.runs[0];
          if (!detail || !run) {
            throw new Error("expected abortable run state");
          }
          state.details["run-1"] = makeDetail({
            ...detail,
            status: "aborted",
            effectiveStatus: "aborted",
            isLive: false,
            activeTask: null,
            endedAt: "2026-04-13T05:05:00.000Z",
            capabilities: {
              ...detail.capabilities,
              canAbort: false,
              abortReason: "already_terminal",
            },
          });
          state.runs = [
            makeRun({
              ...run,
              status: "aborted",
              effectiveStatus: "aborted",
              endedAt: "2026-04-13T05:05:00.000Z",
              activeTask: null,
              capabilities: {
                ...run.capabilities,
                canAbort: false,
                abortReason: "already_terminal",
              },
            }),
          ];
        }
        return undefined;
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    expect(await screen.findByRole("button", { name: "Abort" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Abort" }));

    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm abort run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel abort run" })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/api/runs/run-1/abort") && init?.method === "POST",
      ),
    ).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Cancel abort run" }));

    expect(screen.getByRole("button", { name: "Abort" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm abort run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel abort run" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Abort" }));
    await user.click(screen.getByRole("button", { name: "Confirm abort run" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => String(url).endsWith("/api/runs/run-1/abort") && init?.method === "POST",
        ),
      ).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Confirm abort run" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel abort run" })).not.toBeInTheDocument();
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
      assignment: { name: "Updated from SSE", sourcePath: "/tmp/a.md" },
    });
    source.emitMessage({ type: "summary_upsert", summary: state.runs[0] });

    expect(await screen.findByRole("button", { name: /updated from sse/i })).toBeInTheDocument();

    source.emitMessage({ type: "summary_removed", runId: "run-1" });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /updated from sse/i })).not.toBeInTheDocument();
    });

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
          },
        }),
      },
    };
    installFetchMock(state, {
      handleRequest: (url) => {
        if (url.includes("/api/runs?includeArchived=false") && failNextRunsFetch) {
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

  it("filters archived summary SSE upserts by list cache visibility", async () => {
    const activeRun = makeRun({ assignmentName: "Active from fetch", name: "Active from fetch" });
    installFetchMock({
      runs: [activeRun],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Active from fetch",
            sourcePath: "/tmp/active.md",
          },
          name: "Active from fetch",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    expect(await findRunCard("Active from fetch")).toBeInTheDocument();

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitOpen();

    const hiddenKey = runQueryKeys.list({ includeArchived: false, runGroupId: null });
    const archivedKey = runQueryKeys.list({ includeArchived: true, runGroupId: null });
    const archivedSummary = makeRun({
      runId: "run-archived-sse",
      assignmentName: "Archived from SSE",
      archivedAt: "2026-04-13T06:00:00.000Z",
      name: "Archived from SSE",
      status: "success",
    });
    queryClient.setQueryData<RunSummary[]>(hiddenKey, [activeRun, archivedSummary]);

    source.emitMessage({ type: "summary_upsert", summary: archivedSummary });

    await waitFor(() =>
      expect(
        queryClient
          .getQueryData<RunSummary[]>(hiddenKey)
          ?.some((run) => run.runId === "run-archived-sse"),
      ).toBe(false),
    );
    expect(screen.queryByRole("button", { name: /Archived from SSE/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show archived runs/i }));
    source.emitMessage({ type: "summary_upsert", summary: archivedSummary });

    expect(await findRunCard("Archived from SSE")).toBeInTheDocument();
    expect(
      queryClient
        .getQueryData<RunSummary[]>(archivedKey)
        ?.some((run) => run.runId === "run-archived-sse"),
    ).toBe(true);
  });

  it("filters summary SSE upserts by scoped run-group list metadata", async () => {
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-group-root",
          assignmentName: "Group root",
          name: "Group root",
          runGroupId: "group-a",
        }),
        makeRun({
          runId: "run-outside",
          assignmentName: "Outside run",
          name: "Outside run",
          runGroupId: "group-b",
        }),
      ],
      details: {},
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(
      within(await findRunCard("Group root")).getByLabelText("Filter by run group group-a"),
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Outside run/i })).not.toBeInTheDocument();
    });

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitOpen();

    const scopedKey = runQueryKeys.list({ includeArchived: false, runGroupId: "group-a" });
    source.emitMessage({
      type: "summary_upsert",
      summary: makeRun({
        runId: "run-other-sse",
        assignmentName: "Other group SSE",
        name: "Other group SSE",
        runGroupId: "group-b",
      }),
    });

    expect(screen.queryByRole("button", { name: /Other group SSE/i })).not.toBeInTheDocument();
    expect(
      queryClient
        .getQueryData<RunSummary[]>(scopedKey)
        ?.some((run) => run.runId === "run-other-sse"),
    ).toBe(false);

    source.emitMessage({
      type: "summary_upsert",
      summary: makeRun({
        runId: "run-matching-sse",
        assignmentName: "Matching group SSE",
        name: "Matching group SSE",
        runGroupId: "group-a",
      }),
    });

    expect(await findRunCard("Matching group SSE")).toBeInTheDocument();
    expect(
      queryClient
        .getQueryData<RunSummary[]>(scopedKey)
        ?.some((run) => run.runId === "run-matching-sse"),
    ).toBe(true);
  });

  it("promotes an updated run to the top of its column in last-updated sort mode", async () => {
    setStoredDashboardPreferences({ sortField: "updatedAt", sortDirection: "desc" });
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          runId: "run-newer",
          assignmentName: "Newest run",
          name: "Newest run",
          startedAt: "2026-04-13T05:05:00.000Z",
          updatedAt: "2026-04-13T05:05:00.000Z",
        }),
        makeRun({
          runId: "run-older",
          assignmentName: "Older run",
          name: "Older run",
          startedAt: "2026-04-13T05:00:00.000Z",
          updatedAt: "2026-04-13T05:00:00.000Z",
        }),
      ],
      details: {
        "run-newer": makeDetail({
          runId: "run-newer",
          assignment: {
            name: "Newest run",
            sourcePath: "/tmp/newer.md",
          },
          name: "Newest run",
          startedAt: "2026-04-13T05:05:00.000Z",
          updatedAt: "2026-04-13T05:05:00.000Z",
        }),
        "run-older": makeDetail({
          runId: "run-older",
          assignment: {
            name: "Older run",
            sourcePath: "/tmp/older.md",
          },
          name: "Older run",
          startedAt: "2026-04-13T05:00:00.000Z",
          updatedAt: "2026-04-13T05:00:00.000Z",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Newest run");
    expect(getColumnRunNames("Running")).toEqual(["Newest run", "Older run"]);

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitOpen();

    const callsBefore = fetchMock.mock.calls.length;
    source.emitMessage({
      type: "summary_upsert",
      summary: makeRun({
        runId: "run-older",
        assignmentName: "Older run",
        name: "Older run",
        startedAt: "2026-04-13T05:00:00.000Z",
        updatedAt: "2026-04-13T05:10:00.000Z",
      }),
    });

    await waitFor(() => {
      expect(getColumnRunNames("Running")).toEqual(["Older run", "Newest run"]);
    });
    expect(await findRunCard("Older run")).toHaveAttribute("data-motion-kind", "reorder");
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore);
  });

  it("promotes a selected run into the top of its destination column from detail SSE", async () => {
    setStoredDashboardPreferences({ sortField: "updatedAt", sortDirection: "desc" });
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-selected",
          assignmentName: "Selected run",
          name: "Selected run",
          startedAt: "2026-04-13T05:00:00.000Z",
          updatedAt: "2026-04-13T05:00:00.000Z",
        }),
        makeRun({
          runId: "run-complete",
          assignmentName: "Completed run",
          name: "Completed run",
          startedAt: "2026-04-13T05:04:00.000Z",
          updatedAt: "2026-04-13T05:04:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "run-selected": makeDetail({
          runId: "run-selected",
          assignment: {
            name: "Selected run",
            sourcePath: "/tmp/selected.md",
          },
          name: "Selected run",
          startedAt: "2026-04-13T05:00:00.000Z",
          updatedAt: "2026-04-13T05:00:00.000Z",
        }),
        "run-complete": makeDetail({
          runId: "run-complete",
          assignment: {
            name: "Completed run",
            sourcePath: "/tmp/completed.md",
          },
          name: "Completed run",
          startedAt: "2026-04-13T05:04:00.000Z",
          updatedAt: "2026-04-13T05:04:00.000Z",
          status: "success",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Selected run");
    await user.click(await findRunCard("Selected run"));

    const detailSource = findEventSource("/api/runs/run-selected/events/detail");
    detailSource.emitOpen();
    detailSource.emitMessage({
      type: "detail_updated",
      detail: makeDetail({
        runId: "run-selected",
        assignment: {
          name: "Selected run",
          sourcePath: "/tmp/selected.md",
        },
        name: "Selected run",
        startedAt: "2026-04-13T05:00:00.000Z",
        updatedAt: "2026-04-13T05:10:00.000Z",
        status: "success",
      }),
    });

    await waitFor(() => {
      expect(getColumnRunNames("Completed")).toEqual(["Selected run", "Completed run"]);
    });
  });

  it("marks brand-new runs as inserts and places them at the top in last-updated sort mode", async () => {
    setStoredDashboardPreferences({ sortField: "updatedAt", sortDirection: "desc" });
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-existing",
          assignmentName: "Existing run",
          name: "Existing run",
          startedAt: "2026-04-13T05:05:00.000Z",
          updatedAt: "2026-04-13T05:05:00.000Z",
        }),
      ],
      details: {
        "run-existing": makeDetail({
          runId: "run-existing",
          assignment: {
            name: "Existing run",
            sourcePath: "/tmp/existing.md",
          },
          name: "Existing run",
          startedAt: "2026-04-13T05:05:00.000Z",
          updatedAt: "2026-04-13T05:05:00.000Z",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Existing run");

    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("expected an EventSource subscription");
    }
    source.emitOpen();
    source.emitMessage({
      type: "summary_upsert",
      summary: makeRun({
        runId: "run-inserted",
        assignmentName: "Inserted run",
        name: "Inserted run",
        startedAt: "2026-04-13T04:50:00.000Z",
        updatedAt: "2026-04-13T05:10:00.000Z",
      }),
    });

    await waitFor(() => {
      expect(getColumnRunNames("Running")).toEqual(["Inserted run", "Existing run"]);
    });
    expect(await findRunCard("Inserted run")).toHaveAttribute("data-motion-kind", "insert");
  });

  it("suppresses transform animation for reduced-motion users while keeping reorder markers", async () => {
    const animateMock = vi.fn();
    const originalAnimateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: animateMock,
      writable: true,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );

    try {
      setStoredDashboardPreferences({ sortField: "updatedAt", sortDirection: "desc" });
      installFetchMock({
        runs: [
          makeRun({
            runId: "run-newer",
            assignmentName: "Newest run",
            name: "Newest run",
            startedAt: "2026-04-13T05:05:00.000Z",
            updatedAt: "2026-04-13T05:05:00.000Z",
          }),
          makeRun({
            runId: "run-older",
            assignmentName: "Older run",
            name: "Older run",
            startedAt: "2026-04-13T05:00:00.000Z",
            updatedAt: "2026-04-13T05:00:00.000Z",
          }),
        ],
        details: {
          "run-newer": makeDetail({
            runId: "run-newer",
            assignment: {
              name: "Newest run",
              sourcePath: "/tmp/newer.md",
            },
            name: "Newest run",
            startedAt: "2026-04-13T05:05:00.000Z",
            updatedAt: "2026-04-13T05:05:00.000Z",
          }),
          "run-older": makeDetail({
            runId: "run-older",
            assignment: {
              name: "Older run",
              sourcePath: "/tmp/older.md",
            },
            name: "Older run",
            startedAt: "2026-04-13T05:00:00.000Z",
            updatedAt: "2026-04-13T05:00:00.000Z",
          }),
        },
      });

      const user = userEvent.setup();
      await renderApp();
      await findRunCard("Newest run");

      const source = MockEventSource.instances[0];
      if (!source) {
        throw new Error("expected an EventSource subscription");
      }
      source.emitOpen();
      source.emitMessage({
        type: "summary_upsert",
        summary: makeRun({
          runId: "run-older",
          assignmentName: "Older run",
          name: "Older run",
          startedAt: "2026-04-13T05:00:00.000Z",
          updatedAt: "2026-04-13T05:10:00.000Z",
        }),
      });

      await waitFor(() => {
        expect(getColumnRunNames("Running")).toEqual(["Older run", "Newest run"]);
      });
      expect(await findRunCard("Older run")).toHaveAttribute("data-motion-kind", "reorder");
      expect(animateMock).not.toHaveBeenCalled();
    } finally {
      if (originalAnimateDescriptor) {
        Object.defineProperty(Element.prototype, "animate", originalAnimateDescriptor);
      } else {
        (Element.prototype as { animate?: typeof Element.prototype.animate }).animate = undefined;
      }
    }
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

  it("remembers per-run drawer preview and detail state across switching and close/reselect", async () => {
    installFetchMock(
      {
        runs: [makeRun(), makeRun({ runId: "run-2", assignmentName: "Second run" })],
        details: {
          "run-1": makeDetail({
            attachments: [
              makeAttachment({
                id: "att-md",
                name: "notes.md",
                mimeType: "text/markdown; charset=utf-8",
              }),
            ],
          }),
          "run-2": makeDetail({
            runId: "run-2",
            assignment: {
              name: "Second run",
              sourcePath: "/tmp/a.md",
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
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-md\/content$/.test(url)) {
            return new Response("# Markdown preview", {
              status: 200,
              headers: { "content-type": "text/markdown; charset=utf-8" },
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await findRunCard("Second run");

    await user.click(await findRunCard("Build dashboard"));
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));
    await user.click(screen.getByRole("button", { name: /^Preview notes\.md$/ }));
    expect(await screen.findByLabelText("Attachment preview")).toBeInTheDocument();
    expect(await screen.findByText("Markdown preview")).toBeInTheDocument();

    await user.click(await findRunCard("Second run"));
    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    const secondRunTablist = await screen.findByRole("tablist", { name: "Run surface" });
    await user.click(
      within(secondRunTablist).getByRole("tab", {
        name: "Tasks",
      }),
    );
    expect(
      await screen.findByRole("button", { name: /shared task/i, expanded: false }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Attachment preview")).not.toBeVisible();
    await user.click(
      within(secondRunTablist).getByRole("tab", {
        name: "Info",
      }),
    );

    await user.click(await findRunCard("Build dashboard"));
    expect(await screen.findByLabelText("Attachment preview")).toBeInTheDocument();
    expect(await screen.findByText("Markdown preview")).toBeInTheDocument();

    await user.click(getCloseDetailButton());
    await user.click(await findRunCard("Build dashboard"));
    expect(await screen.findByLabelText("Attachment preview")).toBeInTheDocument();
    expect(await screen.findByText("Markdown preview")).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Info",
      }),
    );
    expect(await screen.findByRole("button", { name: /^Upload$/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Attachment preview")).not.toBeVisible();
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
    await waitFor(() => {
      expect(findEventSource("/api/runs/run-1/events/detail")).toBeDefined();
    });
    expect(hasEventSource("/api/runs/run-1/events/timeline")).toBe(false);
    expect(hasEventSource("/api/runs/run-1/events/audit")).toBe(false);

    await user.click(getCloseDetailButton());
    await user.click(await findRunCard("Second run"));

    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    await waitFor(() => {
      expect(findEventSource("/api/runs/run-2/events/detail")).toBeDefined();
    });
    expect(hasEventSource("/api/runs/run-2/events/timeline")).toBe(false);
    expect(hasEventSource("/api/runs/run-2/events/audit")).toBe(false);
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
            },
            name: "Current run",
          }),
          "run-2": makeDetail({
            runId: "run-2",
            assignment: {
              name: "Plan feature follow-up",
              sourcePath: "/tmp/dependency.md",
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
                ? (JSON.parse(init.body) as { type?: string; runId?: string })
                : {};
            if (body.type === "run" && body.runId) {
              postedDependencyIds.push(body.runId);
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

  it("adds typed group dependencies and renders group dependents", async () => {
    const postedDependencies: unknown[] = [];
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
            runId: "group-member",
            runGroupId: "shared-group",
            assignmentName: "Shared member",
            name: "Shared member",
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
            },
            name: "Current run",
          }),
          "group-member": makeDetail({
            runId: "group-member",
            runGroupId: "shared-group",
            assignment: {
              name: "Shared member",
              sourcePath: "/tmp/shared.md",
            },
            name: "Shared member",
            dependents: [
              {
                type: "run",
                via: "group",
                runId: "run-1",
                dependencyGroupId: "shared-group",
                name: "Current run",
                status: "initialized",
                effectiveStatus: "initialized",
                archivedAt: null,
                satisfied: false,
                missing: false,
              },
            ],
          }),
        },
      },
      {
        handleRequest: (url, init) => {
          if (/\/api\/runs\/run-1\/dependencies$/.test(url) && init?.method === "POST") {
            postedDependencies.push(
              typeof init.body === "string" ? JSON.parse(init.body) : undefined,
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Current run"));
    await user.click(await screen.findByRole("button", { name: /^Dependencies\b/i }));
    await user.click(screen.getByRole("tab", { name: "Run group" }));
    await user.type(screen.getByLabelText("Dependency run group"), "shared-group");
    await user.click(screen.getByRole("button", { name: /add dependency/i }));

    await waitFor(() =>
      expect(postedDependencies).toEqual([{ type: "group", groupId: "shared-group" }]),
    );
    expect(await screen.findByText("Run group shared-group")).toBeInTheDocument();
    expect(screen.getByText("1/2 successful")).toBeInTheDocument();

    await user.click(await findRunCard("Shared member"));
    await user.click(await screen.findByRole("button", { name: /^Dependencies\b/i }));
    expect(screen.getByText("via group shared-group")).toBeInTheDocument();
  });

  it("renders markdown and plain-text attachment previews in the drawer", async () => {
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [
              makeAttachment({
                id: "att-md",
                name: "notes.md",
                mimeType: "text/markdown; charset=utf-8",
              }),
              makeAttachment({
                id: "att-log",
                name: "build.log",
                mimeType: "text/plain; charset=utf-8",
              }),
            ],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-md\/content$/.test(url)) {
            return new Response(attachmentMermaidMarkdown, {
              status: 200,
              headers: { "content-type": "text/markdown; charset=utf-8" },
            });
          }
          if (/\/api\/runs\/run-1\/attachments\/att-log\/content$/.test(url)) {
            return new Response("line one\nline two", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    expect(await screen.findByRole("button", { name: /^Attachments 2$/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Attachments 2$/i }));

    await user.click(screen.getByRole("button", { name: /^Preview notes\.md$/ }));
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeInTheDocument();
    const frontmatterCode = screen.getByText((_, element) => {
      return (
        element?.tagName === "CODE" && element.textContent === "title: Notes\nsource: attachment\n"
      );
    });
    expect(frontmatterCode.closest("pre")).not.toBeNull();
    expect(await screen.findByLabelText("Mermaid diagram")).toBeInTheDocument();
    expect(renderMermaid).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      "graph TD\nStart-->Finish",
    );
    await user.click(screen.getByRole("button", { name: "Next attachment: build.log" }));
    const preview = await screen.findByLabelText("Attachment preview content");
    expect(preview.querySelector("pre code")?.textContent).toBe("line one\nline two");
    expect(preview.querySelector("pre code")).not.toBeNull();
  });

  it("renders supported image previews through object URLs and revokes them on attachment changes and unmount", async () => {
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [
              makeAttachment({
                id: "att-svg",
                name: "diagram.svg",
                mimeType: "image/svg+xml",
              }),
              makeAttachment({
                id: "att-png",
                name: "photo.png",
                mimeType: "image/png",
              }),
              makeAttachment({
                id: "att-pdf",
                name: "report.pdf",
                mimeType: "application/pdf",
              }),
            ],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-svg\/content$/.test(url)) {
            return new Response(
              '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
              {
                status: 200,
                headers: { "content-type": "image/svg+xml" },
              },
            );
          }
          if (/\/api\/runs\/run-1\/attachments\/att-png\/content$/.test(url)) {
            return new Response(new Uint8Array([137, 80, 78, 71]), {
              status: 200,
              headers: { "content-type": "image/png" },
            });
          }
          return undefined;
        },
      },
    );

    const createObjectURL = vi.fn((blob: Blob) =>
      blob.type === "image/svg+xml" ? "blob:svg-preview" : "blob:png-preview",
    );
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));

    expect(screen.queryByRole("button", { name: /^Preview report\.pdf$/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Preview diagram\.svg$/ }));
    const svgPreview = await screen.findByRole("img", { name: "diagram.svg" });
    expect(svgPreview).toHaveAttribute("src", "blob:svg-preview");
    expect(screen.getByLabelText("Attachment preview content").querySelector("svg")).toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Next attachment: photo.png" }));
    const pngPreview = await screen.findByRole("img", { name: "photo.png" });
    expect(pngPreview).toHaveAttribute("src", "blob:png-preview");
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:svg-preview"));

    await user.click(getCloseDetailButton());
    await waitFor(() =>
      expect(screen.queryByLabelText("Attachment preview")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:png-preview"));
  });

  it("opens preview from attachment row metadata clicks without changing the selected-run route", async () => {
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [
              makeAttachment({
                id: "att-log",
                name: "build.log",
                mimeType: "text/plain; charset=utf-8",
              }),
            ],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-log\/content$/.test(url)) {
            return new Response("line one\nline two", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));
    await user.click(screen.getByText("text/plain; charset=utf-8"));

    const preview = await screen.findByLabelText("Attachment preview content");
    expect(preview.querySelector("pre code")?.textContent).toBe("line one\nline two");
    expect(router.state.location.pathname).toBe("/runs/run-1");
    expect(screen.getByRole("tab", { name: "Attachments" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("navigates attachment previews with buttons and fullscreen arrow keys", async () => {
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [
              makeAttachment({
                id: "att-alpha",
                name: "alpha.txt",
                mimeType: "text/plain; charset=utf-8",
              }),
              makeAttachment({
                id: "att-beta",
                name: "beta.txt",
                mimeType: "text/plain; charset=utf-8",
              }),
              makeAttachment({
                id: "att-gamma",
                name: "gamma.txt",
                mimeType: "text/plain; charset=utf-8",
              }),
            ],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-alpha\/content$/.test(url)) {
            return new Response("alpha body", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          if (/\/api\/runs\/run-1\/attachments\/att-beta\/content$/.test(url)) {
            return new Response("beta body", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          if (/\/api\/runs\/run-1\/attachments\/att-gamma\/content$/.test(url)) {
            return new Response("gamma body", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));
    await user.click(screen.getByRole("button", { name: /^Preview alpha\.txt$/ }));

    expect(await screen.findByText("alpha body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous attachment" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next attachment: beta.txt" }));
    expect(await screen.findByText("beta body")).toBeInTheDocument();
    screen.getByLabelText("Attachment preview").focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("beta body")).toBeInTheDocument();
    expect(screen.queryByText("gamma body")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand drawer to full width" }));
    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText("gamma body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next attachment" })).toBeDisabled();

    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByText("beta body")).toBeInTheDocument();
    expect(screen.getByLabelText("Attachment preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toBeInTheDocument();
  });

  it("selects the next attachment when the previewed attachment is removed off the preview tab", async () => {
    setStoredDashboardViewState({ activeRightSurface: "detail" });
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [
              makeAttachment({ id: "att-alpha", name: "alpha.txt" }),
              makeAttachment({ id: "att-beta", name: "beta.txt" }),
              makeAttachment({ id: "att-gamma", name: "gamma.txt" }),
            ],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-alpha\/content$/.test(url)) {
            return new Response("alpha body", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          if (/\/api\/runs\/run-1\/attachments\/att-beta\/content$/.test(url)) {
            return new Response("beta body", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          if (/\/api\/runs\/run-1\/attachments\/att-gamma\/content$/.test(url)) {
            return new Response("gamma body", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.click(screen.getByRole("button", { name: /^Preview beta\.txt$/ }));
    expect(await screen.findByRole("heading", { name: "beta.txt" })).toBeInTheDocument();
    expect(await screen.findByText("beta body")).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Info",
      }),
    );
    await user.click(screen.getByRole("button", { name: /^Remove beta\.txt$/ }));
    await user.click(screen.getByRole("button", { name: /^Confirm remove beta\.txt$/ }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Preview beta\.txt$/ })).not.toBeInTheDocument(),
    );

    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Attachments",
      }),
    );

    expect(await screen.findByRole("heading", { name: "gamma.txt" })).toBeInTheDocument();
    expect(await screen.findByText("gamma body")).toBeInTheDocument();
  });

  it("keeps image preview failures on the existing inline error copy", async () => {
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [
              makeAttachment({
                id: "att-image",
                name: "photo.png",
                mimeType: "image/png",
              }),
            ],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-image\/content$/.test(url)) {
            return new Response(JSON.stringify({ error: { message: "preview failed" } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
          return undefined;
        },
      },
    );

    const createObjectURL = vi.fn(() => "blob:image-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));
    await user.click(screen.getByRole("button", { name: /^Preview photo\.png$/ }));

    expect(await screen.findByLabelText("Attachment preview")).toBeInTheDocument();
    expect(await screen.findByText("Attachment preview failed to load")).toBeInTheDocument();
    expect(screen.getByText("preview failed")).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("uses A to open the top-level attachment preview tab with an empty state", async () => {
    setStoredDashboardViewState({ activeRightSurface: "detail" });
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\?scope=group$/.test(url)) {
            return new Response(JSON.stringify({ attachments: [] }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.keyboard("a");

    expect(screen.getByRole("tab", { name: "Attachments" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByText("No attachments available.")).toBeInTheDocument();
  });

  it("shows unavailable preview copy for unsupported top-level attachments", async () => {
    setStoredDashboardViewState({ activeRightSurface: "detail" });
    installFetchMock({
      runs: [makeRun({ runId: "run-1", name: "Attachment run", attachmentCount: 1 })],
      details: {
        "run-1": makeDetail({
          runId: "run-1",
          name: "Attachment run",
          attachments: [
            makeAttachment({
              id: "att-pdf",
              name: "report.pdf",
              mimeType: "application/pdf",
            }),
          ],
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.click(
      within(screen.getByRole("tablist", { name: "Run surface" })).getByRole("tab", {
        name: "Attachments",
      }),
    );

    expect(await screen.findByRole("heading", { name: "report.pdf" })).toBeInTheDocument();
    expect(screen.getByText("Attachment preview unavailable")).toBeInTheDocument();
    expect(screen.getByText("Download the attachment to view it.")).toBeInTheDocument();
  });

  it("keeps attachment preview loading and unavailable states inline", async () => {
    let resolvePreview: ((response: Response | PromiseLike<Response>) => void) | undefined;

    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [
              makeAttachment({
                id: "att-md",
                name: "notes.md",
                mimeType: "text/markdown; charset=utf-8",
              }),
            ],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-md\/content$/.test(url)) {
            return new Promise<Response>((resolve) => {
              resolvePreview = resolve;
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));
    await user.click(screen.getByRole("button", { name: /^Preview notes\.md$/ }));

    expect(await screen.findByLabelText("Attachment preview loading")).toBeInTheDocument();
    resolvePreview?.(
      new Response("# Loading complete", {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
    );
    expect(await screen.findByText("Loading complete")).toBeInTheDocument();

    expect(getCloseDetailButton()).toBeInTheDocument();
  });

  it("keeps preview errors inline and isolates row preview clicks from attachment actions", async () => {
    setStoredDashboardViewState({ activeRightSurface: "detail" });
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [
              makeAttachment({
                id: "att-md",
                name: "notes.md",
                mimeType: "text/markdown; charset=utf-8",
              }),
              makeAttachment({
                id: "att-pdf",
                name: "report.pdf",
                mimeType: "application/pdf",
              }),
            ],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\/att-md\/content$/.test(url)) {
            return new Response(JSON.stringify({ error: { message: "preview failed" } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
          return undefined;
        },
      },
    );

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

    await user.click(screen.getByRole("button", { name: /^Download report\.pdf$/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /^Remove notes\.md$/ }));
    expect(screen.getByRole("button", { name: /^Confirm remove notes\.md$/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Cancel remove notes\.md$/ }));

    expect(screen.queryByRole("button", { name: /^Preview report\.pdf$/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Preview notes\.md$/ }));
    expect(await screen.findByLabelText("Attachment preview")).toBeInTheDocument();
    expect(await screen.findByText("Attachment preview failed to load")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Attachments" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    anchorClick.mockRestore();
  });

  it("uploads, downloads, and removes attachments from the detail drawer", async () => {
    setStoredDashboardViewState({ activeRightSurface: "detail" });
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

    await user.upload(
      screen.getByLabelText("Upload attachment file"),
      new File(["hello"], "notes.md", { type: "text/markdown" }),
    );

    expect(await screen.findByRole("button", { name: /^Download notes\.md$/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Download notes\.md$/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(anchorClick).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^Remove notes\.md$/ }));
    expect(screen.getByRole("button", { name: /^Confirm remove notes\.md$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Cancel remove notes\.md$/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Confirm remove notes\.md$/ }));
    await waitFor(() => expect(screen.getByText("No attachments yet.")).toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalled();

    anchorClick.mockRestore();
  });

  it("shows group attachments with a source run id and uses ownerRunId for cross-run preview/download", async () => {
    setStoredDashboardViewState({ activeRightSurface: "detail" });
    const fetchMock = installFetchMock(
      {
        runs: [makeRun({ runId: "run-1", name: "Attachment run" })],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [makeAttachment({ id: "att-run", name: "run-notes.md" })],
          }),
          "run-2": makeDetail({
            runId: "run-2",
            name: "Peer run",
            attachments: [makeAttachment({ id: "att-peer", name: "peer-notes.md" })],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\?scope=group$/.test(url)) {
            return new Response(
              JSON.stringify({
                attachments: [
                  {
                    ...makeAttachment({ id: "att-run", name: "run-notes.md" }),
                    ownerRunId: "run-1",
                  },
                  {
                    ...makeAttachment({ id: "att-peer", name: "peer-notes.md" }),
                    ownerRunId: "run-2",
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (/\/api\/runs\/run-2\/attachments\/att-peer\/content$/.test(url)) {
            return new Response("group attachment body", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          return undefined;
        },
      },
    );
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

    expect(screen.queryByRole("tab", { name: "Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Group" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Preview run-notes\.md$/ })).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /^Preview peer-notes\.md$/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Upload attachment file")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Remove peer-notes\.md$/ }),
    ).not.toBeInTheDocument();

    const peerRow = screen.getByRole("button", { name: /^Preview peer-notes\.md$/ }).closest("li");
    expect(peerRow).not.toBeNull();
    expect(
      within(peerRow as HTMLLIElement).getByRole("button", { name: "Open source run run-2" }),
    ).toHaveTextContent("run-2");
    await user.click(within(peerRow as HTMLLIElement).getByRole("button", { name: /^Download / }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-2/attachments/att-peer/content"),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(anchorClick).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /^Preview peer-notes\.md$/ }));
    expect(await screen.findByText("group attachment body")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Attachment preview")).getByRole("heading", {
        name: "peer-notes.md",
      }),
    ).toBeInTheDocument();
    expect(within(screen.getByLabelText("Attachment preview")).queryByText("run-2")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Download$/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(anchorClick).toHaveBeenCalledTimes(2);

    anchorClick.mockRestore();
  });

  it("switches to the source run when clicking a group attachment run id", async () => {
    setStoredDashboardViewState({ activeRightSurface: "detail" });
    installFetchMock(
      {
        runs: [
          makeRun({ runId: "run-1", name: "Attachment run" }),
          makeRun({ runId: "run-2", name: "Peer run" }),
        ],
        details: {
          "run-1": makeDetail({
            runId: "run-1",
            name: "Attachment run",
            attachments: [makeAttachment({ id: "att-run", name: "run-notes.md" })],
          }),
          "run-2": makeDetail({
            runId: "run-2",
            name: "Peer run",
            attachments: [makeAttachment({ id: "att-peer", name: "peer-notes.md" })],
          }),
        },
      },
      {
        handleRequest: (url) => {
          if (/\/api\/runs\/run-1\/attachments\?scope=group$/.test(url)) {
            return new Response(
              JSON.stringify({
                attachments: [
                  {
                    ...makeAttachment({ id: "att-run", name: "run-notes.md" }),
                    ownerRunId: "run-1",
                  },
                  {
                    ...makeAttachment({ id: "att-peer", name: "peer-notes.md" }),
                    ownerRunId: "run-2",
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Attachment run"));
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));
    await user.click(screen.getByRole("button", { name: "Open source run run-2" }));

    expect(await screen.findByText("Peer run")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /^Preview peer-notes\.md$/ }),
    ).toBeInTheDocument();
  });

  it("navigates from the sidebar into the New Run route and hides the board", async () => {
    installFetchMock(
      {
        runs: [makeRun({ runId: "run-existing", name: "Existing run" })],
        details: {
          "run-existing": makeDetail({ runId: "run-existing", name: "Existing run" }),
        },
      },
      {
        handleRequest: (url) => {
          if (url === "/api/agents") {
            return new Response(
              JSON.stringify({ agents: makeDefinitionList("agent", ["planner"]) }),
              {
                status: 200,
              },
            );
          }
          if (url === "/api/assignments") {
            return new Response(
              JSON.stringify({ assignments: makeDefinitionList("assignment", ["plan-feature"]) }),
              { status: 200 },
            );
          }
          if (url.includes("/api/run-input-surface")) {
            return new Response(JSON.stringify({ inputSurface: makeRunInputSurface() }), {
              status: 200,
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    expect(await findRunCard("Existing run")).toBeInTheDocument();
    await user.click(getSidebarNavigation().getByRole("button", { name: "New Run" }));

    expect(await screen.findByRole("heading", { name: "New Run" })).toBeInTheDocument();
    expect(screen.queryByText("Initialized")).not.toBeInTheDocument();

    await user.selectOptions(await screen.findByLabelText("Agent"), "planner");
    await user.selectOptions(screen.getByLabelText("Assignment"), "plan-feature");

    expect(await screen.findByRole("heading", { name: "Task" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Execution" })).toBeInTheDocument();
  });

  it("shows an inline retryable resolver error and preserves entered values", async () => {
    let resolverAttempts = 0;
    installFetchMock(
      {
        runs: [],
        details: {},
      },
      {
        handleRequest: (url) => {
          if (url === "/api/agents") {
            return new Response(
              JSON.stringify({ agents: makeDefinitionList("agent", ["planner"]) }),
              {
                status: 200,
              },
            );
          }
          if (url === "/api/assignments") {
            return new Response(
              JSON.stringify({ assignments: makeDefinitionList("assignment", ["plan-feature"]) }),
              { status: 200 },
            );
          }
          if (url.includes("/api/run-input-surface")) {
            resolverAttempts += 1;
            if (resolverAttempts === 1) {
              return new Response(
                JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "surface failed" } }),
                { status: 500 },
              );
            }
            return new Response(JSON.stringify({ inputSurface: makeRunInputSurface() }), {
              status: 200,
            });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp("/runs/new");

    await user.type(await screen.findByLabelText("Name"), "Resolver retry");
    await user.selectOptions(screen.getByLabelText("Agent"), "planner");
    await user.selectOptions(screen.getByLabelText("Assignment"), "plan-feature");

    expect(await screen.findByRole("alert")).toHaveTextContent("surface failed");
    expect(screen.getByLabelText("Name")).toHaveValue("Resolver retry");
    expect(screen.getByLabelText("Agent")).toHaveValue("planner");
    expect(screen.getByLabelText("Assignment")).toHaveValue("plan-feature");

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Task" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Resolver retry");
    expect(resolverAttempts).toBe(2);
  });

  it("keeps Initialize disabled until required fields are satisfied and submits via /api/runs/init", async () => {
    const state = {
      runs: [makeRun({ runId: "run-init", name: "Initialized run" })],
      details: {
        "run-init": makeDetail({
          runId: "run-init",
          name: "Initialized run",
          status: "initialized",
        }),
      },
    };
    const fetchMock = installFetchMock(state, {
      handleRequest: async (url, init) => {
        if (url === "/api/agents") {
          return new Response(
            JSON.stringify({ agents: makeDefinitionList("agent", ["planner"]) }),
            {
              status: 200,
            },
          );
        }
        if (url === "/api/assignments") {
          return new Response(
            JSON.stringify({ assignments: makeDefinitionList("assignment", ["plan-feature"]) }),
            { status: 200 },
          );
        }
        if (url.includes("/api/run-input-surface")) {
          return new Response(JSON.stringify({ inputSurface: makeRunInputSurface() }), {
            status: 200,
          });
        }
        if (url === "/api/runs/init" && init?.method === "POST") {
          return new Response(JSON.stringify({ run: state.details["run-init"] }), { status: 200 });
        }
        return undefined;
      },
    });

    const user = userEvent.setup();
    await renderApp("/runs/new");

    await screen.findByRole("option", { name: "planner" });
    await user.selectOptions(await screen.findByLabelText("Agent"), "planner");
    await user.selectOptions(screen.getByLabelText("Assignment"), "plan-feature");
    await screen.findByRole("heading", { name: "Task" });

    const initializeButton = screen.getByRole("button", { name: "Initialize" });
    expect(initializeButton).toBeDisabled();

    await user.type(screen.getByLabelText("Plan"), "Implement the new route.");
    expect(initializeButton).toBeEnabled();

    await user.click(initializeButton);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/init",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const initRequest = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/runs/init" && init?.method === "POST",
    )?.[1];
    expect(initRequest).toBeDefined();
    expect(JSON.parse((initRequest as RequestInit).body as string)).toMatchObject({
      webVars: { plan: "Implement the new route." },
    });
    expect((await screen.findAllByText("Initialized run")).length).toBeGreaterThan(0);
  });

  it("submits Start now through /api/runs and routes to the started run", async () => {
    const state = {
      runs: [makeRun({ runId: "run-start", name: "Started run" })],
      details: {
        "run-start": makeDetail({ runId: "run-start", name: "Started run" }),
      },
    };
    const fetchMock = installFetchMock(state, {
      handleRequest: async (url, init) => {
        if (url === "/api/agents") {
          return new Response(
            JSON.stringify({ agents: makeDefinitionList("agent", ["planner"]) }),
            {
              status: 200,
            },
          );
        }
        if (url === "/api/assignments") {
          return new Response(
            JSON.stringify({ assignments: makeDefinitionList("assignment", ["plan-feature"]) }),
            { status: 200 },
          );
        }
        if (url.includes("/api/run-input-surface")) {
          return new Response(JSON.stringify({ inputSurface: makeRunInputSurface() }), {
            status: 200,
          });
        }
        if (url === "/api/runs" && init?.method === "POST") {
          return new Response(JSON.stringify({ runId: "run-start" }), { status: 200 });
        }
        return undefined;
      },
    });

    const user = userEvent.setup();
    await renderApp("/runs/new");

    await screen.findByRole("option", { name: "planner" });
    await user.selectOptions(await screen.findByLabelText("Agent"), "planner");
    await user.selectOptions(screen.getByLabelText("Assignment"), "plan-feature");
    await screen.findByRole("heading", { name: "Task" });
    await user.type(screen.getByLabelText("Plan"), "Start immediately.");

    await user.click(screen.getByRole("button", { name: "Start now" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const startRequest = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/runs" && init?.method === "POST",
    )?.[1];
    expect(startRequest).toBeDefined();
    expect(JSON.parse((startRequest as RequestInit).body as string)).toMatchObject({
      webVars: { plan: "Start immediately." },
    });
    expect((await screen.findAllByText("Started run")).length).toBeGreaterThan(0);
  });
});
