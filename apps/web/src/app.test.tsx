import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunAttachment } from "@task-runner/core/contracts/attachments.js";
import type { RunAuditHistory, RunTimelineHistory } from "@task-runner/core/contracts/events.js";
import type { RunInputSurface } from "@task-runner/core/contracts/run-input-surface.js";
import type { RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { queryClient } from "./lib/query.js";
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

const APP_CONFIG = {
  apiBasePath: "/api",
  runSummaryEventsPath: "/api/events/run-summaries",
};

const DEFAULT_DASHBOARD_PREFERENCES = {
  hideEmptyColumns: true,
  collapseFailureStates: true,
  showArchived: false,
  showNotesOnly: false,
  showScheduledOnly: false,
  showPinnedOnly: false,
  sortByRecentUpdates: false,
  auditNewestFirst: false,
  visibleFocusIndicators: false,
  structuredFilters: {
    repo: null,
    agent: null,
    backend: null,
    family: null,
  },
};

const DEFAULT_DASHBOARD_VIEW_STATE: {
  collapsedColumnKeys: string[];
} = {
  collapsedColumnKeys: [],
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

function setStoredDashboardPreferences(overrides: Partial<typeof DEFAULT_DASHBOARD_PREFERENCES>) {
  window.localStorage.setItem(
    "task-runner:web:dashboard-preferences",
    JSON.stringify({
      ...DEFAULT_DASHBOARD_PREFERENCES,
      ...overrides,
    }),
  );
}

function setStoredDashboardViewState(overrides: Partial<typeof DEFAULT_DASHBOARD_VIEW_STATE>) {
  window.localStorage.setItem(
    "task-runner:web:dashboard-view-state",
    JSON.stringify({
      ...DEFAULT_DASHBOARD_VIEW_STATE,
      ...overrides,
    }),
  );
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
    familyRootRunId: null,
    repo: "task-runner",
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
    cwd: "/tmp/task-runner",
    startedAt: "2026-04-13T05:00:00.000Z",
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
    parentRunId: null,
    repo: "task-runner",
    status: "running",
    effectiveStatus: "running",
    archivedAt: null,
    note: null,
    pinned: false,
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
        value: "/tmp/task-runner",
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
            activeTask: detail.activeTask,
            execution: detail.execution,
            capabilities: detail.capabilities,
          }
        : run,
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
      return new Response(JSON.stringify({ result: { runId, name, changed } }), { status: 200 });
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
      return new Response(JSON.stringify({ result: { runId, note, changed } }), { status: 200 });
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
      return new Response(JSON.stringify({ result: { runId, pinned, changed } }), { status: 200 });
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
      return new Response(JSON.stringify({ result: { runId, backendSessionId, changed } }), {
        status: 200,
      });
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
      return new Response(JSON.stringify({ result: { runId, backendSessionId: null, changed } }), {
        status: 200,
      });
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

async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Filters" }));
  return await screen.findByRole("dialog", { name: "Filters" });
}

function findEventSource(urlSuffix: string) {
  const instance = MockEventSource.instances.find((candidate) => candidate.url.endsWith(urlSuffix));
  if (!instance) {
    throw new Error(`expected EventSource for ${urlSuffix}`);
  }
  return instance;
}

function getCloseDetailButton() {
  const closeButtons = screen.getAllByRole("button", { name: /close detail/i });
  const closeButton = closeButtons[0];
  if (!closeButton) {
    throw new Error("expected a close-detail button");
  }
  return closeButton;
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

function defineElementMetric(element: Element, key: string, value: number | (() => void)) {
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
    MockEventSource.instances = [];
    initializeMermaid.mockClear();
    renderMermaid.mockClear();
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal("CSS", {
      escape: (value: string) => value.replace(/["\\]/g, "\\$&"),
    } satisfies Pick<typeof CSS, "escape">);
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
    expect(screen.getAllByText("CWD").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("/tmp/task-runner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy cwd path/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy run id/i })).toBeInTheDocument();
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
            workspacePath: "/tmp/task-runner/planning-assignment.md",
          },
        }),
        "run-child": makeDetail({
          runId: "run-child",
          name: "Implementer run",
          assignment: {
            name: "Implementer run",
            sourcePath: "/tmp/implementer-assignment.md",
            workspacePath: "/tmp/task-runner/implementer-assignment.md",
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

    await user.click(screen.getByRole("tab", { name: "Prompt" }));
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
    await user.click(screen.getByRole("button", { name: "Attempts" }));

    expect(await screen.findByRole("tab", { name: "Pending" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Attempts" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Attempt view" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Message" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Prompt" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Response" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Diagnostics" })).toBeInTheDocument();
    expect(screen.getByText("Review this handoff before launch.")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Prompt" }));
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

    let timelineSource: MockEventSource | undefined;
    await waitFor(() => {
      timelineSource = MockEventSource.instances.find((candidate) =>
        candidate.url.endsWith("/api/runs/run-1/events/timeline"),
      );
      expect(timelineSource).toBeDefined();
    });
    if (!timelineSource) {
      throw new Error("expected timeline EventSource after run start");
    }
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

    await user.click(screen.getByRole("tab", { name: "Prompt" }));
    expect(screen.getByRole("heading", { level: 2, name: "Attempt prompt" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));
    expect(screen.getByText("No diagnostics have arrived yet.")).toBeInTheDocument();
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

    await user.click(screen.getByRole("tab", { name: "Prompt" }));
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

    const runSections = await screen.findByRole("navigation", { name: "Run sections" });
    expect(runSections).toHaveClass("tabs", "tabs--scrollable");
    expect(runSections.querySelectorAll(":scope > .tab")).toHaveLength(7);
    expect(
      [...runSections.querySelectorAll(":scope > .tab")].map((tab) =>
        tab.textContent?.replace(/\s+\S+\/\S+$/, "").trim(),
      ),
    ).toEqual(["Tasks", "Attempts", "Attachments", "Data", "Audit", "Dependencies", "Notes"]);
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

    const runSections = await screen.findByRole("navigation", { name: "Run sections" });
    expect(runSections.querySelectorAll(":scope > .tab")).toHaveLength(6);
    expect(
      [...runSections.querySelectorAll(":scope > .tab")].map((tab) =>
        tab.textContent?.replace(/\s+\S+\/\S+$/, "").trim(),
      ),
    ).toEqual(["Tasks", "Attachments", "Data", "Audit", "Dependencies", "Notes"]);
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

    const auditSource = findEventSource("/api/runs/run-1/events/audit");
    auditSource.emitOpen();
    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));

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
    expect(window.localStorage.getItem("task-runner:web:dashboard-preferences")).toContain(
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

    const auditSource = findEventSource("/api/runs/run-1/events/audit");
    auditSource.emitOpen();
    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));

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

    const auditSource = findEventSource("/api/runs/run-1/events/audit");
    auditSource.emitOpen();
    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));

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

    const auditSource = findEventSource("/api/runs/run-1/events/audit");
    auditSource.emitOpen();
    await user.click(screen.getByRole("button", { name: /^Audit\b/ }));

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
            workspacePath: "/tmp/scheduled-b.md",
          },
          schedule,
          scheduleState: "future",
        }),
        "run-plain": makeDetail({
          runId: "run-plain",
          assignment: {
            name: "Plain dashboard",
            sourcePath: "/tmp/plain-a.md",
            workspacePath: "/tmp/plain-b.md",
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

    const stored = window.localStorage.getItem("task-runner:web:dashboard-preferences");
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
    expect(screen.getByRole("combobox", { name: "Repo" })).toHaveFocus();

    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
    });

    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    expect(await screen.findByRole("dialog", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Repo" })).toHaveFocus();
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

    const stored = window.localStorage.getItem("task-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      structuredFilters: {
        repo: "repo-a",
        agent: null,
        backend: null,
        family: null,
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

    const stored = window.localStorage.getItem("task-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      showPinnedOnly: true,
      structuredFilters: {
        repo: null,
        agent: null,
        backend: null,
        family: null,
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
            workspacePath: "/tmp/repo-a-codex.md",
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
            workspacePath: "/tmp/repo-b-claude.md",
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

  it("renders family toggles in the card header and reapplies after clearing from filters", async () => {
    const familyRuns = [
      makeRun({
        runId: "run-root",
        familyRootRunId: "run-root",
        assignmentName: "Family root",
        name: "Family root",
      }),
      makeRun({
        runId: "run-child",
        parentRunId: "run-root",
        familyRootRunId: "run-root",
        assignmentName: "Family child",
        name: "Family child",
      }),
    ];
    const fetchMock = installFetchMock(
      {
        runs: [
          ...familyRuns,
          makeRun({
            runId: "run-outside",
            assignmentName: "Outside run",
            name: "Outside run",
          }),
        ],
        details: {},
      },
      {
        handleRequest: (url) => {
          if (url.includes("/api/runs?includeArchived=true&familyOf=run-root")) {
            return new Response(JSON.stringify({ runs: familyRuns }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();

    const rootCard = await findRunCard("Family root");
    const childCard = await findRunCard("Family child");
    expect(within(rootCard).getByLabelText("Filter by family run-root")).toBeInTheDocument();
    expect(within(childCard).getByLabelText("Filter by family run-root")).toBeInTheDocument();
    expect(
      within(await findRunCard("Outside run")).queryByLabelText(/filter by family/i),
    ).not.toBeInTheDocument();

    await user.click(within(childCard).getByLabelText("Filter by family run-root"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs?includeArchived=true&familyOf=run-root",
        expect.objectContaining({
          headers: { accept: "application/json" },
        }),
      ),
    );
    expect(await findRunCard("Family root")).toBeInTheDocument();
    expect(await findRunCard("Family child")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Outside run/i })).not.toBeInTheDocument();

    const stored = window.localStorage.getItem("task-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      structuredFilters: {
        family: "run-root",
      },
    });

    await openFilters(user);
    expect(screen.getByRole("textbox", { name: "Family" })).toHaveValue("run-root");
    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(await findRunCard("Outside run")).toBeInTheDocument();

    await user.click(
      within(await findRunCard("Family child")).getByLabelText("Filter by family run-root"),
    );

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Outside run/i })).not.toBeInTheDocument();
    });
  });

  it("composes the family filter with search, pinned, notes, and archived dashboard filters", async () => {
    const familyRuns = [
      makeRun({
        runId: "run-root",
        familyRootRunId: "run-root",
        assignmentName: "Family root",
        name: "Family root",
        notePresent: true,
      }),
      makeRun({
        runId: "run-child",
        parentRunId: "run-root",
        familyRootRunId: "run-root",
        assignmentName: "Family child",
        name: "Family child",
        pinned: true,
      }),
      makeRun({
        runId: "run-archived",
        parentRunId: "run-root",
        familyRootRunId: "run-root",
        assignmentName: "Archived family",
        name: "Archived family",
        archivedAt: "2026-04-13T06:00:00.000Z",
        notePresent: true,
        status: "success",
        pinned: true,
      }),
    ];
    installFetchMock(
      {
        runs: [
          ...familyRuns,
          makeRun({
            runId: "run-outside",
            assignmentName: "Outside run",
            name: "Outside run",
            notePresent: true,
            pinned: true,
          }),
        ],
        details: {},
      },
      {
        handleRequest: (url) => {
          if (url.includes("/api/runs?includeArchived=true&familyOf=run-root")) {
            return new Response(JSON.stringify({ runs: familyRuns }), { status: 200 });
          }
          return undefined;
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(
      within(await findRunCard("Family root")).getByLabelText("Filter by family run-root"),
    );

    await user.type(screen.getByPlaceholderText("Search runs"), "child");
    expect(await findRunCard("Family child")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Family root/i })).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("Search runs"));
    await user.click(screen.getByRole("button", { name: /show pinned runs only/i }));
    expect(await findRunCard("Family child")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Family root/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show pinned runs only/i }));
    await user.click(screen.getByRole("button", { name: /show runs with notes only/i }));
    expect(await findRunCard("Family root")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Family child/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archived family/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show archived runs/i }));
    expect(await findRunCard("Archived family")).toBeInTheDocument();
  });

  it("shows the board error panel for failing family queries and retries the same family scope", async () => {
    let failFamilyFetch = true;
    const familyRuns = [
      makeRun({
        runId: "run-root",
        familyRootRunId: "run-root",
        assignmentName: "Family root",
        name: "Family root",
      }),
      makeRun({
        runId: "run-child",
        parentRunId: "run-root",
        familyRootRunId: "run-root",
        assignmentName: "Family child",
        name: "Family child",
      }),
    ];
    const fetchMock = installFetchMock(
      {
        runs: familyRuns,
        details: {},
      },
      {
        handleRequest: (url) => {
          if (!url.includes("/api/runs?includeArchived=true&familyOf=run-root")) {
            return undefined;
          }
          if (failFamilyFetch) {
            return new Response(
              JSON.stringify({
                error: {
                  code: "COMMAND_ERROR",
                  message: 'family scope could not resolve parent run "missing-parent"',
                },
              }),
              { status: 422 },
            );
          }
          return new Response(JSON.stringify({ runs: familyRuns }), { status: 200 });
        },
      },
    );

    const user = userEvent.setup();
    await renderApp();
    await user.click(
      within(await findRunCard("Family root")).getByLabelText("Filter by family run-root"),
    );

    expect(
      await screen.findByRole("heading", { name: "Run board failed to load" }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/family scope could not resolve parent run "missing-parent"/i),
    ).toBeInTheDocument();

    failFamilyFetch = false;
    await user.click(screen.getByRole("button", { name: "Retry board load" }));

    expect(await findRunCard("Family child")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs?includeArchived=true&familyOf=run-root",
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
            workspacePath: "/tmp/pending-b.md",
          },
          name: "Pending dashboard",
          status: "initialized",
        }),
        "run-running": makeDetail({
          runId: "run-running",
          assignment: {
            name: "Running dashboard",
            sourcePath: "/tmp/running-a.md",
            workspacePath: "/tmp/running-b.md",
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
            workspacePath: "/tmp/completed-b.md",
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
              workspacePath: "/tmp/fullscreen-b.md",
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
              workspacePath: "/tmp/fullscreen-d.md",
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
    await user.click(screen.getByRole("button", { name: "Expand drawer to full width" }));

    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

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
    expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    expect(resumeBody).toBeUndefined();

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

  it("toggles drawer fullscreen with f when a run detail is open", async () => {
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
            workspacePath: "/tmp/fullscreen-toggle-b.md",
          },
          name: "Fullscreen toggle",
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();

    await user.click(await findRunCard("Fullscreen toggle"));
    expect(screen.getByRole("button", { name: "Expand drawer to full width" })).toBeInTheDocument();

    await user.keyboard("f");
    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("f");
    expect(screen.getByRole("button", { name: "Expand drawer to full width" })).toHaveAttribute(
      "aria-pressed",
      "false",
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
            workspacePath: "/tmp/running-shortcuts-b.md",
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
            workspacePath: "/tmp/completed-shortcuts-b.md",
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
            workspacePath: "/tmp/running-shortcuts-1-b.md",
          },
          name: "Running shortcuts 1",
        }),
        "run-running-2": makeDetail({
          runId: "run-running-2",
          assignment: {
            name: "Running shortcuts 2",
            sourcePath: "/tmp/running-shortcuts-2-a.md",
            workspacePath: "/tmp/running-shortcuts-2-b.md",
          },
          name: "Running shortcuts 2",
        }),
        "run-running-3": makeDetail({
          runId: "run-running-3",
          assignment: {
            name: "Running shortcuts 3",
            sourcePath: "/tmp/running-shortcuts-3-a.md",
            workspacePath: "/tmp/running-shortcuts-3-b.md",
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
            workspacePath: "/tmp/running-shortcuts-1-b.md",
          },
          name: "Running shortcuts 1",
        }),
        "run-running-2": makeDetail({
          runId: "run-running-2",
          assignment: {
            name: "Running shortcuts 2",
            sourcePath: "/tmp/running-shortcuts-2-a.md",
            workspacePath: "/tmp/running-shortcuts-2-b.md",
          },
          name: "Running shortcuts 2",
        }),
        "run-running-3": makeDetail({
          runId: "run-running-3",
          assignment: {
            name: "Running shortcuts 3",
            sourcePath: "/tmp/running-shortcuts-3-a.md",
            workspacePath: "/tmp/running-shortcuts-3-b.md",
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
            workspacePath: "/tmp/running-shortcuts-b.md",
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
            workspacePath: "/tmp/completed-shortcuts-b.md",
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
            workspacePath: "/tmp/blocked-shortcuts-b.md",
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

    const storedViewState = window.localStorage.getItem("task-runner:web:dashboard-view-state");
    expect(storedViewState ? JSON.parse(storedViewState) : null).toEqual({
      collapsedColumnKeys: [],
      drawerWidth: 570,
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
    await user.click(screen.getByRole("button", { name: /render markdown/i, expanded: false }));

    expect(await screen.findByText("Done when:")).toBeInTheDocument();
    const bulletOne = screen.getByText("bullet one");
    expect(bulletOne).toBeInTheDocument();
    expect(bulletOne.tagName).toBe("LI");

    await user.click(screen.getByRole("button", { name: "Task notes" }));
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
            workspacePath: "/tmp/task-runner/assignment.md",
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
    await user.click(screen.getByRole("button", { name: "Notes" }));

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

    expect(screen.getByRole("button", { name: "View" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Touch-first note")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /run note for build dashboard/i }),
    ).not.toBeInTheDocument();
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
            workspacePath: "/tmp/b.md",
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
            workspacePath: "/tmp/b.md",
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
            workspacePath: "/tmp/b.md",
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
            workspacePath: "/tmp/b.md",
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
            workspacePath: "/tmp/b.md",
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
            workspacePath: "/tmp/b.md",
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
    const sortByRecentUpdates = screen.getByRole("checkbox", { name: "Sort by recent updates" });
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
    expect(sortByRecentUpdates).not.toBeChecked();
    expect(visibleFocusIndicators).not.toBeChecked();

    await user.click(sortByRecentUpdates);
    await user.click(visibleFocusIndicators);
    expect(sortByRecentUpdates).toBeChecked();
    expect(visibleFocusIndicators).toBeChecked();
    expect(appShell).toHaveAttribute("data-focus-indicators", "on");

    const stored = window.localStorage.getItem("task-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toEqual({
      hideEmptyColumns: false,
      collapseFailureStates: false,
      showArchived: true,
      showNotesOnly: false,
      showScheduledOnly: false,
      showPinnedOnly: false,
      sortByRecentUpdates: true,
      auditNewestFirst: false,
      visibleFocusIndicators: true,
      structuredFilters: {
        repo: null,
        agent: null,
        backend: null,
        family: null,
      },
    });

    view.unmount();
    queryClient.clear();
    await renderApp();
    await findRunCard("Build dashboard");
    await user.click(getSidebarNavigation().getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show archived runs" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Sort by recent updates" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Visible focus indicators" })).toBeChecked();
    expect(document.querySelector(".app")).toHaveAttribute("data-focus-indicators", "on");

    await user.click(getSidebarNavigation().getByRole("button", { name: "Runs" }));
    expect(await screen.findByTitle("Archived dashboard")).toBeInTheDocument();
    expect(getBoardColumn("Error")).toBeInTheDocument();
    expect(getBoardColumn("Aborted")).toBeInTheDocument();
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
            workspacePath: "/tmp/pinned-running-workspace.md",
          },
          startedAt: "2026-04-13T05:00:00.000Z",
        }),
        "running-newest": makeDetail({
          runId: "running-newest",
          name: "Newest running",
          assignment: {
            name: "Newest running",
            sourcePath: "/tmp/newest-running.md",
            workspacePath: "/tmp/newest-running-workspace.md",
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
            workspacePath: "/tmp/pinned-completed-workspace.md",
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
            workspacePath: "/tmp/newest-completed-workspace.md",
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

    const stored = window.localStorage.getItem("task-runner:web:dashboard-preferences");
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
            workspacePath: "/tmp/noted-b.md",
          },
          note: "already tracked",
        }),
        "run-plain": makeDetail({
          runId: "run-plain",
          assignment: {
            name: "Plain dashboard",
            sourcePath: "/tmp/plain-a.md",
            workspacePath: "/tmp/plain-b.md",
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

    const stored = window.localStorage.getItem("task-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toMatchObject({
      showNotesOnly: true,
    });

    view.unmount();
    queryClient.clear();

    await renderApp();
    expect(await findRunCard("Noted dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /plain dashboard/i })).not.toBeInTheDocument();
  });

  it("pins a selected run without forcing list and detail refetches while streams are healthy", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ assignmentName: "Build dashboard" })],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Build dashboard",
            sourcePath: "/tmp/a.md",
            workspacePath: "/tmp/b.md",
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

  it("opens the selected run note modal with n and toggles pin with p", async () => {
    const fetchMock = installFetchMock({
      runs: [makeRun({ assignmentName: "Build dashboard" })],
      details: {
        "run-1": makeDetail({
          assignment: {
            name: "Build dashboard",
            sourcePath: "/tmp/a.md",
            workspacePath: "/tmp/b.md",
          },
        }),
      },
    });

    const user = userEvent.setup();
    await renderApp();
    await user.click(await findRunCard("Build dashboard"));

    await user.keyboard("n");
    const noteInput = await screen.findByRole("textbox", {
      name: /run note for build dashboard/i,
    });
    expect(noteInput).toHaveFocus();

    await user.keyboard("{Escape}");
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
            workspacePath: "/tmp/archive-b.md",
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
    await user.keyboard("a");

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
            workspacePath: "/tmp/pinned-noted-b.md",
          },
          note: "keep visible",
          pinned: true,
        }),
        "run-plain": makeDetail({
          runId: "run-plain",
          assignment: {
            name: "Plain run",
            sourcePath: "/tmp/plain-run-a.md",
            workspacePath: "/tmp/plain-run-b.md",
          },
          note: null,
        }),
        "run-scheduled": makeDetail({
          runId: "run-scheduled",
          assignment: {
            name: "Scheduled run",
            sourcePath: "/tmp/scheduled-run-a.md",
            workspacePath: "/tmp/scheduled-run-b.md",
          },
          schedule,
          scheduleState: "future",
        }),
        "run-archived": makeDetail({
          runId: "run-archived",
          assignment: {
            name: "Archived noted",
            sourcePath: "/tmp/archived-noted-a.md",
            workspacePath: "/tmp/archived-noted-b.md",
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
    await user.click(screen.getByRole("checkbox", { name: "Sort by recent updates" }));
    await user.click(screen.getByRole("checkbox", { name: "Visible focus indicators" }));
    expect(document.querySelector(".app")).toHaveAttribute("data-focus-indicators", "on");

    await user.click(screen.getByRole("button", { name: "Restore defaults" }));

    expect(screen.queryByRole("checkbox", { name: "Hide empty columns" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Collapse failure states" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Show archived runs" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Sort by recent updates" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Visible focus indicators" })).not.toBeChecked();
    expect(document.querySelector(".app")).toHaveAttribute("data-focus-indicators", "off");
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

    const stored = window.localStorage.getItem("task-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toEqual({
      hideEmptyColumns: true,
      collapseFailureStates: true,
      showArchived: true,
      showNotesOnly: false,
      showScheduledOnly: false,
      showPinnedOnly: false,
      sortByRecentUpdates: false,
      auditNewestFirst: false,
      visibleFocusIndicators: false,
      structuredFilters: {
        repo: null,
        agent: null,
        backend: null,
        family: null,
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

    const stored = window.localStorage.getItem("task-runner:web:dashboard-preferences");
    expect(stored ? JSON.parse(stored) : null).toEqual({
      hideEmptyColumns: true,
      collapseFailureStates: true,
      showArchived: true,
      showNotesOnly: false,
      showScheduledOnly: false,
      showPinnedOnly: false,
      sortByRecentUpdates: false,
      auditNewestFirst: false,
      visibleFocusIndicators: false,
      structuredFilters: {
        repo: null,
        agent: null,
        backend: null,
        family: null,
      },
    });
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

  it("keeps the run-section tab strip tall enough to render clipped labels", () => {
    const css = readFileSync(join(process.cwd(), "src", "run-dashboard.css"), "utf8");

    expect(css).toMatch(/\n\.tabs\s*\{[\s\S]*min-height:\s*41px;[\s\S]*\}/);
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
      "task-runner:web:dashboard-preferences",
      JSON.stringify({
        collapseFailureStates: "yes",
        hideEmptyColumns: "no",
        showArchived: "sure",
        sortByRecentUpdates: "yes",
        visibleFocusIndicators: "sure",
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
    expect(screen.getByRole("checkbox", { name: "Sort by recent updates" })).not.toBeChecked();
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
    expect(window.localStorage.getItem("task-runner:web:dashboard-view-state")).toBe(
      JSON.stringify({
        collapsedColumnKeys: ["running"],
        drawerWidth: 540,
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
    expect(window.localStorage.getItem("task-runner:web:dashboard-view-state")).toBe(
      JSON.stringify({
        collapsedColumnKeys: [],
        drawerWidth: 540,
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
            workspacePath: "/tmp/b.md",
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
            workspacePath: "/tmp/b.md",
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

  it("shows Ready for initialized runs and promotes without opening the dialog", async () => {
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
              workspacePath: "/tmp/b.md",
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

    await user.click(readyButton);

    expect(screen.queryByRole("dialog", { name: "Resume run" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(readyRequested).toBe(true);
    });
  });

  it("starts selected ready runs with Enter without opening the resume dialog", async () => {
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
              workspacePath: "/tmp/keyboard-b.md",
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
              workspacePath: "/tmp/resume-b.md",
            },
            capabilities: {
              canArchive: true,
              canUnarchive: false,
              canReady: false,
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
            workspacePath: "/tmp/passive-enter-b.md",
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
            workspacePath: "/tmp/b.md",
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

    await user.type(await screen.findByLabelText("Message"), "Pick up the failing tests.");

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
            workspacePath: "/tmp/b.md",
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

  it("promotes an updated run to the top of its column in recent-updates mode", async () => {
    setStoredDashboardPreferences({ sortByRecentUpdates: true });
    const fetchMock = installFetchMock({
      runs: [
        makeRun({
          runId: "run-newer",
          assignmentName: "Newest run",
          name: "Newest run",
          startedAt: "2026-04-13T05:05:00.000Z",
        }),
        makeRun({
          runId: "run-older",
          assignmentName: "Older run",
          name: "Older run",
          startedAt: "2026-04-13T05:00:00.000Z",
        }),
      ],
      details: {
        "run-newer": makeDetail({
          runId: "run-newer",
          assignment: {
            name: "Newest run",
            sourcePath: "/tmp/newer.md",
            workspacePath: "/tmp/newer-workspace.md",
          },
          name: "Newest run",
          startedAt: "2026-04-13T05:05:00.000Z",
        }),
        "run-older": makeDetail({
          runId: "run-older",
          assignment: {
            name: "Older run",
            sourcePath: "/tmp/older.md",
            workspacePath: "/tmp/older-workspace.md",
          },
          name: "Older run",
          startedAt: "2026-04-13T05:00:00.000Z",
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
      }),
    });

    await waitFor(() => {
      expect(getColumnRunNames("Running")).toEqual(["Older run", "Newest run"]);
    });
    expect(await findRunCard("Older run")).toHaveAttribute("data-motion-kind", "reorder");
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore);
  });

  it("promotes a selected run into the top of its destination column from detail SSE", async () => {
    setStoredDashboardPreferences({ sortByRecentUpdates: true });
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-selected",
          assignmentName: "Selected run",
          name: "Selected run",
          startedAt: "2026-04-13T05:00:00.000Z",
        }),
        makeRun({
          runId: "run-complete",
          assignmentName: "Completed run",
          name: "Completed run",
          startedAt: "2026-04-13T05:04:00.000Z",
          status: "success",
        }),
      ],
      details: {
        "run-selected": makeDetail({
          runId: "run-selected",
          assignment: {
            name: "Selected run",
            sourcePath: "/tmp/selected.md",
            workspacePath: "/tmp/selected-workspace.md",
          },
          name: "Selected run",
          startedAt: "2026-04-13T05:00:00.000Z",
        }),
        "run-complete": makeDetail({
          runId: "run-complete",
          assignment: {
            name: "Completed run",
            sourcePath: "/tmp/completed.md",
            workspacePath: "/tmp/completed-workspace.md",
          },
          name: "Completed run",
          startedAt: "2026-04-13T05:04:00.000Z",
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
          workspacePath: "/tmp/selected-workspace.md",
        },
        name: "Selected run",
        startedAt: "2026-04-13T05:00:00.000Z",
        status: "success",
      }),
    });

    await waitFor(() => {
      expect(getColumnRunNames("Completed")).toEqual(["Selected run", "Completed run"]);
    });
  });

  it("marks brand-new runs as inserts and places them at the top in recent-updates mode", async () => {
    setStoredDashboardPreferences({ sortByRecentUpdates: true });
    installFetchMock({
      runs: [
        makeRun({
          runId: "run-existing",
          assignmentName: "Existing run",
          name: "Existing run",
          startedAt: "2026-04-13T05:05:00.000Z",
        }),
      ],
      details: {
        "run-existing": makeDetail({
          runId: "run-existing",
          assignment: {
            name: "Existing run",
            sourcePath: "/tmp/existing.md",
            workspacePath: "/tmp/existing-workspace.md",
          },
          name: "Existing run",
          startedAt: "2026-04-13T05:05:00.000Z",
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
      setStoredDashboardPreferences({ sortByRecentUpdates: true });
      installFetchMock({
        runs: [
          makeRun({
            runId: "run-newer",
            assignmentName: "Newest run",
            name: "Newest run",
            startedAt: "2026-04-13T05:05:00.000Z",
          }),
          makeRun({
            runId: "run-older",
            assignmentName: "Older run",
            name: "Older run",
            startedAt: "2026-04-13T05:00:00.000Z",
          }),
        ],
        details: {
          "run-newer": makeDetail({
            runId: "run-newer",
            assignment: {
              name: "Newest run",
              sourcePath: "/tmp/newer.md",
              workspacePath: "/tmp/newer-workspace.md",
            },
            name: "Newest run",
            startedAt: "2026-04-13T05:05:00.000Z",
          }),
          "run-older": makeDetail({
            runId: "run-older",
            assignment: {
              name: "Older run",
              sourcePath: "/tmp/older.md",
              workspacePath: "/tmp/older-workspace.md",
            },
            name: "Older run",
            startedAt: "2026-04-13T05:00:00.000Z",
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
    expect(
      await screen.findByRole("button", { name: /shared task/i, expanded: false }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Attachment preview")).not.toBeInTheDocument();

    await user.click(await findRunCard("Build dashboard"));
    expect(await screen.findByLabelText("Attachment preview")).toBeInTheDocument();
    expect(await screen.findByText("Markdown preview")).toBeInTheDocument();

    await user.click(getCloseDetailButton());
    await user.click(await findRunCard("Build dashboard"));
    expect(await screen.findByLabelText("Attachment preview")).toBeInTheDocument();
    expect(await screen.findByText("Markdown preview")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to attachments/i }));
    expect(await screen.findByRole("button", { name: /^Upload$/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Attachment preview")).not.toBeInTheDocument();
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
    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(4);
    });

    await user.click(getCloseDetailButton());
    await user.click(await findRunCard("Second run"));

    expect(await screen.findByLabelText("Run detail")).toBeInTheDocument();
    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(7);
    });
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
    await user.click(screen.getByRole("button", { name: /back to attachments/i }));

    await user.click(screen.getByRole("button", { name: /^Preview build\.log$/ }));
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

    await user.click(screen.getByRole("button", { name: "Close detail" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Attachment preview")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:png-preview"));
  });

  it("opens preview from attachment row metadata clicks and browser back returns to attachments", async () => {
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
    expect(router.state.location.pathname).toBe("/runs/run-1/attachments/run-1/att-log");

    window.history.back();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs/run-1");
      expect(screen.getByLabelText("Run detail")).toBeInTheDocument();
      expect(screen.queryByLabelText("Attachment preview")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^Upload$/ })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Expand drawer to full width" }));
    expect(screen.getByRole("button", { name: "Exit full-width drawer" })).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText("gamma body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next attachment" })).toBeDisabled();

    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByText("beta body")).toBeInTheDocument();
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

    await router.navigate({
      params: {
        attachmentId: "att-missing",
        attachmentOwnerRunId: "run-1",
        runId: "run-1",
      },
      to: "/runs/$runId/attachments/$attachmentOwnerRunId/$attachmentId",
    });

    expect(await screen.findByLabelText("Attachment preview error")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The selected attachment is no longer available in this run. Use Back to return to the attachments list.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to attachments/i })).toBeInTheDocument();
    expect(getCloseDetailButton()).toBeInTheDocument();
  });

  it("keeps preview errors inline and isolates row preview clicks from attachment actions", async () => {
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
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));

    await user.click(screen.getByRole("button", { name: /^Download report\.pdf$/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(screen.queryByLabelText("Attachment preview")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Remove notes\.md$/ }));
    expect(screen.getByRole("button", { name: /^Confirm remove notes\.md$/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Attachment preview")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Cancel remove notes\.md$/ }));
    expect(screen.queryByLabelText("Attachment preview")).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /^Preview report\.pdf$/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Preview notes\.md$/ }));
    expect(await screen.findByLabelText("Attachment preview")).toBeInTheDocument();
    expect(await screen.findByText("Attachment preview failed to load")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to attachments/i })).toBeInTheDocument();

    anchorClick.mockRestore();
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
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Confirm remove notes\.md$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Cancel remove notes\.md$/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Confirm remove notes\.md$/ }));
    await waitFor(() => expect(screen.getByText("No attachments yet.")).toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalled();

    anchorClick.mockRestore();
  });

  it("shows family attachments with a source run id and uses ownerRunId for cross-run preview/download", async () => {
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
          if (/\/api\/runs\/run-1\/attachments\?scope=family$/.test(url)) {
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
            return new Response("family attachment body", {
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
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));

    expect(screen.queryByRole("tab", { name: "Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Group" })).not.toBeInTheDocument();
    expect(screen.getByText("run-notes.md")).toBeInTheDocument();
    expect(await screen.findByText("peer-notes.md")).toBeInTheDocument();
    expect(screen.getByLabelText("Upload attachment file")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Remove peer-notes\.md$/ }),
    ).not.toBeInTheDocument();

    const peerRow = screen.getByText("peer-notes.md").closest("li");
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
    expect(await screen.findByText("family attachment body")).toBeInTheDocument();
    expect(screen.getByText("run-2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Download$/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(anchorClick).toHaveBeenCalledTimes(2);

    anchorClick.mockRestore();
  });

  it("switches to the source run when clicking a family attachment run id", async () => {
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
          if (/\/api\/runs\/run-1\/attachments\?scope=family$/.test(url)) {
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
    await user.click(await screen.findByRole("button", { name: /^Attachments\b/i }));
    expect(screen.getByText("peer-notes.md")).toBeInTheDocument();
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
