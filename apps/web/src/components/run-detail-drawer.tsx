import type { UseQueryResult } from "@tanstack/react-query";
import type {
  AttachmentListEntry,
  RunAttachment,
} from "@task-runner/core/contracts/attachments.js";
import type { RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatBytes, formatTimestamp, formatTimestampWithRelative } from "../lib/format.js";
import type { RunTimelineState } from "../lib/run-timeline.js";
import type { DrawerDetailSection } from "../lib/settings.js";
import { isEditableEventTarget } from "../lib/shortcuts.js";
import { useDrawerResize } from "../lib/use-drawer-resize.js";
import { useHorizontalWheelGuard } from "../lib/use-horizontal-wheel-guard.js";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import { isPreviewableAttachment } from "./attachment-preview-drawer.js";
import { DrawerResizeHandle } from "./drawer-resize-handle.js";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronIcon,
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

type TimelineTab = "message" | "prompt" | "output";
type AttemptSelection = number | "pending" | null;
type SummaryRow = readonly [label: string, value: string];

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
  rows.push(
    ["Attempts", `${run.attempts} / ${run.maxAttempts}`],
    ["Sessions", String(run.sessionCount)],
  );

  return rows;
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

function attemptOutput(attempt: {
  transcript: string;
  notices: string;
}) {
  if (!attempt.transcript || !attempt.notices) {
    return `${attempt.transcript}${attempt.notices}`;
  }

  let trailing = 0;
  for (let index = attempt.transcript.length - 1; index >= 0; index--) {
    if (attempt.transcript[index] !== "\n") {
      break;
    }
    trailing += 1;
  }

  let leading = 0;
  for (const character of attempt.notices) {
    if (character !== "\n") {
      break;
    }
    leading += 1;
  }

  const separator = "\n".repeat(Math.max(0, 2 - trailing - leading));
  return `${attempt.transcript}${separator}${attempt.notices}`;
}

function isScrolledToBottom(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= TIMELINE_BOTTOM_THRESHOLD_PX
  );
}

function scrollElementToBottom(element: HTMLElement) {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
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
  onCloseResumeDialog,
  onCopy,
  onDelete,
  groupAttachmentsQuery,
  onDownloadAttachment,
  onOpenResumeDialog,
  onOpenAttachmentPreview,
  onSelectRun,
  onClearBackendSession,
  onRemoveDependency,
  onRemoveAttachment,
  onReset,
  onRename,
  onResumeMessageDraftChange,
  onResumeMessageExpandedChange,
  onSetNote,
  onSetBackendSession,
  onSetPinned,
  onSelectSection,
  onSubmitResume,
  onTriggerPrimaryAction,
  timelineState,
  onUnarchive,
  onUploadAttachment,
  resumeDialogOpen,
  resumeMessageDraft,
  resumeMessageExpanded,
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
  onCloseResumeDialog: () => void;
  onCopy: (value: string, label: string) => void;
  onDelete: () => void;
  groupAttachmentsQuery: UseQueryResult<AttachmentListEntry[], Error>;
  onDownloadAttachment: (ownerRunId: string, attachmentId: string, name: string) => Promise<void>;
  onOpenResumeDialog: () => void;
  onOpenAttachmentPreview: (attachmentOwnerRunId: string, attachmentId: string) => void;
  onSelectRun: (runId: string) => void;
  onClearBackendSession: () => Promise<void>;
  onRemoveDependency: (dependencyRunId: string) => Promise<void>;
  onRemoveAttachment: (attachmentId: string) => Promise<void>;
  onReset: () => void;
  onRename: (name: string | null) => Promise<void>;
  onResumeMessageDraftChange: (value: string) => void;
  onResumeMessageExpandedChange: (expanded: boolean) => void;
  onSetNote: (note: string | null) => Promise<void>;
  onSetBackendSession: (backendSessionId: string) => Promise<void>;
  onSetPinned: (pinned: boolean) => Promise<void>;
  onSelectSection: (section: DrawerDetailSection) => void;
  onSubmitResume: () => Promise<void>;
  onTriggerPrimaryAction: () => Promise<void>;
  resumeDialogOpen: boolean;
  resumeMessageDraft: string;
  resumeMessageExpanded: boolean;
  timelineState: RunTimelineState;
  onUnarchive: () => void;
  onUploadAttachment: (file: File) => Promise<void>;
  run: RunDetail;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerBodyRef = useRef<HTMLDivElement | null>(null);
  const sectionTabsRef = useRef<HTMLElement | null>(null);
  const timelineContentScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineOutputAtBottomRef = useRef(false);
  const latestAttemptRef = useRef<number | null>(null);
  const [selectedAttempt, setSelectedAttempt] = useState<AttemptSelection>(null);
  const [timelineTab, setTimelineTab] = useState<TimelineTab>(
    run.status === "initialized" && run.attempts === 0 ? "message" : "output",
  );
  const [editingName, setEditingName] = useState(false);
  const [editingBackendSession, setEditingBackendSession] = useState(false);
  const [nameDraft, setNameDraft] = useState(run.name ?? "");
  const [backendSessionDraft, setBackendSessionDraft] = useState(run.backendSessionId ?? "");
  const [confirmingAttachmentId, setConfirmingAttachmentId] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dependencyDraft, setDependencyDraft] = useState("");
  const [selectedDependencyRunId, setSelectedDependencyRunId] = useState<string | null>(null);
  const resize = useDrawerResize();
  const { drawerStyle, isFullscreen, toggleFullscreen } = resize;
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const resumeDisclosureButtonRef = useRef<HTMLButtonElement | null>(null);
  const resumeMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const backendSessionInputRef = useRef<HTMLInputElement | null>(null);
  const backendSessionId = run.backendSessionId;
  const isPassiveRun = run.backend === "passive";
  const canEditBackendSession = isPassiveRun;
  const actionsLocked = actionPending !== undefined;
  const resumePending = actionPending === "resume";
  const trimmedResumeMessage = resumeMessageDraft.trim();
  const hasIncompleteTasks = run.tasks.some((task) => task.status !== "completed");
  const startableRun = run.capabilities.canResume && run.status === "initialized";
  const resumeRequiresMessage = !hasIncompleteTasks;
  const showResumeMessageField = resumeRequiresMessage || resumeMessageExpanded;
  const renamePending = actionPending === "rename";
  const notePending = actionPending === "note";
  const pinPending = actionPending === "pin";
  const backendSessionPending = actionPending === "backend-session";
  const resetPending = actionPending === "reset";
  const abortPending = actionPending === "abort";
  const uploadAttachmentPending = actionPending === "upload-attachment";
  const removeAttachmentPending = actionPending === "remove-attachment";
  const downloadAttachmentPending = actionPending === "download-attachment";
  const visibleName = run.name ?? "Unnamed";
  const canEditDependencies = run.status === "initialized";
  const addDependencyPending = actionPending === "add-dependency";
  const removeDependencyPending = actionPending === "remove-dependency";
  const clearDependenciesPending = actionPending === "clear-dependencies";
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
  const pendingAttemptAvailable =
    run.status === "initialized" && run.attempts === 0 && timelineAttempts.length === 0;
  const selectedAttemptRecord =
    (typeof selectedAttempt === "number"
      ? timelineAttempts.find((attempt) => attempt.attempt === selectedAttempt)
      : null) ??
    timelineAttempts[timelineAttempts.length - 1] ??
    null;
  const selectedPendingAttempt = pendingAttemptAvailable && selectedAttemptRecord === null;
  const effectiveTimelineTab =
    selectedPendingAttempt || timelineTab === "prompt" ? timelineTab : "output";
  const selectedAttemptNumber = selectedAttemptRecord?.attempt ?? null;
  const selectedAttemptOutput = selectedAttemptRecord ? attemptOutput(selectedAttemptRecord) : "";
  const selectedAttemptLive = selectedAttemptRecord?.live ?? false;

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
    if (!resumeDialogOpen) {
      return;
    }
    if (showResumeMessageField) {
      resumeMessageRef.current?.focus();
      return;
    }
    resumeDisclosureButtonRef.current?.focus();
  }, [resumeDialogOpen, showResumeMessageField]);

  useEffect(() => {
    const availableAttempts = new Set(timelineAttempts.map((attempt) => attempt.attempt));
    if (selectedAttempt === "pending") {
      if (pendingAttemptAvailable) {
        return;
      }
      setSelectedAttempt(timelineAttempts[timelineAttempts.length - 1]?.attempt ?? null);
      return;
    }
    if (selectedAttempt !== null && availableAttempts.has(selectedAttempt)) {
      return;
    }
    if (pendingAttemptAvailable) {
      setSelectedAttempt("pending");
      return;
    }
    setSelectedAttempt(timelineAttempts[timelineAttempts.length - 1]?.attempt ?? null);
  }, [pendingAttemptAvailable, selectedAttempt, timelineAttempts]);

  useEffect(() => {
    const latestAttempt = timelineAttempts[timelineAttempts.length - 1]?.attempt ?? null;
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
      setTimelineTab("output");
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

  // Seed the "at bottom" ref whenever the output tab is (re)activated for an
  // attempt, so the live-stream follow check reflects the user's actual
  // position instead of a defaulted value.
  useEffect(() => {
    if (
      activeSection !== "events" ||
      effectiveTimelineTab !== "output" ||
      selectedAttemptNumber === null
    ) {
      return;
    }
    const element = timelineContentScrollRef.current;
    if (element) {
      timelineOutputAtBottomRef.current = isScrolledToBottom(element);
    }
  }, [activeSection, effectiveTimelineTab, selectedAttemptNumber]);

  // While the selected attempt is live, whenever the transcript grows, keep
  // the scroll pinned to the bottom if the user was already at the bottom.
  // Do nothing on tab/attempt open — only react to actual deltas.
  useEffect(() => {
    if (
      activeSection !== "events" ||
      effectiveTimelineTab !== "output" ||
      selectedAttemptNumber === null
    ) {
      return;
    }
    if (!selectedAttemptLive) {
      return;
    }
    if (!selectedAttemptOutput) {
      return;
    }
    if (!timelineOutputAtBottomRef.current) {
      return;
    }
    const element = timelineContentScrollRef.current;
    if (!element) {
      return;
    }
    scrollElementToBottom(element);
  }, [
    activeSection,
    effectiveTimelineTab,
    selectedAttemptLive,
    selectedAttemptNumber,
    selectedAttemptOutput,
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
    if (!element || effectiveTimelineTab !== "output") {
      return;
    }
    timelineOutputAtBottomRef.current = isScrolledToBottom(element);
  }

  function handleResumeMessageKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseResumeDialog();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void onSubmitResume();
    }
  }

  function handleResumeDialogKeyDown(event: ReactKeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseResumeDialog();
    }
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
            {run.capabilities.canResume ? (
              <button
                className="btn"
                disabled={actionsLocked}
                onClick={() => void onTriggerPrimaryAction()}
                type="button"
              >
                {actionPending === "resume"
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
          </section>

          {actionError ? (
            <div className="notice" data-tone="error">
              <span className="notice__message">{actionError}</span>
            </div>
          ) : null}

          <nav aria-label="Run sections" className="tabs" ref={sectionTabsRef}>
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
            <button
              aria-selected={activeSection === "notes"}
              className={activeSection === "notes" ? "tab active" : "tab"}
              onClick={() => onSelectSection("notes")}
              type="button"
            >
              Notes
            </button>
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
                        ? "No run attachments yet. Loading group attachments..."
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
                    <h3>Group attachments failed to load</h3>
                    <p>{groupAttachmentsQuery.error.message}</p>
                  </div>
                ) : (
                  <div className="drawer-state">
                    <h3>No attachments yet</h3>
                    <p>No attachments are available for this run or its cwd group.</p>
                  </div>
                )}
                {combinedAttachments.length > 0 && groupAttachmentsQuery.isError ? (
                  <div className="drawer-state">
                    <h3>Group attachments failed to load</h3>
                    <p>{groupAttachmentsQuery.error.message}</p>
                  </div>
                ) : null}
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
                  <p className="muted-inline">Loading timeline history…</p>
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
                          <div
                            className="timeline-attempt-tabs"
                            role="tablist"
                            aria-label="Attempts"
                          >
                            {selectedPendingAttempt ? (
                              <button
                                aria-selected={true}
                                className="timeline-attempt-tab active"
                                onClick={() => setSelectedAttempt("pending")}
                                role="tab"
                                type="button"
                              >
                                <span>Pending</span>
                              </button>
                            ) : (
                              timelineAttempts.map((attempt) => (
                                <button
                                  aria-selected={selectedAttemptRecord?.attempt === attempt.attempt}
                                  className={
                                    selectedAttemptRecord?.attempt === attempt.attempt
                                      ? "timeline-attempt-tab active"
                                      : "timeline-attempt-tab"
                                  }
                                  key={attempt.attempt}
                                  onClick={() => setSelectedAttempt(attempt.attempt)}
                                  role="tab"
                                  type="button"
                                >
                                  <span>{attempt.attempt}</span>
                                  {attempt.live ? (
                                    <span aria-hidden="true" className="timeline-live-dot" />
                                  ) : null}
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      ) : null}

                      <div className="task-tabs" role="tablist" aria-label="Attempt view">
                        {selectedPendingAttempt ? (
                          <button
                            aria-selected={effectiveTimelineTab === "message"}
                            className={
                              effectiveTimelineTab === "message" ? "task-tab active" : "task-tab"
                            }
                            onClick={() => setTimelineTab("message")}
                            role="tab"
                            type="button"
                          >
                            Message
                          </button>
                        ) : null}
                        <button
                          aria-selected={effectiveTimelineTab === "prompt"}
                          className={
                            effectiveTimelineTab === "prompt" ? "task-tab active" : "task-tab"
                          }
                          onClick={() => setTimelineTab("prompt")}
                          role="tab"
                          type="button"
                        >
                          Prompt
                        </button>
                        <button
                          aria-selected={effectiveTimelineTab === "output"}
                          className={
                            effectiveTimelineTab === "output" ? "task-tab active" : "task-tab"
                          }
                          onClick={() => setTimelineTab("output")}
                          role="tab"
                          type="button"
                        >
                          Output
                        </button>
                      </div>
                    </div>

                    <div
                      className="timeline-content-scroll"
                      onScroll={handleTimelineContentScroll}
                      ref={timelineContentScrollRef}
                    >
                      {selectedPendingAttempt && effectiveTimelineTab === "message" ? (
                        run.message ? (
                          <section aria-label="Pending message">
                            <MarkdownContent className="timeline-content" text={run.message} />
                          </section>
                        ) : (
                          <p className="task-empty">No message was provided for this run.</p>
                        )
                      ) : effectiveTimelineTab === "prompt" ? (
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
                      ) : selectedPendingAttempt ? (
                        <p className="task-empty">No output yet — this run has not started.</p>
                      ) : selectedAttemptOutput ? (
                        <section aria-label="Attempt output">
                          <MarkdownContent
                            className="timeline-content"
                            text={selectedAttemptOutput}
                          />
                        </section>
                      ) : (
                        <p className="task-empty">
                          {selectedAttemptRecord?.live
                            ? "Waiting for live output…"
                            : "This attempt produced no transcript output."}
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
      {resumeDialogOpen ? (
        <dialog
          aria-labelledby="resume-run-dialog-title"
          className="resume-dialog-backdrop"
          onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCloseResumeDialog();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              onCloseResumeDialog();
            }
          }}
          onKeyDown={handleResumeDialogKeyDown}
          open
        >
          <div className="resume-dialog">
            <div className="resume-dialog__header">
              <h3 className="resume-dialog__title" id="resume-run-dialog-title">
                Resume run
              </h3>
              <p className="resume-dialog__copy">
                {resumeRequiresMessage
                  ? "Send a follow-up message describing what the run should do next."
                  : "Resume immediately or include an optional follow-up message."}
              </p>
            </div>
            {!resumeRequiresMessage ? (
              <div className="resume-dialog__disclosure">
                <button
                  aria-controls="resume-run-message-panel"
                  aria-expanded={resumeMessageExpanded}
                  className="resume-dialog__disclosure-toggle"
                  disabled={resumePending}
                  onClick={() => onResumeMessageExpandedChange(!resumeMessageExpanded)}
                  ref={resumeDisclosureButtonRef}
                  type="button"
                >
                  <span>Optional message</span>
                  <ChevronIcon
                    aria-hidden="true"
                    className={
                      resumeMessageExpanded
                        ? "resume-dialog__disclosure-icon expanded"
                        : "resume-dialog__disclosure-icon"
                    }
                  />
                </button>
              </div>
            ) : null}
            {showResumeMessageField ? (
              <div id="resume-run-message-panel">
                <label className="resume-dialog__field" htmlFor="resume-run-message">
                  {resumeRequiresMessage ? "Message" : "Optional message"}
                </label>
                <textarea
                  className="resume-dialog__textarea"
                  disabled={resumePending}
                  id="resume-run-message"
                  onChange={(event) => onResumeMessageDraftChange(event.target.value)}
                  onKeyDown={handleResumeMessageKeyDown}
                  placeholder="Describe the follow-up work for this resume..."
                  ref={resumeMessageRef}
                  rows={6}
                  value={resumeMessageDraft}
                />
              </div>
            ) : null}
            <div className="resume-dialog__actions">
              <button
                className="btn"
                disabled={resumePending}
                onClick={onCloseResumeDialog}
                type="button"
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={
                  resumePending || (resumeRequiresMessage && trimmedResumeMessage.length === 0)
                }
                onClick={() => void onSubmitResume()}
                type="button"
              >
                {resumePending ? "Resuming..." : "Send"}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
