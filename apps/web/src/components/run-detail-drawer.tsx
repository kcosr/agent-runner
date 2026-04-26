import type { UseQueryResult } from "@tanstack/react-query";
import type {
  AttachmentListEntry,
  RunAttachment,
} from "@task-runner/core/contracts/attachments.js";
import type { RunAuditEvent } from "@task-runner/core/contracts/events.js";
import type {
  RunDetail,
  RunSchedule,
  RunSessionSummary,
  RunSummary,
} from "@task-runner/core/contracts/runs.js";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReconfigureRunPatch } from "../lib/api-client.js";
import { type AuditMessagePart, formatAuditEvent } from "../lib/audit-formatter.js";
import {
  formatBytes,
  formatScheduleKind,
  formatScheduleMode,
  formatScheduleRecurrence,
  formatScheduleState,
  formatTimestamp,
  formatTimestampWithRelative,
} from "../lib/format.js";
import type { RunAuditState } from "../lib/run-audit.js";
import { getRunPrimaryAction } from "../lib/run-primary-action.js";
import type { RunTimelineState } from "../lib/run-timeline.js";
import { type DrawerDetailSection, useDashboardPreferences } from "../lib/settings.js";
import { isEditableEventTarget } from "../lib/shortcuts.js";
import { useDrawerResize } from "../lib/use-drawer-resize.js";
import { useHorizontalWheelGuard } from "../lib/use-horizontal-wheel-guard.js";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import { isPreviewableAttachment } from "./attachment-preview-drawer.js";
import { DrawerResizeHandle } from "./drawer-resize-handle.js";
import {
  ArchiveIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  CollapseIcon,
  CopyIcon,
  DownloadIcon,
  ExpandIcon,
  PencilIcon,
  PinIcon,
  StopIcon,
  TrashIcon,
} from "./icons.js";
import { MarkdownContent } from "./markdown.js";
import { RunNoteEditor } from "./run-note-editor.js";
import { RunTaskList } from "./run-task-list.js";
import { StatusBadge } from "./status-badge.js";

type TimelineTab = "message" | "prompt" | "response" | "diagnostics";
type AttemptSelection = number | "pending" | null;
type SummaryRow = readonly [label: string, value: string];
type DataTab = "vars" | "hookState";
type AuditFilter = "all" | "hooks" | "tasks" | "run";
interface RuntimeVarDraftRow {
  id: string;
  key: string;
  value: string;
  originalKey: string | null;
  originalValue: string;
  redacted: boolean;
  replaceRedacted: boolean;
}

const TIMELINE_BOTTOM_THRESHOLD_PX = 24;

function dependencyCandidateTitle(run: RunSummary) {
  return run.name ?? run.assignmentName ?? "Unnamed";
}

function dependencyCandidateMeta(run: RunSummary) {
  const parts: string[] = [];
  if (run.assignmentName && run.assignmentName !== run.name) {
    parts.push(run.assignmentName);
  }
  if (run.archivedAt) {
    parts.push("Archived");
  }
  parts.push(run.effectiveStatus, run.runId);
  return parts.join(" · ");
}

function dependencyCandidateLabel(run: RunSummary) {
  return `${dependencyCandidateTitle(run)} · ${dependencyCandidateMeta(run)}`;
}

function matchesDependencyCandidate(run: RunSummary, search: string) {
  if (!search) {
    return true;
  }
  const haystack = [
    run.runId,
    run.name,
    run.assignmentName,
    run.repo,
    run.backend,
    run.agentName,
    run.effectiveStatus,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function summaryRows(run: RunDetail) {
  const rows: SummaryRow[] = [
    ["Repo", run.repo],
    ["Assignment", run.assignment?.name ?? "Ad hoc"],
    ["Agent", run.agent.name],
    ["Backend", [run.backend, run.model, run.effort].filter(Boolean).join(" · ") || run.backend],
  ];

  if (run.effectiveStatus !== run.status) {
    rows.push(["Lifecycle status", run.status]);
  }

  rows.push(["Started", formatTimestampWithRelative(run.startedAt)]);
  if (run.endedAt !== null) {
    rows.push(["Ended", formatTimestampWithRelative(run.endedAt)]);
  }
  if (run.endedAt !== null && run.exitCode !== null) {
    rows.push(["Exit code", String(run.exitCode)]);
  }
  const lastSession = run.currentSession ?? run.lastSession;
  if (lastSession) {
    rows.push([
      "Sessions",
      `${run.totalSessionCount} (${lastSession.attemptCount}/${lastSession.maxAttemptsPerSession})`,
    ]);
  } else {
    rows.push(["Sessions", "none"]);
  }

  return rows;
}

function isStructuredDataValue(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function isRedactedRuntimeVarValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { redacted?: unknown }).redacted === true
  );
}

function formatScalarDataValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value) ?? String(value);
}

function editableRuntimeVarValue(value: unknown): string {
  if (isRedactedRuntimeVarValue(value)) {
    return "";
  }
  if (isStructuredDataValue(value)) {
    return JSON.stringify(value, null, 2);
  }
  return formatScalarDataValue(value);
}

function createRuntimeVarDraftRows(data: Record<string, unknown>): RuntimeVarDraftRow[] {
  return Object.entries(data).map(([key, value]) => {
    const redacted = isRedactedRuntimeVarValue(value);
    const originalValue = editableRuntimeVarValue(value);
    return {
      id: `existing:${key}`,
      key,
      value: originalValue,
      originalKey: key,
      originalValue,
      redacted,
      replaceRedacted: false,
    };
  });
}

function ReadOnlyDataEntries({
  data,
  emptyMessage,
  tableLabel,
}: {
  data: Record<string, unknown> | undefined;
  emptyMessage: string;
  tableLabel: string;
}) {
  const entries = Object.entries(data ?? {});
  if (entries.length === 0) {
    return <p className="task-empty">{emptyMessage}</p>;
  }

  return (
    <div className="drawer-data-table-wrap">
      <table aria-label={tableLabel} className="drawer-data-table">
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key}>
              <th scope="row">{key}</th>
              <td>
                {isStructuredDataValue(value) ? (
                  <div className="drawer-data-table__structured markdown task-markdown">
                    <pre>
                      <code>{JSON.stringify(value, null, 2)}</code>
                    </pre>
                  </div>
                ) : (
                  <span className="drawer-data-table__scalar mono">
                    {formatScalarDataValue(value)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryLongRow({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="meta-cell full">
      <span className="meta-label">{label}</span>
      <div className="meta-row">{children}</div>
    </div>
  );
}

function ScheduleDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="schedule-detail-row">
      <span className="meta-label">{label}</span>
      <span className="meta-value">{value}</span>
    </div>
  );
}

function scheduleRows(schedule: RunSchedule, state: RunDetail["scheduleState"]): SummaryRow[] {
  const rows: SummaryRow[] = [
    ["Status", schedule.enabled ? "Enabled" : "Paused"],
    ["Schedule state", formatScheduleState(state)],
    ["Next run", formatTimestampWithRelative(schedule.runAt)],
    ["Kind", formatScheduleKind(schedule)],
  ];

  if (schedule.recurrence !== null) {
    rows.push(
      ["Recurrence", formatScheduleRecurrence(schedule)],
      ["Cron", schedule.recurrence.schedule.expression],
      ["Timezone", schedule.recurrence.schedule.timezone],
      ["Mode", formatScheduleMode(schedule.recurrence.mode)],
      ["Continue on failure", schedule.recurrence.continueOnFailure ? "Yes" : "No"],
    );
  }

  return rows;
}

function isScrolledToBottom(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= TIMELINE_BOTTOM_THRESHOLD_PX
  );
}

function scrollElementToBottom(element: HTMLElement) {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
}

function renderAuditMessagePart(part: AuditMessagePart, key: string) {
  switch (part.type) {
    case "code":
      return (
        <code className="audit-message-code" key={key}>
          {part.text}
        </code>
      );
    case "task_status":
      return (
        <span className={taskStatusBadgeClass(part.status)} key={key}>
          {taskStatusBadgeLabel(part.status)}
        </span>
      );
    case "strong":
      return (
        <strong className="audit-message-strong" key={key}>
          {part.text}
        </strong>
      );
    case "status":
      return <StatusBadge key={key} status={part.status} />;
    case "text":
      return <span key={key}>{part.text}</span>;
    default:
      return null;
  }
}

function matchesAuditFilter(filter: AuditFilter, event: RunAuditEvent) {
  switch (filter) {
    case "all":
      return true;
    case "hooks":
      return event.type === "run.hook_recorded";
    case "tasks":
      return event.type.startsWith("task.");
    case "run":
      return event.type.startsWith("run.") && event.type !== "run.hook_recorded";
  }
}

function taskStatusBadgeLabel(status: "pending" | "in_progress" | "completed" | "blocked") {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "in progress";
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
  }
}

function taskStatusBadgeClass(status: "pending" | "in_progress" | "completed" | "blocked") {
  switch (status) {
    case "pending":
      return "badge badge-pending";
    case "in_progress":
      return "badge badge-running";
    case "completed":
      return "badge badge-completed";
    case "blocked":
      return "badge badge-blocked";
  }
}

interface AttachmentRowEntry {
  attachment: RunAttachment | AttachmentListEntry;
  ownerRunId: string;
  source: "run" | "group";
}

function InlineConfirmActions({
  cancelLabel,
  cancelTitle,
  confirmLabel,
  confirmTitle,
  disabled,
  onCancel,
  onConfirm,
}: {
  cancelLabel: string;
  cancelTitle: string;
  confirmLabel: string;
  confirmTitle: string;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="drawer-confirm-actions">
      <button
        aria-label={confirmLabel}
        className="icon-btn icon-btn--destructive"
        disabled={disabled}
        onClick={onConfirm}
        title={confirmTitle}
        type="button"
      >
        <CheckIcon aria-hidden="true" />
      </button>
      <button
        aria-label={cancelLabel}
        className="icon-btn"
        disabled={disabled}
        onClick={onCancel}
        title={cancelTitle}
        type="button"
      >
        <CloseIcon aria-hidden="true" />
      </button>
    </div>
  );
}

export function RunDetailDrawer({
  activeSection,
  dependencyCandidateRuns,
  onAddDependency,
  actionError,
  actionPending,
  onAbort,
  onArchive,
  onClearDependencies,
  onClose,
  onCopy,
  onDelete,
  groupAttachmentsQuery,
  onDownloadAttachment,
  onOpenAttachmentPreview,
  onSelectRun,
  onClearBackendSession,
  onRemoveDependency,
  onRemoveAttachment,
  onReset,
  onReconfigure,
  onRename,
  onSetNote,
  onSetBackendSession,
  onSetPinned,
  onClearSchedule,
  onSetScheduleEnabled,
  onSelectSection,
  onTriggerPrimaryAction,
  auditState,
  timelineState,
  onUnarchive,
  onUploadAttachment,
  resumeDialogOpen,
  run,
}: {
  activeSection: DrawerDetailSection;
  dependencyCandidateRuns: RunSummary[];
  onAddDependency: (dependencyRunId: string) => Promise<void>;
  actionError?: string;
  actionPending?: RunActionPending;
  onAbort: () => void;
  onArchive: () => void;
  onClearDependencies: () => Promise<void>;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
  onDelete: () => void;
  groupAttachmentsQuery: UseQueryResult<AttachmentListEntry[], Error>;
  onDownloadAttachment: (ownerRunId: string, attachmentId: string, name: string) => Promise<void>;
  onOpenAttachmentPreview: (attachmentOwnerRunId: string, attachmentId: string) => void;
  onSelectRun: (runId: string) => void;
  onClearBackendSession: () => Promise<void>;
  onRemoveDependency: (dependencyRunId: string) => Promise<void>;
  onRemoveAttachment: (attachmentId: string) => Promise<void>;
  onReset: () => void;
  onReconfigure: (patch: ReconfigureRunPatch) => Promise<void>;
  onRename: (name: string | null) => Promise<void>;
  onSetNote: (note: string | null) => Promise<void>;
  onSetBackendSession: (backendSessionId: string) => Promise<void>;
  onSetPinned: (pinned: boolean) => Promise<void>;
  onClearSchedule: () => Promise<void>;
  onSetScheduleEnabled: (enabled: boolean) => Promise<void>;
  onSelectSection: (section: DrawerDetailSection) => void;
  onTriggerPrimaryAction: () => Promise<void>;
  auditState: RunAuditState;
  resumeDialogOpen: boolean;
  timelineState: RunTimelineState;
  onUnarchive: () => void;
  onUploadAttachment: (file: File) => Promise<void>;
  run: RunDetail;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerBodyRef = useRef<HTMLDivElement | null>(null);
  const sectionTabsRef = useRef<HTMLElement | null>(null);
  const timelineContentScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineResponseAtBottomRef = useRef(false);
  const latestAttemptRef = useRef<number | null>(null);
  const [selectedAttempt, setSelectedAttempt] = useState<AttemptSelection>(null);
  const [dataTab, setDataTab] = useState<DataTab>("vars");
  const [auditFilter, setAuditFilter] = useState<AuditFilter>("all");
  const [timelineTab, setTimelineTab] = useState<TimelineTab>(
    (run.status === "initialized" || run.status === "ready") && run.totalAttemptCount === 0
      ? "message"
      : "response",
  );
  const [editingName, setEditingName] = useState(false);
  const [editingBackendSession, setEditingBackendSession] = useState(false);
  const [editingRuntimeVars, setEditingRuntimeVars] = useState(false);
  const [editingRunMessage, setEditingRunMessage] = useState(false);
  const [nameDraft, setNameDraft] = useState(run.name ?? "");
  const [backendSessionDraft, setBackendSessionDraft] = useState(run.backendSessionId ?? "");
  const [runtimeVarDraftRows, setRuntimeVarDraftRows] = useState<RuntimeVarDraftRow[]>([]);
  const [runtimeVarDraftError, setRuntimeVarDraftError] = useState<string | undefined>();
  const [runMessageDraft, setRunMessageDraft] = useState(run.message ?? "");
  const [confirmingAttachmentId, setConfirmingAttachmentId] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dependencyDraft, setDependencyDraft] = useState("");
  const [selectedDependencyRunId, setSelectedDependencyRunId] = useState<string | null>(null);
  const { preferences, updatePreferences } = useDashboardPreferences();
  const resize = useDrawerResize();
  const { drawerStyle, isFullscreen, toggleFullscreen } = resize;
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const backendSessionInputRef = useRef<HTMLInputElement | null>(null);
  const runtimeVarNewIdRef = useRef(0);
  const backendSessionId = run.backendSessionId;
  const isPassiveRun = run.backend === "passive";
  const canEditBackendSession = isPassiveRun;
  const canReconfigure = run.capabilities.canReconfigure;
  const actionsLocked = actionPending !== undefined;
  const primaryAction = getRunPrimaryAction(run);
  const resumePending = actionPending === "resume";
  const readyPending = actionPending === "ready";
  const startableRun = primaryAction === "start";
  const renamePending = actionPending === "rename";
  const notePending = actionPending === "note";
  const pinPending = actionPending === "pin";
  const backendSessionPending = actionPending === "backend-session";
  const reconfigurePending = actionPending === "reconfigure";
  const resetPending = actionPending === "reset";
  const abortPending = actionPending === "abort";
  const uploadAttachmentPending = actionPending === "upload-attachment";
  const removeAttachmentPending = actionPending === "remove-attachment";
  const downloadAttachmentPending = actionPending === "download-attachment";
  const auditEvents = auditState.history?.events ?? [];
  const filteredAuditEvents = auditEvents.filter((envelope) =>
    matchesAuditFilter(auditFilter, envelope.event),
  );
  const displayedAuditEvents = preferences.auditNewestFirst
    ? [...filteredAuditEvents].reverse()
    : filteredAuditEvents;
  const visibleName = run.name ?? "Unnamed";
  const canEditDependencies = run.status === "initialized" && run.archivedAt === null;
  const addDependencyPending = actionPending === "add-dependency";
  const removeDependencyPending = actionPending === "remove-dependency";
  const clearDependenciesPending = actionPending === "clear-dependencies";
  const schedulePending = actionPending === "schedule";
  const schedule = run.schedule;
  const canClearSchedule = schedule !== null;
  useHorizontalWheelGuard(drawerRef);
  useEffect(() => {
    if (!isFullscreen) {
      return;
    }
    drawerRef.current?.focus();
  }, [isFullscreen]);

  const satisfiedDependencies = run.dependencies.filter(
    (dependency) => dependency.satisfied,
  ).length;
  const totalAttachmentSize = run.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  const groupAttachments =
    groupAttachmentsQuery.data?.filter((attachment) => attachment.ownerRunId !== run.runId) ?? [];
  const groupAttachmentSize = groupAttachments.reduce(
    (sum, attachment) => sum + attachment.size,
    0,
  );
  const combinedAttachments: AttachmentRowEntry[] = [
    ...run.attachments.map((attachment) => ({
      attachment,
      ownerRunId: run.runId,
      source: "run" as const,
    })),
    ...groupAttachments.map((attachment) => ({
      attachment,
      ownerRunId: attachment.ownerRunId,
      source: "group" as const,
    })),
  ];
  const combinedAttachmentSize = totalAttachmentSize + groupAttachmentSize;
  const configuredDependencyIds = new Set(run.dependencies.map((dependency) => dependency.runId));
  const eligibleDependencyCandidates = dependencyCandidateRuns.filter(
    (candidate) => candidate.runId !== run.runId && !configuredDependencyIds.has(candidate.runId),
  );
  const normalizedDependencyDraft = dependencyDraft.trim();
  const matchingDependencyCandidates =
    normalizedDependencyDraft.length === 0
      ? []
      : eligibleDependencyCandidates
          .filter((candidate) => matchesDependencyCandidate(candidate, normalizedDependencyDraft))
          .slice(0, 8);
  const resolvedDependencyRunId =
    selectedDependencyRunId ??
    eligibleDependencyCandidates.find(
      (candidate) => candidate.runId.toLowerCase() === normalizedDependencyDraft.toLowerCase(),
    )?.runId;
  const timelineAttempts = timelineState.history?.attempts ?? [];
  const timelineSessions = Array.from(
    timelineAttempts.reduce((groups, attempt) => {
      const attempts = groups.get(attempt.sessionIndex) ?? [];
      attempts.push(attempt);
      groups.set(attempt.sessionIndex, attempts);
      return groups;
    }, new Map<number, typeof timelineAttempts>()),
    ([sessionIndex, attempts]) => ({
      sessionIndex,
      attempts: [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber),
      summary: run.sessions.find((session) => session.sessionIndex === sessionIndex) ?? null,
    }),
  ).sort((a, b) => a.sessionIndex - b.sessionIndex);
  const pendingAttemptAvailable =
    (run.status === "initialized" || run.status === "ready") &&
    run.totalAttemptCount === 0 &&
    timelineAttempts.length === 0;
  const selectedAttemptRecord =
    (typeof selectedAttempt === "number"
      ? timelineAttempts.find((attempt) => attempt.attemptNumber === selectedAttempt)
      : null) ??
    timelineAttempts[timelineAttempts.length - 1] ??
    null;
  const selectedPendingAttempt = pendingAttemptAvailable && selectedAttemptRecord === null;
  const selectedAttemptNumber = selectedAttemptRecord?.attemptNumber ?? null;
  const selectedAttemptResponse = selectedAttemptRecord?.transcript ?? "";
  const selectedAttemptDiagnostics = selectedAttemptRecord?.notices ?? "";
  const selectedAttemptLive = selectedAttemptRecord?.live ?? false;
  const selectedSessionIndex = selectedAttemptRecord?.sessionIndex ?? null;
  const selectedTimelineSession =
    selectedSessionIndex === null
      ? null
      : (timelineSessions.find((session) => session.sessionIndex === selectedSessionIndex) ?? null);
  const selectedSessionAttempts = selectedTimelineSession?.attempts ?? [];
  const editRunMessageButton = canReconfigure ? (
    <button
      aria-label="Edit run message"
      className="icon-btn icon-btn--small drawer-title-edit-trigger"
      disabled={actionsLocked}
      onClick={startRunMessageEdit}
      title="Edit run message"
      type="button"
    >
      <PencilIcon aria-hidden="true" />
    </button>
  ) : null;

  function startNameEdit() {
    if (actionsLocked) {
      return;
    }
    setNameDraft(run.name ?? "");
    setEditingName(true);
  }

  function cancelNameEdit() {
    if (renamePending) {
      return;
    }
    setNameDraft(run.name ?? "");
    setEditingName(false);
  }

  async function submitNameEdit() {
    if (renamePending) {
      return;
    }
    const trimmed = nameDraft.trim();
    const nextName = trimmed.length === 0 ? null : trimmed;
    if (nextName === run.name) {
      setEditingName(false);
      return;
    }
    try {
      await onRename(nextName);
      setEditingName(false);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function handleNameInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitNameEdit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelNameEdit();
    }
  }

  function startBackendSessionEdit() {
    if (actionsLocked || !canEditBackendSession) {
      return;
    }
    setBackendSessionDraft(run.backendSessionId ?? "");
    setEditingBackendSession(true);
  }

  function cancelBackendSessionEdit() {
    if (backendSessionPending) {
      return;
    }
    setBackendSessionDraft(run.backendSessionId ?? "");
    setEditingBackendSession(false);
  }

  async function submitBackendSessionEdit() {
    if (backendSessionPending) {
      return;
    }
    const trimmed = backendSessionDraft.trim();
    if (trimmed.length === 0 && run.backendSessionId === null) {
      setEditingBackendSession(false);
      return;
    }
    if (trimmed.length === 0) {
      await submitBackendSessionClear();
      return;
    }
    if (trimmed === run.backendSessionId) {
      setEditingBackendSession(false);
      return;
    }
    try {
      await onSetBackendSession(trimmed);
      setEditingBackendSession(false);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  async function submitBackendSessionClear() {
    if (backendSessionPending || run.backendSessionId === null) {
      return;
    }
    try {
      await onClearBackendSession();
      setEditingBackendSession(false);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function startRuntimeVarsEdit() {
    if (actionsLocked || !canReconfigure) {
      return;
    }
    setRuntimeVarDraftRows(createRuntimeVarDraftRows(run.runtimeVars));
    setRuntimeVarDraftError(undefined);
    setEditingRuntimeVars(true);
  }

  function cancelRuntimeVarsEdit() {
    if (reconfigurePending) {
      return;
    }
    setRuntimeVarDraftRows(createRuntimeVarDraftRows(run.runtimeVars));
    setRuntimeVarDraftError(undefined);
    setEditingRuntimeVars(false);
  }

  function addRuntimeVarDraftRow() {
    if (reconfigurePending) {
      return;
    }
    runtimeVarNewIdRef.current += 1;
    setRuntimeVarDraftRows((current) => [
      ...current,
      {
        id: `new:${runtimeVarNewIdRef.current}`,
        key: "",
        value: "",
        originalKey: null,
        originalValue: "",
        redacted: false,
        replaceRedacted: false,
      },
    ]);
  }

  function updateRuntimeVarDraftRow(
    rowId: string,
    update: Partial<Pick<RuntimeVarDraftRow, "key" | "replaceRedacted" | "value">>,
  ) {
    setRuntimeVarDraftRows((current) =>
      current.map((row) => (row.id === rowId ? { ...row, ...update } : row)),
    );
  }

  function removeRuntimeVarDraftRow(rowId: string) {
    if (reconfigurePending) {
      return;
    }
    setRuntimeVarDraftRows((current) => current.filter((row) => row.id !== rowId));
  }

  async function submitRuntimeVarsEdit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (reconfigurePending) {
      return;
    }
    const seenKeys = new Set<string>();
    const vars: Record<string, string> = {};
    for (const row of runtimeVarDraftRows) {
      const key = row.key.trim();
      if (row.originalKey === null && key.length === 0 && row.value.length === 0) {
        continue;
      }
      if (key.length === 0) {
        setRuntimeVarDraftError("Variable keys cannot be empty.");
        return;
      }
      if (seenKeys.has(key)) {
        setRuntimeVarDraftError(`Variable "${key}" is duplicated.`);
        return;
      }
      seenKeys.add(key);
      if (row.redacted) {
        if (row.replaceRedacted) {
          vars[key] = row.value;
        }
        continue;
      }
      if (row.originalKey === null || row.value !== row.originalValue) {
        vars[key] = row.value;
      }
    }
    setRuntimeVarDraftError(undefined);
    if (Object.keys(vars).length === 0) {
      setEditingRuntimeVars(false);
      return;
    }
    try {
      await onReconfigure({ vars });
      setEditingRuntimeVars(false);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function startRunMessageEdit() {
    if (actionsLocked || !canReconfigure) {
      return;
    }
    setRunMessageDraft(run.message ?? "");
    setEditingRunMessage(true);
  }

  function cancelRunMessageEdit() {
    if (reconfigurePending) {
      return;
    }
    setRunMessageDraft(run.message ?? "");
    setEditingRunMessage(false);
  }

  async function submitRunMessageEdit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (reconfigurePending) {
      return;
    }
    try {
      await onReconfigure({ message: runMessageDraft });
      setEditingRunMessage(false);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  async function submitScheduleEnabled(enabled: boolean) {
    if (schedulePending || run.schedule === null) {
      return;
    }
    try {
      await onSetScheduleEnabled(enabled);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  async function submitScheduleClear() {
    if (schedulePending || schedule === null) {
      return;
    }
    try {
      await onClearSchedule();
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function handleBackendSessionInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitBackendSessionEdit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelBackendSessionEdit();
    }
  }

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
    }
  }, [editingName]);

  useEffect(() => {
    if (editingBackendSession) {
      backendSessionInputRef.current?.focus();
    }
  }, [editingBackendSession]);

  useEffect(() => {
    if (!editingRunMessage) {
      setRunMessageDraft(run.message ?? "");
    }
  }, [editingRunMessage, run.message]);

  useEffect(() => {
    if (!canReconfigure) {
      setEditingRuntimeVars(false);
      setEditingRunMessage(false);
    }
  }, [canReconfigure]);

  useEffect(() => {
    const availableAttempts = new Set(timelineAttempts.map((attempt) => attempt.attemptNumber));
    if (selectedAttempt === "pending") {
      if (pendingAttemptAvailable) {
        return;
      }
      setSelectedAttempt(timelineAttempts[timelineAttempts.length - 1]?.attemptNumber ?? null);
      return;
    }
    if (selectedAttempt !== null && availableAttempts.has(selectedAttempt)) {
      return;
    }
    if (pendingAttemptAvailable) {
      setSelectedAttempt("pending");
      return;
    }
    setSelectedAttempt(timelineAttempts[timelineAttempts.length - 1]?.attemptNumber ?? null);
  }, [pendingAttemptAvailable, selectedAttempt, timelineAttempts]);

  useEffect(() => {
    const latestAttempt = timelineAttempts[timelineAttempts.length - 1]?.attemptNumber ?? null;
    if (activeSection !== "events") {
      latestAttemptRef.current = latestAttempt;
      return;
    }
    if (latestAttempt === null) {
      latestAttemptRef.current = null;
      return;
    }
    if (latestAttemptRef.current !== latestAttempt) {
      latestAttemptRef.current = latestAttempt;
      setSelectedAttempt(latestAttempt);
      setTimelineTab("response");
      return;
    }
    latestAttemptRef.current = latestAttempt;
  }, [activeSection, timelineAttempts]);

  useEffect(() => {
    if (
      confirmingAttachmentId !== null &&
      !run.attachments.some((attachment) => attachment.id === confirmingAttachmentId)
    ) {
      setConfirmingAttachmentId(null);
    }
  }, [confirmingAttachmentId, run.attachments]);

  useEffect(() => {
    if (!run.capabilities.canReset) {
      setConfirmingReset(false);
    }
  }, [run.capabilities.canReset]);

  useEffect(() => {
    if (!run.capabilities.canAbort) {
      setConfirmingAbort(false);
    }
  }, [run.capabilities.canAbort]);

  useEffect(() => {
    if (!run.capabilities.canDelete) {
      setConfirmingDelete(false);
    }
  }, [run.capabilities.canDelete]);

  useEffect(() => {
    if (isPassiveRun && activeSection === "events") {
      onSelectSection("tasks");
    }
  }, [activeSection, isPassiveRun, onSelectSection]);

  useEffect(() => {
    const drawer = drawerRef.current;
    const drawerBody = drawerBodyRef.current;
    const sectionTabs = sectionTabsRef.current;
    if (!drawer || !drawerBody || !sectionTabs) {
      return;
    }

    const updateVars = () => {
      drawer.style.setProperty("--drawer-body-height", `${drawerBody.clientHeight}px`);
      drawer.style.setProperty("--drawer-tabs-height", `${sectionTabs.offsetHeight}px`);
    };
    updateVars();

    const ResizeObserverCtor = window.ResizeObserver;
    const observer = ResizeObserverCtor !== undefined ? new ResizeObserver(updateVars) : null;
    observer?.observe(drawerBody);
    observer?.observe(sectionTabs);
    window.addEventListener("resize", updateVars);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateVars);
    };
  }, []);

  // Seed the "at bottom" ref whenever the response tab is (re)activated for an
  // attempt, so the live-stream follow check reflects the user's actual
  // position instead of a defaulted value.
  useEffect(() => {
    if (
      activeSection !== "events" ||
      timelineTab !== "response" ||
      selectedAttemptNumber === null
    ) {
      return;
    }
    const element = timelineContentScrollRef.current;
    if (element) {
      timelineResponseAtBottomRef.current = isScrolledToBottom(element);
    }
  }, [activeSection, timelineTab, selectedAttemptNumber]);

  // While the selected attempt is live, whenever the transcript grows, keep
  // the scroll pinned to the bottom if the user was already at the bottom.
  // Do nothing on tab/attempt open — only react to actual deltas.
  useEffect(() => {
    if (
      activeSection !== "events" ||
      timelineTab !== "response" ||
      selectedAttemptNumber === null
    ) {
      return;
    }
    if (!selectedAttemptLive) {
      return;
    }
    if (!selectedAttemptResponse) {
      return;
    }
    if (!timelineResponseAtBottomRef.current) {
      return;
    }
    const element = timelineContentScrollRef.current;
    if (!element) {
      return;
    }
    scrollElementToBottom(element);
  }, [
    activeSection,
    timelineTab,
    selectedAttemptLive,
    selectedAttemptNumber,
    selectedAttemptResponse,
  ]);

  async function submitDependencyAdd() {
    if (!resolvedDependencyRunId || addDependencyPending) {
      return;
    }
    try {
      await onAddDependency(resolvedDependencyRunId);
      setDependencyDraft("");
      setSelectedDependencyRunId(null);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function updateDependencyDraft(nextDraft: string) {
    setDependencyDraft(nextDraft);
    const exactRunId = eligibleDependencyCandidates.find(
      (candidate) => candidate.runId.toLowerCase() === nextDraft.trim().toLowerCase(),
    );
    setSelectedDependencyRunId(exactRunId?.runId ?? null);
  }

  function selectDependencyCandidate(candidate: RunSummary) {
    setDependencyDraft(dependencyCandidateLabel(candidate));
    setSelectedDependencyRunId(candidate.runId);
  }

  async function submitDependencyRemove(dependencyRunId: string) {
    if (removeDependencyPending) {
      return;
    }
    try {
      await onRemoveDependency(dependencyRunId);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  async function submitDependencyClear() {
    if (clearDependenciesPending) {
      return;
    }
    try {
      await onClearDependencies();
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  async function handleAttachmentInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || uploadAttachmentPending) {
      return;
    }
    try {
      await onUploadAttachment(file);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  async function submitAttachmentRemove(attachmentId: string) {
    if (removeAttachmentPending) {
      return;
    }
    try {
      await onRemoveAttachment(attachmentId);
      setConfirmingAttachmentId((current) => (current === attachmentId ? null : current));
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function renderAttachmentRows(entries: AttachmentRowEntry[]) {
    return (
      <ul aria-label="Attachment list" className="dependency-list">
        {entries.map(({ attachment, ownerRunId, source }) => {
          const previewable = isPreviewableAttachment(attachment);
          const rowClassName = previewable
            ? "dependency-row dependency-row--interactive"
            : "dependency-row";
          const allowRemove = source === "run";
          const attachmentCopy = (
            <span className="dependency-copy">
              <span className="attachment-title-row">
                <span className="dependency-name">{attachment.name}</span>
              </span>
              <span className="dependency-meta">
                <span className="dependency-meta-id attachment-row-mime">
                  {attachment.mimeType}
                </span>
                <span aria-hidden="true" className="attachment-row-mime">
                  ·
                </span>
                <span>{formatBytes(attachment.size)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatTimestamp(attachment.addedAt)}</span>
              </span>
            </span>
          );

          return (
            <li className={rowClassName} key={`${ownerRunId}:${attachment.id}`}>
              {previewable ? (
                <button
                  aria-label={`Preview ${attachment.name}`}
                  className="attachment-row-trigger"
                  onClick={() => onOpenAttachmentPreview(ownerRunId, attachment.id)}
                  type="button"
                >
                  {attachmentCopy}
                </button>
              ) : (
                attachmentCopy
              )}
              <div className="dependency-actions">
                {source === "group" ? (
                  <button
                    aria-label={`Open source run ${ownerRunId}`}
                    className="attachment-source-run run-id"
                    onClick={() => onSelectRun(ownerRunId)}
                    title={`Open ${ownerRunId}`}
                    type="button"
                  >
                    {ownerRunId}
                  </button>
                ) : null}
                <button
                  aria-label={`Download ${attachment.name}`}
                  className="icon-btn"
                  disabled={actionsLocked}
                  onClick={() =>
                    void onDownloadAttachment(ownerRunId, attachment.id, attachment.name)
                  }
                  title={downloadAttachmentPending ? "Downloading..." : "Download"}
                  type="button"
                >
                  <DownloadIcon aria-hidden="true" />
                </button>
                {allowRemove ? (
                  confirmingAttachmentId === attachment.id ? (
                    <>
                      <button
                        aria-label={`Confirm remove ${attachment.name}`}
                        className="icon-btn icon-btn--destructive"
                        disabled={actionsLocked}
                        onClick={() => void submitAttachmentRemove(attachment.id)}
                        title={removeAttachmentPending ? "Removing..." : "Confirm remove"}
                        type="button"
                      >
                        <CheckIcon aria-hidden="true" />
                      </button>
                      <button
                        aria-label={`Cancel remove ${attachment.name}`}
                        className="icon-btn"
                        disabled={actionsLocked}
                        onClick={() => setConfirmingAttachmentId(null)}
                        title="Cancel remove"
                        type="button"
                      >
                        <CloseIcon aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <button
                      aria-label={`Remove ${attachment.name}`}
                      className="icon-btn icon-btn--destructive"
                      disabled={actionsLocked}
                      onClick={() => setConfirmingAttachmentId(attachment.id)}
                      title="Remove"
                      type="button"
                    >
                      <TrashIcon aria-hidden="true" />
                    </button>
                  )
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  function handleTimelineContentScroll() {
    const element = timelineContentScrollRef.current;
    if (!element || timelineTab !== "response") {
      return;
    }
    timelineResponseAtBottomRef.current = isScrolledToBottom(element);
  }

  function handleDrawerKeyDownCapture(event: ReactKeyboardEvent<HTMLElement>) {
    if (
      !isFullscreen ||
      resumeDialogOpen ||
      event.defaultPrevented ||
      isEditableEventTarget(event.target)
    ) {
      return;
    }
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    toggleFullscreen();
  }

  return (
    <>
      <button
        aria-label="Close detail sheet"
        className="drawer-sheet-backdrop"
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label="Run detail"
        className={isFullscreen ? "drawer drawer--fullscreen" : "drawer"}
        onKeyDownCapture={handleDrawerKeyDownCapture}
        ref={drawerRef}
        style={drawerStyle}
        tabIndex={-1}
      >
        <DrawerResizeHandle label="Resize detail drawer" resize={resize} />
        <header className="drawer-head">
          <div className="drawer-title">
            <span className="run-id-large">{run.runId}</span>
            <StatusBadge status={run.effectiveStatus} />
          </div>
          <div className="drawer-actions">
            {run.capabilities.canArchive ? (
              <button className="btn" disabled={actionsLocked} onClick={onArchive} type="button">
                <ArchiveIcon aria-hidden="true" />
                {actionPending === "archive" ? "Archiving..." : "Archive"}
              </button>
            ) : null}
            {run.capabilities.canUnarchive ? (
              <button className="btn" disabled={actionsLocked} onClick={onUnarchive} type="button">
                <ArchiveIcon aria-hidden="true" />
                {actionPending === "unarchive" ? "Restoring..." : "Unarchive"}
              </button>
            ) : null}
            {primaryAction !== null ? (
              <button
                className="btn"
                disabled={actionsLocked}
                onClick={() => void onTriggerPrimaryAction()}
                type="button"
              >
                {primaryAction === "ready"
                  ? readyPending
                    ? "Readying..."
                    : "Ready"
                  : actionPending === "resume"
                    ? startableRun
                      ? "Starting..."
                      : "Resuming..."
                    : startableRun
                      ? "Start"
                      : "Resume"}
              </button>
            ) : null}
            {run.capabilities.canReset ? (
              confirmingReset ? (
                <InlineConfirmActions
                  cancelLabel="Cancel reset run"
                  cancelTitle={resetPending ? "Reset is pending..." : "Cancel reset run"}
                  confirmLabel="Confirm reset run"
                  confirmTitle={resetPending ? "Resetting run..." : "Confirm reset run"}
                  disabled={actionsLocked}
                  onCancel={() => setConfirmingReset(false)}
                  onConfirm={() => {
                    setConfirmingReset(false);
                    onReset();
                  }}
                />
              ) : (
                <button
                  className="btn"
                  disabled={actionsLocked}
                  onClick={() => setConfirmingReset(true)}
                  type="button"
                >
                  {resetPending ? "Resetting..." : "Reset"}
                </button>
              )
            ) : null}
            {run.capabilities.canAbort ? (
              confirmingAbort ? (
                <InlineConfirmActions
                  cancelLabel="Cancel abort run"
                  cancelTitle={abortPending ? "Abort is pending..." : "Cancel abort run"}
                  confirmLabel="Confirm abort run"
                  confirmTitle={abortPending ? "Aborting run..." : "Confirm abort run"}
                  disabled={actionsLocked}
                  onCancel={() => setConfirmingAbort(false)}
                  onConfirm={onAbort}
                />
              ) : (
                <button
                  className="btn btn-destructive-outline"
                  disabled={actionsLocked}
                  onClick={() => setConfirmingAbort(true)}
                  type="button"
                >
                  <StopIcon aria-hidden="true" />
                  Abort
                </button>
              )
            ) : null}
            {run.capabilities.canDelete ? (
              confirmingDelete ? (
                <InlineConfirmActions
                  cancelLabel="Cancel delete run"
                  cancelTitle={
                    actionPending === "delete" ? "Delete is pending..." : "Cancel delete run"
                  }
                  confirmLabel="Confirm delete run"
                  confirmTitle={
                    actionPending === "delete" ? "Deleting run..." : "Confirm delete run"
                  }
                  disabled={actionsLocked}
                  onCancel={() => setConfirmingDelete(false)}
                  onConfirm={onDelete}
                />
              ) : (
                <button
                  className="btn btn-destructive-outline"
                  disabled={actionsLocked}
                  onClick={() => setConfirmingDelete(true)}
                  type="button"
                >
                  <TrashIcon aria-hidden="true" />
                  Delete
                </button>
              )
            ) : null}
            <button
              aria-label={run.pinned ? "Unpin run" : "Pin run"}
              aria-pressed={run.pinned}
              className="icon-btn"
              disabled={pinPending}
              onClick={() => void onSetPinned(!run.pinned)}
              title={run.pinned ? "Unpin run" : "Pin run"}
              type="button"
            >
              <PinIcon aria-hidden="true" />
            </button>
            <button
              aria-label="Copy run id"
              className="icon-btn"
              onClick={() => onCopy(run.runId, "run id")}
              title="Copy run id"
              type="button"
            >
              <CopyIcon aria-hidden="true" />
            </button>
            <button
              aria-label={isFullscreen ? "Exit full-width drawer" : "Expand drawer to full width"}
              aria-pressed={isFullscreen}
              className="icon-btn drawer-fullscreen-toggle"
              onClick={toggleFullscreen}
              title={isFullscreen ? "Restore drawer width" : "Expand to full width"}
              type="button"
            >
              {isFullscreen ? (
                <CollapseIcon aria-hidden="true" />
              ) : (
                <ExpandIcon aria-hidden="true" />
              )}
            </button>
            <button aria-label="Close detail" className="icon-btn" onClick={onClose} type="button">
              <CloseIcon aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="drawer-body" ref={drawerBodyRef}>
          <div className="drawer-title-block">
            {editingName ? (
              <div className="drawer-title-edit">
                <label className="field drawer-title-field">
                  <input
                    aria-label="Run name"
                    disabled={renamePending}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={handleNameInputKeyDown}
                    placeholder="Unnamed"
                    ref={nameInputRef}
                    value={nameDraft}
                  />
                </label>
                <button
                  className="btn"
                  disabled={renamePending}
                  onClick={() => void submitNameEdit()}
                  type="button"
                >
                  {renamePending ? "Saving..." : "Save"}
                </button>
                <button
                  className="btn"
                  disabled={renamePending}
                  onClick={cancelNameEdit}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="drawer-title-inline">
                <h3 className="drawer-section-title">{visibleName}</h3>
                <button
                  aria-label="Edit run name"
                  className="icon-btn icon-btn--small drawer-title-edit-trigger"
                  disabled={actionsLocked}
                  onClick={startNameEdit}
                  title="Edit run name"
                  type="button"
                >
                  <PencilIcon aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
          <section aria-label="Run summary" className="meta-grid">
            {summaryRows(run).map(([label, value]) => (
              <div className="meta-cell" key={label}>
                <span className="meta-label">{label}</span>
                <span className="meta-value">{value}</span>
              </div>
            ))}
            <SummaryLongRow label="CWD">
              <span className="meta-value meta-value--truncate mono" title={run.cwd}>
                {run.cwd}
              </span>
              <div className="meta-actions">
                <button
                  aria-label="Copy cwd path"
                  className="copy"
                  onClick={() => onCopy(run.cwd, "cwd path")}
                  type="button"
                >
                  <CopyIcon aria-hidden="true" />
                </button>
              </div>
            </SummaryLongRow>
            <SummaryLongRow label="Workspace">
              <span className="meta-value meta-value--truncate mono" title={run.workspaceDir}>
                {run.workspaceDir}
              </span>
              <div className="meta-actions">
                <button
                  aria-label="Copy workspace path"
                  className="copy"
                  onClick={() => onCopy(run.workspaceDir, "workspace path")}
                  type="button"
                >
                  <CopyIcon aria-hidden="true" />
                </button>
              </div>
            </SummaryLongRow>
            {isPassiveRun || backendSessionId ? (
              <SummaryLongRow label="Backend session">
                {editingBackendSession ? (
                  <div className="drawer-title-edit meta-edit-row">
                    <label className="field drawer-title-field">
                      <input
                        aria-label="Backend session"
                        disabled={backendSessionPending}
                        onChange={(event) => setBackendSessionDraft(event.target.value)}
                        onKeyDown={handleBackendSessionInputKeyDown}
                        placeholder="Not set"
                        ref={backendSessionInputRef}
                        value={backendSessionDraft}
                      />
                    </label>
                    <button
                      className="btn"
                      disabled={backendSessionPending}
                      onClick={() => void submitBackendSessionEdit()}
                      type="button"
                    >
                      {backendSessionPending ? "Saving..." : "Save"}
                    </button>
                    {run.backendSessionId !== null ? (
                      <button
                        className="btn"
                        disabled={backendSessionPending}
                        onClick={() => void submitBackendSessionClear()}
                        type="button"
                      >
                        {backendSessionPending ? "Clearing..." : "Clear"}
                      </button>
                    ) : null}
                    <button
                      className="btn"
                      disabled={backendSessionPending}
                      onClick={cancelBackendSessionEdit}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <span
                      className="meta-value meta-value--truncate mono"
                      title={backendSessionId ?? undefined}
                    >
                      {backendSessionId ?? "Not set"}
                    </span>
                    <div className="meta-actions">
                      {backendSessionId ? (
                        <button
                          aria-label="Copy backend session id"
                          className="copy"
                          onClick={() => onCopy(backendSessionId, "backend session id")}
                          type="button"
                        >
                          <CopyIcon aria-hidden="true" />
                        </button>
                      ) : null}
                      {canEditBackendSession ? (
                        <button
                          aria-label="Edit backend session"
                          className="icon-btn icon-btn--small drawer-title-edit-trigger"
                          disabled={actionsLocked}
                          onClick={startBackendSessionEdit}
                          title="Edit backend session"
                          type="button"
                        >
                          <PencilIcon aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </SummaryLongRow>
            ) : null}
            {run.parentRunId ? (
              <SummaryLongRow label="Parent run">
                <button
                  aria-label={`Open parent run ${run.parentRunId}`}
                  className="attachment-source-run run-id"
                  onClick={() => onSelectRun(run.parentRunId as string)}
                  type="button"
                >
                  {run.parentRunId}
                </button>
                <div className="meta-actions">
                  <button
                    aria-label="Copy parent run id"
                    className="copy"
                    onClick={() => onCopy(run.parentRunId as string, "parent run id")}
                    type="button"
                  >
                    <CopyIcon aria-hidden="true" />
                  </button>
                </div>
              </SummaryLongRow>
            ) : null}
          </section>

          {schedule !== null ? (
            <section aria-label="Schedule" className="schedule-detail">
              <div className="schedule-detail__header">
                <div className="schedule-detail__title">
                  <ClockIcon aria-hidden="true" />
                  <span>Schedule</span>
                </div>
                <div className="schedule-detail__actions">
                  <button
                    className="btn"
                    disabled={actionsLocked}
                    onClick={() => void submitScheduleEnabled(!schedule.enabled)}
                    type="button"
                  >
                    {schedulePending ? "Saving..." : schedule.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    aria-disabled={!canClearSchedule || actionsLocked}
                    className="btn"
                    disabled={!canClearSchedule || actionsLocked}
                    onClick={() => void submitScheduleClear()}
                    title="Clear schedule"
                    type="button"
                  >
                    {schedulePending ? "Clearing..." : "Clear"}
                  </button>
                </div>
              </div>
              <div className="schedule-detail__grid">
                {scheduleRows(schedule, run.scheduleState).map(([label, value]) => (
                  <ScheduleDetailRow key={label} label={label} value={value} />
                ))}
              </div>
            </section>
          ) : null}

          {actionError ? (
            <div className="notice" data-tone="error">
              <span className="notice__message">{actionError}</span>
            </div>
          ) : null}

          <nav aria-label="Run sections" className="tabs tabs--scrollable" ref={sectionTabsRef}>
            <button
              aria-selected={activeSection === "tasks"}
              className={activeSection === "tasks" ? "tab active" : "tab"}
              onClick={() => onSelectSection("tasks")}
              type="button"
            >
              Tasks
              {run.tasksTotal > 0 ? (
                <span className="tab-count">
                  {" "}
                  {run.tasksCompleted}/{run.tasksTotal}
                </span>
              ) : null}
            </button>
            {isPassiveRun ? null : (
              <button
                aria-selected={activeSection === "events"}
                className={activeSection === "events" ? "tab active" : "tab"}
                onClick={() => onSelectSection("events")}
                type="button"
              >
                Attempts
              </button>
            )}
            <button
              aria-selected={activeSection === "attachments"}
              className={activeSection === "attachments" ? "tab active" : "tab"}
              onClick={() => onSelectSection("attachments")}
              type="button"
            >
              Attachments
              {combinedAttachments.length > 0 ? (
                <span className="tab-count"> {combinedAttachments.length}</span>
              ) : null}
            </button>
            <button
              aria-selected={activeSection === "data"}
              className={activeSection === "data" ? "tab active" : "tab"}
              onClick={() => onSelectSection("data")}
              type="button"
            >
              Data
            </button>
            <button
              aria-selected={activeSection === "audit"}
              className={activeSection === "audit" ? "tab active" : "tab"}
              onClick={() => onSelectSection("audit")}
              type="button"
            >
              Audit
              {auditEvents.length > 0 ? (
                <span className="tab-count"> {auditEvents.length}</span>
              ) : null}
            </button>
            <button
              aria-selected={activeSection === "dependencies"}
              className={activeSection === "dependencies" ? "tab active" : "tab"}
              onClick={() => onSelectSection("dependencies")}
              type="button"
            >
              Dependencies
              {run.dependencies.length > 0 ? (
                <span className="tab-count">
                  {" "}
                  {satisfiedDependencies}/{run.dependencies.length}
                </span>
              ) : null}
            </button>
            <button
              aria-selected={activeSection === "notes"}
              className={activeSection === "notes" ? "tab active" : "tab"}
              onClick={() => onSelectSection("notes")}
              type="button"
            >
              Notes
            </button>
          </nav>

          {activeSection === "tasks" ? (
            <section aria-label="Tasks" className="drawer-panel drawer-panel--tasks">
              <RunTaskList tasks={run.tasks} />
            </section>
          ) : null}

          {activeSection === "notes" ? (
            <section aria-label="Notes" className="drawer-panel drawer-panel--notes">
              <div className="drawer-panel-card drawer-panel-card--notes">
                <RunNoteEditor
                  emptyPreviewMessage="No note recorded yet."
                  initialMode="preview"
                  note={run.note}
                  onSave={onSetNote}
                  pending={notePending}
                  textareaLabel={`Run note for ${visibleName}`}
                />
              </div>
            </section>
          ) : null}

          {activeSection === "attachments" ? (
            <section aria-label="Attachments" className="drawer-panel drawer-panel--attachments">
              <div className="drawer-panel-card dependency-panel">
                <div className="dependency-summary">
                  <span>
                    {combinedAttachments.length === 0
                      ? groupAttachmentsQuery.isPending
                        ? "No run attachments yet. Loading family attachments..."
                        : "No attachments yet."
                      : `${combinedAttachments.length} attachment${combinedAttachments.length === 1 ? "" : "s"} · ${formatBytes(combinedAttachmentSize)}`}
                  </span>
                  <>
                    <input
                      aria-label="Upload attachment file"
                      className="sr-only"
                      onChange={handleAttachmentInputChange}
                      ref={attachmentInputRef}
                      type="file"
                    />
                    <button
                      className="btn"
                      disabled={actionsLocked}
                      onClick={() => attachmentInputRef.current?.click()}
                      type="button"
                    >
                      {uploadAttachmentPending ? "Uploading..." : "Upload"}
                    </button>
                  </>
                </div>

                {combinedAttachments.length > 0 ? (
                  renderAttachmentRows(combinedAttachments)
                ) : groupAttachmentsQuery.isPending ? (
                  <div className="drawer-state">
                    <div className="skeleton-line skeleton-line--short" />
                    <div
                      className="skeleton-line skeleton-line--medium"
                      style={{ marginTop: "12px" }}
                    />
                    <div
                      className="skeleton-line skeleton-line--medium"
                      style={{ marginTop: "12px" }}
                    />
                  </div>
                ) : groupAttachmentsQuery.isError ? (
                  <div className="drawer-state">
                    <h3>Family attachments failed to load</h3>
                    <p>{groupAttachmentsQuery.error.message}</p>
                  </div>
                ) : (
                  <div className="drawer-state">
                    <h3>No attachments yet</h3>
                    <p>No attachments are available for this run or its lineage family.</p>
                  </div>
                )}
                {combinedAttachments.length > 0 && groupAttachmentsQuery.isError ? (
                  <div className="drawer-state">
                    <h3>Family attachments failed to load</h3>
                    <p>{groupAttachmentsQuery.error.message}</p>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeSection === "audit" ? (
            <section aria-label="Audit" className="drawer-panel drawer-panel--audit">
              <div className="drawer-panel-card timeline-panel">
                {auditState.stale ? (
                  <div className="notice" data-tone="warning">
                    <span className="notice__message">
                      Audit sync is stale. Reload to resync the persisted history and live stream.
                    </span>
                  </div>
                ) : null}

                {auditState.error && auditEvents.length === 0 ? (
                  <div className="drawer-state">
                    <h3>Audit history failed to load</h3>
                    <p>{auditState.error}</p>
                    <button className="btn" onClick={auditState.reload} type="button">
                      Reload audit history
                    </button>
                  </div>
                ) : null}

                {auditState.isLoading && auditEvents.length === 0 ? (
                  <p className="muted-inline">Loading audit history…</p>
                ) : null}

                {!auditState.isLoading && auditEvents.length === 0 && !auditState.error ? (
                  <div className="drawer-state">
                    <h3>No audit events yet</h3>
                    <p>No persisted audit history is available for this run.</p>
                    {auditState.stale ? (
                      <button className="btn" onClick={auditState.reload} type="button">
                        Reconnect and reload
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {auditEvents.length > 0 ? (
                  <div className="dependency-section">
                    <div className="dependency-summary">
                      <span>
                        {displayedAuditEvents.length} audit event
                        {displayedAuditEvents.length === 1 ? "" : "s"}
                      </span>
                      <div className="dependency-actions">
                        <div className="task-tabs" aria-label="Audit event filter" role="tablist">
                          {(
                            [
                              ["all", "All"],
                              ["hooks", "Hooks"],
                              ["tasks", "Tasks"],
                              ["run", "Run"],
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              aria-selected={auditFilter === value}
                              className={auditFilter === value ? "task-tab active" : "task-tab"}
                              key={value}
                              onClick={() => setAuditFilter(value)}
                              role="tab"
                              type="button"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <button
                          aria-pressed={preferences.auditNewestFirst}
                          className={
                            preferences.auditNewestFirst
                              ? "btn btn--quiet active"
                              : "btn btn--quiet"
                          }
                          onClick={() =>
                            updatePreferences({
                              auditNewestFirst: !preferences.auditNewestFirst,
                            })
                          }
                          type="button"
                        >
                          {preferences.auditNewestFirst ? "Newest first" : "Oldest first"}
                        </button>
                        <button className="btn" onClick={auditState.reload} type="button">
                          Reload
                        </button>
                      </div>
                    </div>
                    {auditState.error ? <p className="muted-inline">{auditState.error}</p> : null}
                    {displayedAuditEvents.length > 0 ? (
                      <ul aria-label="Audit events" className="dependency-list">
                        {displayedAuditEvents.map((envelope) => {
                          const formatted = formatAuditEvent(envelope.event, {
                            resolvedHooks: run.resolvedHooks,
                            tasks: run.tasks,
                          });
                          return (
                            <li className="dependency-row" key={envelope.cursor}>
                              <div className="dependency-copy">
                                <span className="dependency-name">
                                  {formatted.message.map((part, index) =>
                                    renderAuditMessagePart(part, `${envelope.cursor}-${index}`),
                                  )}
                                </span>
                                <span className="dependency-meta">
                                  <span className="dependency-meta-id mono">
                                    {formatTimestamp(envelope.event.recordedAt)}
                                  </span>
                                  <span className="dependency-meta-id mono">
                                    #{envelope.cursor}
                                  </span>
                                  <span className="dependency-meta-id mono">
                                    {envelope.event.source}
                                  </span>
                                </span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="drawer-state">
                        <h3>No audit events match this filter</h3>
                        <p>
                          Change the audit filter to view the other persisted events for this run.
                        </p>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeSection === "data" ? (
            <section aria-label="Data" className="drawer-panel drawer-panel--data">
              <div className="drawer-panel-card dependency-panel">
                <div className="task-tabs" role="tablist" aria-label="Data view">
                  <button
                    aria-selected={dataTab === "vars"}
                    className={dataTab === "vars" ? "task-tab active" : "task-tab"}
                    onClick={() => setDataTab("vars")}
                    role="tab"
                    type="button"
                  >
                    Vars
                  </button>
                  <button
                    aria-selected={dataTab === "hookState"}
                    className={dataTab === "hookState" ? "task-tab active" : "task-tab"}
                    onClick={() => setDataTab("hookState")}
                    role="tab"
                    type="button"
                  >
                    Hook state
                  </button>
                </div>

                {dataTab === "vars" ? (
                  <>
                    <div className="drawer-data-actions">
                      <span className="muted-inline">
                        {Object.keys(run.runtimeVars).length === 0
                          ? "0 vars"
                          : `${Object.keys(run.runtimeVars).length} vars`}
                      </span>
                      {canReconfigure && !editingRuntimeVars ? (
                        <button
                          aria-label="Edit run vars"
                          className="icon-btn icon-btn--small drawer-title-edit-trigger"
                          disabled={actionsLocked}
                          onClick={startRuntimeVarsEdit}
                          title="Edit run vars"
                          type="button"
                        >
                          <PencilIcon aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                    {editingRuntimeVars ? (
                      <form className="reconfigure-form" onSubmit={submitRuntimeVarsEdit}>
                        <div className="runtime-var-editor-list">
                          {runtimeVarDraftRows.map((row) => (
                            <div className="runtime-var-editor-row" key={row.id}>
                              {row.originalKey === null ? (
                                <label className="field runtime-var-key-field">
                                  <span>Key</span>
                                  <input
                                    disabled={reconfigurePending}
                                    onChange={(event) =>
                                      updateRuntimeVarDraftRow(row.id, {
                                        key: event.target.value,
                                      })
                                    }
                                    placeholder="name"
                                    value={row.key}
                                  />
                                </label>
                              ) : (
                                <div className="runtime-var-key-readonly">
                                  <span className="meta-label">Key</span>
                                  <code>{row.key}</code>
                                </div>
                              )}
                              <label className="field runtime-var-value-field">
                                <span>Value</span>
                                <textarea
                                  aria-label={`Value for ${row.key || "new variable"}`}
                                  disabled={
                                    reconfigurePending || (row.redacted && !row.replaceRedacted)
                                  }
                                  onChange={(event) =>
                                    updateRuntimeVarDraftRow(row.id, {
                                      value: event.target.value,
                                    })
                                  }
                                  placeholder={row.redacted ? "Redacted" : "Value"}
                                  value={row.value}
                                />
                              </label>
                              {row.redacted ? (
                                <label className="runtime-var-redacted-toggle">
                                  <input
                                    checked={row.replaceRedacted}
                                    disabled={reconfigurePending}
                                    onChange={(event) =>
                                      updateRuntimeVarDraftRow(row.id, {
                                        replaceRedacted: event.target.checked,
                                      })
                                    }
                                    type="checkbox"
                                  />
                                  <span>Replace redacted value</span>
                                </label>
                              ) : null}
                              {row.originalKey === null ? (
                                <button
                                  aria-label="Remove new var"
                                  className="icon-btn icon-btn--destructive runtime-var-remove"
                                  disabled={reconfigurePending}
                                  onClick={() => removeRuntimeVarDraftRow(row.id)}
                                  title="Remove new var"
                                  type="button"
                                >
                                  <TrashIcon aria-hidden="true" />
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                        {runtimeVarDraftError ? (
                          <div className="notice" data-tone="error">
                            <span className="notice__message">{runtimeVarDraftError}</span>
                          </div>
                        ) : null}
                        <div className="drawer-confirm-actions">
                          <button
                            className="btn"
                            disabled={reconfigurePending}
                            onClick={addRuntimeVarDraftRow}
                            type="button"
                          >
                            Add var
                          </button>
                          <button className="btn" disabled={reconfigurePending} type="submit">
                            {reconfigurePending ? "Saving..." : "Save vars"}
                          </button>
                          <button
                            className="btn"
                            disabled={reconfigurePending}
                            onClick={cancelRuntimeVarsEdit}
                            type="button"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <ReadOnlyDataEntries
                        data={run.runtimeVars}
                        emptyMessage="No vars"
                        tableLabel="Vars"
                      />
                    )}
                  </>
                ) : (
                  <ReadOnlyDataEntries
                    data={run.hookState}
                    emptyMessage="No hook state"
                    tableLabel="Hook state"
                  />
                )}
              </div>
            </section>
          ) : null}

          {activeSection === "dependencies" ? (
            <section aria-label="Dependencies" className="drawer-panel drawer-panel--dependencies">
              <div className="drawer-panel-card dependency-panel">
                <div className="dependency-summary">
                  <span>
                    {run.dependencies.length === 0
                      ? "No dependencies configured."
                      : `${satisfiedDependencies}/${run.dependencies.length} dependencies satisfied.`}
                  </span>
                  {canEditDependencies && run.dependencies.length > 0 ? (
                    <button
                      className="btn btn-destructive-outline"
                      disabled={actionsLocked}
                      onClick={() => void submitDependencyClear()}
                      type="button"
                    >
                      {clearDependenciesPending ? "Clearing..." : "Clear all"}
                    </button>
                  ) : null}
                </div>

                {canEditDependencies ? (
                  <div className="dependency-add-stack">
                    <div className="dependency-add-row">
                      <label className="field dependency-field">
                        <input
                          aria-label="Dependency run search"
                          disabled={actionsLocked}
                          onChange={(event) => updateDependencyDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void submitDependencyAdd();
                            }
                          }}
                          placeholder="Search by name, assignment, or run id"
                          value={dependencyDraft}
                        />
                      </label>
                      <button
                        className="btn"
                        disabled={actionsLocked || !resolvedDependencyRunId}
                        onClick={() => void submitDependencyAdd()}
                        type="button"
                      >
                        {addDependencyPending ? "Adding..." : "Add dependency"}
                      </button>
                    </div>
                    {normalizedDependencyDraft.length > 0 ? (
                      matchingDependencyCandidates.length > 0 ? (
                        <ul
                          aria-label="Dependency suggestions"
                          className="dependency-suggestion-list"
                        >
                          {matchingDependencyCandidates.map((candidate) => (
                            <li key={candidate.runId}>
                              <button
                                aria-pressed={candidate.runId === resolvedDependencyRunId}
                                className={
                                  candidate.runId === resolvedDependencyRunId
                                    ? "dependency-suggestion active"
                                    : "dependency-suggestion"
                                }
                                disabled={actionsLocked}
                                onClick={() => selectDependencyCandidate(candidate)}
                                type="button"
                              >
                                <span className="dependency-suggestion-title">
                                  {dependencyCandidateTitle(candidate)}
                                </span>
                                <span className="dependency-suggestion-meta">
                                  {dependencyCandidateMeta(candidate)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted-inline">
                          No matching runs. Search by name, assignment, or run id.
                        </p>
                      )
                    ) : null}
                  </div>
                ) : null}

                {run.dependencies.length > 0 ? (
                  <div className="dependency-section">
                    <h4 className="dependency-section-title">
                      Depends on{" "}
                      <span className="dependency-section-title__count">
                        {run.dependencies.length}
                      </span>
                    </h4>
                    <ul className="dependency-list">
                      {run.dependencies.map((dependency) => (
                        <li className="dependency-row" key={dependency.runId}>
                          <div className="dependency-copy">
                            <span className="dependency-name">{dependency.name ?? "Unnamed"}</span>
                            <span className="dependency-meta">
                              <span className="dependency-meta-id">{dependency.runId}</span>
                              {dependency.missing || !dependency.effectiveStatus ? (
                                <span className="badge badge-error">missing</span>
                              ) : (
                                <StatusBadge status={dependency.effectiveStatus} />
                              )}
                            </span>
                          </div>
                          {canEditDependencies ? (
                            <button
                              aria-label={`Remove dependency ${dependency.runId}`}
                              className="icon-btn icon-btn--destructive"
                              disabled={actionsLocked}
                              onClick={() => void submitDependencyRemove(dependency.runId)}
                              title={removeDependencyPending ? "Removing..." : "Remove"}
                              type="button"
                            >
                              <TrashIcon aria-hidden="true" />
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {run.dependents.length > 0 ? (
                  <div className="dependency-section">
                    <h4 className="dependency-section-title">
                      Required by{" "}
                      <span className="dependency-section-title__count">
                        {run.dependents.length}
                      </span>
                    </h4>
                    <ul className="dependency-list">
                      {run.dependents.map((dependent) => (
                        <li className="dependency-row" key={dependent.runId}>
                          <div className="dependency-copy">
                            <span className="dependency-name">{dependent.name ?? "Unnamed"}</span>
                            <span className="dependency-meta">
                              <span className="dependency-meta-id">{dependent.runId}</span>
                              {dependent.missing || !dependent.effectiveStatus ? (
                                <span className="badge badge-error">missing</span>
                              ) : (
                                <StatusBadge status={dependent.effectiveStatus} />
                              )}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeSection === "events" ? (
            <section aria-label="Attempts" className="drawer-panel drawer-panel--events">
              <div className="drawer-panel-card timeline-panel">
                {timelineState.stale ? (
                  <div className="notice" data-tone="warning">
                    <span className="notice__message">
                      Timeline sync is stale. The drawer is waiting for a clean reload.
                    </span>
                  </div>
                ) : null}

                {timelineState.error && !selectedAttemptRecord ? (
                  <p className="muted-inline">{timelineState.error}</p>
                ) : null}

                {timelineState.isLoading && timelineAttempts.length === 0 ? (
                  <p className="muted-inline">Loading attempt history…</p>
                ) : null}

                {!timelineState.isLoading &&
                timelineAttempts.length === 0 &&
                !selectedPendingAttempt ? (
                  <p className="muted-inline">No attempt history is available for this run yet.</p>
                ) : null}

                {selectedAttemptRecord || selectedPendingAttempt ? (
                  <div className="timeline-attempt-panel">
                    <div className="timeline-sticky-controls">
                      {selectedPendingAttempt || timelineAttempts.length > 1 ? (
                        <div className="timeline-attempts">
                          {selectedPendingAttempt ? (
                            <div className="timeline-attempt-row">
                              <span className="timeline-attempt-row__label">Attempts</span>
                              <div
                                className="timeline-attempt-tabs"
                                role="tablist"
                                aria-label="Attempts"
                              >
                                <button
                                  aria-selected={true}
                                  className="timeline-attempt-tab active"
                                  onClick={() => setSelectedAttempt("pending")}
                                  role="tab"
                                  type="button"
                                >
                                  <span>Pending</span>
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {timelineSessions.length > 1 ? (
                                <div className="timeline-attempt-row">
                                  <span className="timeline-attempt-row__label">Sessions</span>
                                  <div
                                    className="timeline-attempt-tabs"
                                    role="tablist"
                                    aria-label="Sessions"
                                  >
                                    {timelineSessions.map((session) => {
                                      const sessionNumber = session.sessionIndex + 1;
                                      const sessionLatestAttempt =
                                        session.attempts[session.attempts.length - 1] ?? null;
                                      return (
                                        <button
                                          aria-label={`Session ${sessionNumber}`}
                                          aria-selected={
                                            selectedSessionIndex === session.sessionIndex
                                          }
                                          className={
                                            selectedSessionIndex === session.sessionIndex
                                              ? "timeline-attempt-tab active"
                                              : "timeline-attempt-tab"
                                          }
                                          key={session.sessionIndex}
                                          onClick={() => {
                                            if (sessionLatestAttempt) {
                                              setSelectedAttempt(
                                                sessionLatestAttempt.attemptNumber,
                                              );
                                            }
                                          }}
                                          role="tab"
                                          type="button"
                                        >
                                          <span>{sessionNumber}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : null}

                              {selectedSessionAttempts.length > 1 ? (
                                <div className="timeline-attempt-row">
                                  <span className="timeline-attempt-row__label">Attempts</span>
                                  <div
                                    className="timeline-attempt-tabs"
                                    role="tablist"
                                    aria-label="Attempts"
                                  >
                                    {selectedSessionAttempts.map((attempt) => {
                                      const sessionNumber = attempt.sessionIndex + 1;
                                      const attemptNumber = attempt.attemptIndexInSession + 1;
                                      const label = `Session ${sessionNumber} attempt ${attemptNumber}, run attempt ${attempt.attemptNumber}${
                                        attempt.live ? ", live" : ""
                                      }`;
                                      return (
                                        <button
                                          aria-label={label}
                                          aria-selected={
                                            selectedAttemptRecord?.attemptNumber ===
                                            attempt.attemptNumber
                                          }
                                          className={
                                            selectedAttemptRecord?.attemptNumber ===
                                            attempt.attemptNumber
                                              ? "timeline-attempt-tab active"
                                              : "timeline-attempt-tab"
                                          }
                                          key={attempt.attemptNumber}
                                          onClick={() => setSelectedAttempt(attempt.attemptNumber)}
                                          role="tab"
                                          title={label}
                                          type="button"
                                        >
                                          <span>{attemptNumber}</span>
                                          {attempt.live ? (
                                            <span
                                              aria-hidden="true"
                                              className="timeline-live-dot"
                                            />
                                          ) : null}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      ) : null}

                      <div className="task-tabs" role="tablist" aria-label="Attempt view">
                        <button
                          aria-selected={timelineTab === "message"}
                          className={timelineTab === "message" ? "task-tab active" : "task-tab"}
                          onClick={() => setTimelineTab("message")}
                          role="tab"
                          type="button"
                        >
                          Message
                        </button>
                        <button
                          aria-selected={timelineTab === "prompt"}
                          className={timelineTab === "prompt" ? "task-tab active" : "task-tab"}
                          onClick={() => setTimelineTab("prompt")}
                          role="tab"
                          type="button"
                        >
                          Prompt
                        </button>
                        <button
                          aria-selected={timelineTab === "response"}
                          className={timelineTab === "response" ? "task-tab active" : "task-tab"}
                          onClick={() => setTimelineTab("response")}
                          role="tab"
                          type="button"
                        >
                          Response
                        </button>
                        <button
                          aria-selected={timelineTab === "diagnostics"}
                          className={timelineTab === "diagnostics" ? "task-tab active" : "task-tab"}
                          onClick={() => setTimelineTab("diagnostics")}
                          role="tab"
                          type="button"
                        >
                          Diagnostics
                        </button>
                      </div>
                    </div>

                    <div
                      className="timeline-content-scroll"
                      onScroll={handleTimelineContentScroll}
                      ref={timelineContentScrollRef}
                    >
                      {timelineTab === "message" ? (
                        editingRunMessage ? (
                          <form
                            className="reconfigure-form reconfigure-form--message"
                            onSubmit={submitRunMessageEdit}
                          >
                            <label className="resume-dialog__field" htmlFor="run-message-edit">
                              Message
                            </label>
                            <textarea
                              className="resume-dialog__textarea"
                              disabled={reconfigurePending}
                              id="run-message-edit"
                              onChange={(event) => setRunMessageDraft(event.target.value)}
                              value={runMessageDraft}
                            />
                            <div className="drawer-confirm-actions">
                              <button className="btn" disabled={reconfigurePending} type="submit">
                                {reconfigurePending ? "Saving..." : "Save message"}
                              </button>
                              <button
                                className="btn"
                                disabled={reconfigurePending}
                                onClick={cancelRunMessageEdit}
                                type="button"
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        ) : (
                          <section aria-label="Run message">
                            <div className="timeline-section-actions">{editRunMessageButton}</div>
                            {run.message ? (
                              <MarkdownContent className="timeline-content" text={run.message} />
                            ) : (
                              <p className="task-empty">No message was provided for this run.</p>
                            )}
                          </section>
                        )
                      ) : timelineTab === "prompt" ? (
                        selectedPendingAttempt ? (
                          run.pendingPrompt ? (
                            <section aria-label="Pending prompt">
                              <MarkdownContent
                                className="timeline-content"
                                text={run.pendingPrompt}
                              />
                            </section>
                          ) : (
                            <p className="task-empty">
                              No prompt preview is available for this run yet.
                            </p>
                          )
                        ) : selectedAttemptRecord?.prompt ? (
                          <section aria-label="Attempt prompt">
                            <MarkdownContent
                              className="timeline-content"
                              text={selectedAttemptRecord.prompt}
                            />
                          </section>
                        ) : (
                          <p className="task-empty">This attempt did not record a prompt.</p>
                        )
                      ) : timelineTab === "response" ? (
                        selectedPendingAttempt ? (
                          <p className="task-empty">No response yet — this run has not started.</p>
                        ) : selectedAttemptResponse ? (
                          <section aria-label="Attempt response">
                            <MarkdownContent
                              className="timeline-content"
                              text={selectedAttemptResponse}
                            />
                          </section>
                        ) : (
                          <p className="task-empty">
                            {selectedAttemptRecord?.live
                              ? "Waiting for live response text…"
                              : "This attempt produced no transcript response."}
                          </p>
                        )
                      ) : selectedPendingAttempt ? (
                        <p className="task-empty">No diagnostics yet — this run has not started.</p>
                      ) : selectedAttemptDiagnostics ? (
                        <section aria-label="Attempt diagnostics">
                          <MarkdownContent
                            className="timeline-content"
                            text={selectedAttemptDiagnostics}
                          />
                        </section>
                      ) : (
                        <p className="task-empty">
                          {selectedAttemptRecord?.live
                            ? "No diagnostics have arrived yet."
                            : "This attempt produced no diagnostics."}
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </aside>
    </>
  );
}
