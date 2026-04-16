import type { RunAttachment } from "@task-runner/core/contracts/attachments.js";
import type { RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  formatBytes,
  formatRelativeTimestamp,
  formatTimestamp,
  truncateMiddle,
} from "../lib/format.js";
import type { RunTimelineState } from "../lib/run-timeline.js";
import type { DrawerDetailSection } from "../lib/settings.js";
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
  StopIcon,
  TrashIcon,
} from "./icons.js";
import { MarkdownContent } from "./markdown.js";
import { RunTaskList } from "./run-task-list.js";
import { StatusBadge } from "./status-badge.js";

type TimelineTab = "prompt" | "output";

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
  const rows = [
    ["Repo", run.repo],
    ["Assignment", run.assignment?.name ?? "Ad hoc"],
    ["Agent", run.agent.name],
    ["Backend", [run.backend, run.model, run.effort].filter(Boolean).join(" · ") || run.backend],
    ["Started", `${formatTimestamp(run.startedAt)} ${formatRelativeTimestamp(run.startedAt)}`],
    ["Attempts", `${run.attempts} / ${run.maxAttempts}`],
    ["Sessions", String(run.sessionCount)],
  ] as const;

  if (run.effectiveStatus !== run.status) {
    return [...rows.slice(0, 4), ["Lifecycle status", run.status], ...rows.slice(4)] as const;
  }

  return rows;
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
  onDownloadAttachment,
  onOpenAttachmentPreview,
  onRemoveDependency,
  onRemoveAttachment,
  onReset,
  onRename,
  onResume,
  onSelectSection,
  timelineState,
  onUnarchive,
  onUploadAttachment,
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
  onDownloadAttachment: (attachmentId: string, name: string) => Promise<void>;
  onOpenAttachmentPreview: (attachmentId: string) => void;
  onRemoveDependency: (dependencyRunId: string) => Promise<void>;
  onRemoveAttachment: (attachmentId: string) => Promise<void>;
  onReset: () => void;
  onRename: (name: string | null) => Promise<void>;
  onResume: (message?: string) => Promise<void>;
  onSelectSection: (section: DrawerDetailSection) => void;
  timelineState: RunTimelineState;
  onUnarchive: () => void;
  onUploadAttachment: (file: File) => Promise<void>;
  run: RunDetail;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerBodyRef = useRef<HTMLDivElement | null>(null);
  const sectionTabsRef = useRef<HTMLElement | null>(null);
  const timelineContentScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineOutputAtBottomRef = useRef(true);
  const [selectedAttempt, setSelectedAttempt] = useState<number | null>(null);
  const [timelineTab, setTimelineTab] = useState<TimelineTab>("output");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(run.name ?? "");
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [resumeMessageExpanded, setResumeMessageExpanded] = useState(false);
  const [resumeMessageDraft, setResumeMessageDraft] = useState("");
  const [confirmingAttachmentId, setConfirmingAttachmentId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dependencyDraft, setDependencyDraft] = useState("");
  const [selectedDependencyRunId, setSelectedDependencyRunId] = useState<string | null>(null);
  const [timelineOutputAtBottom, setTimelineOutputAtBottom] = useState(true);
  const resize = useDrawerResize();
  const { drawerStyle, isFullscreen, toggleFullscreen } = resize;
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const resumeDisclosureButtonRef = useRef<HTMLButtonElement | null>(null);
  const resumeMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const backendSessionId = run.backendSessionId;
  const isPassiveRun = run.backend === "passive";
  const actionsLocked = actionPending !== undefined;
  const resumePending = actionPending === "resume";
  const trimmedResumeMessage = resumeMessageDraft.trim();
  const hasIncompleteTasks = run.tasks.some((task) => task.status !== "completed");
  const startableRun = run.capabilities.canResume && run.status === "initialized";
  const resumeRequiresMessage = !hasIncompleteTasks;
  const showResumeMessageField = resumeRequiresMessage || resumeMessageExpanded;
  const renamePending = actionPending === "rename";
  const resetPending = actionPending === "reset";
  const uploadAttachmentPending = actionPending === "upload-attachment";
  const removeAttachmentPending = actionPending === "remove-attachment";
  const downloadAttachmentPending = actionPending === "download-attachment";
  const visibleName = run.name ?? "Unnamed";
  const canEditDependencies = run.status === "initialized";
  const addDependencyPending = actionPending === "add-dependency";
  const removeDependencyPending = actionPending === "remove-dependency";
  const clearDependenciesPending = actionPending === "clear-dependencies";
  useHorizontalWheelGuard(drawerRef);
  const satisfiedDependencies = run.dependencies.filter(
    (dependency) => dependency.satisfied,
  ).length;
  const totalAttachmentSize = run.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
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
  const selectedAttemptRecord =
    timelineAttempts.find((attempt) => attempt.attempt === selectedAttempt) ??
    timelineAttempts[timelineAttempts.length - 1] ??
    null;
  const selectedAttemptNumber = selectedAttemptRecord?.attempt ?? null;
  const selectedAttemptOutput = selectedAttemptRecord ? attemptOutput(selectedAttemptRecord) : "";

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

  function handleNameInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
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

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
    }
  }, [editingName]);

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
    if (selectedAttempt !== null && availableAttempts.has(selectedAttempt)) {
      return;
    }
    setSelectedAttempt(timelineAttempts[timelineAttempts.length - 1]?.attempt ?? null);
  }, [selectedAttempt, timelineAttempts]);

  useEffect(() => {
    if (
      confirmingAttachmentId !== null &&
      !run.attachments.some((attachment) => attachment.id === confirmingAttachmentId)
    ) {
      setConfirmingAttachmentId(null);
    }
  }, [confirmingAttachmentId, run.attachments]);

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
    timelineOutputAtBottomRef.current = timelineOutputAtBottom;
  }, [timelineOutputAtBottom]);

  useEffect(() => {
    if (activeSection !== "events" || timelineTab !== "output" || selectedAttemptNumber === null) {
      return;
    }
    setTimelineOutputAtBottom(true);
  }, [activeSection, selectedAttemptNumber, timelineTab]);

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

  useEffect(() => {
    if (activeSection !== "events" || timelineTab !== "output" || selectedAttemptNumber === null) {
      return;
    }
    const element = timelineContentScrollRef.current;
    if (!element) {
      return;
    }

    let frameId = 0;
    const followTail = () => {
      frameId = 0;
      const target = timelineContentScrollRef.current;
      if (!target || !timelineOutputAtBottomRef.current) {
        return;
      }
      scrollElementToBottom(target);
    };
    const scheduleFollowTail = () => {
      if (frameId !== 0) {
        return;
      }
      frameId = requestAnimationFrame(followTail);
    };

    scheduleFollowTail();

    const ResizeObserverCtor = window.ResizeObserver;
    const observer =
      ResizeObserverCtor !== undefined ? new ResizeObserver(() => scheduleFollowTail()) : null;
    if (observer) {
      observer.observe(element);
      for (const child of Array.from(element.children)) {
        observer.observe(child);
      }
    }

    return () => {
      if (frameId !== 0) {
        cancelAnimationFrame(frameId);
      }
      observer?.disconnect();
    };
  }, [activeSection, selectedAttemptNumber, timelineTab]);

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

  async function submitAttachmentDownload(attachment: RunAttachment) {
    if (downloadAttachmentPending) {
      return;
    }
    try {
      await onDownloadAttachment(attachment.id, attachment.name);
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

  function handleTimelineContentScroll() {
    const element = timelineContentScrollRef.current;
    if (!element || timelineTab !== "output") {
      return;
    }
    setTimelineOutputAtBottom(isScrolledToBottom(element));
  }

  async function startRun() {
    if (actionsLocked) {
      return;
    }
    try {
      await onResume();
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function openResumeDialog() {
    if (actionsLocked) {
      return;
    }
    setResumeMessageExpanded(resumeRequiresMessage);
    setResumeDialogOpen(true);
  }

  function closeResumeDialog() {
    if (resumePending) {
      return;
    }
    setResumeDialogOpen(false);
    setResumeMessageExpanded(false);
    setResumeMessageDraft("");
  }

  async function submitResume() {
    if (resumePending || (resumeRequiresMessage && trimmedResumeMessage.length === 0)) {
      return;
    }
    try {
      await onResume(trimmedResumeMessage.length > 0 ? trimmedResumeMessage : undefined);
      setResumeDialogOpen(false);
      setResumeMessageExpanded(false);
      setResumeMessageDraft("");
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function handleResumeMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeResumeDialog();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void submitResume();
    }
  }

  function handleResumeDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeResumeDialog();
    }
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
        ref={drawerRef}
        style={drawerStyle}
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
                onClick={startableRun ? () => void startRun() : openResumeDialog}
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
              <button className="btn" disabled={actionsLocked} onClick={onReset} type="button">
                {resetPending ? "Resetting..." : "Reset"}
              </button>
            ) : null}
            {run.capabilities.canAbort ? (
              <button
                className="btn btn-destructive-outline"
                disabled={actionsLocked}
                onClick={onAbort}
                type="button"
              >
                <StopIcon aria-hidden="true" />
                {actionPending === "abort" ? "Aborting..." : "Abort"}
              </button>
            ) : null}
            {run.capabilities.canDelete ? (
              confirmingDelete ? (
                <div className="drawer-confirm-actions">
                  <button
                    aria-label="Confirm delete run"
                    className="icon-btn icon-btn--destructive"
                    disabled={actionsLocked}
                    onClick={onDelete}
                    title={actionPending === "delete" ? "Deleting run..." : "Confirm delete run"}
                    type="button"
                  >
                    <CheckIcon aria-hidden="true" />
                  </button>
                  <button
                    aria-label="Cancel delete run"
                    className="icon-btn"
                    disabled={actionsLocked}
                    onClick={() => setConfirmingDelete(false)}
                    title={
                      actionPending === "delete" ? "Delete is pending..." : "Cancel delete run"
                    }
                    type="button"
                  >
                    <CloseIcon aria-hidden="true" />
                  </button>
                </div>
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
            <div className="meta-cell full">
              <span className="meta-label">Workspace</span>
              <span className="meta-value mono">
                {truncateMiddle(run.workspaceDir)}
                <button
                  aria-label="Copy workspace path"
                  className="copy"
                  onClick={() => onCopy(run.workspaceDir, "workspace path")}
                  type="button"
                >
                  <CopyIcon aria-hidden="true" />
                </button>
              </span>
            </div>
            {backendSessionId ? (
              <div className="meta-cell full">
                <span className="meta-label">Backend session</span>
                <span className="meta-value mono">
                  {truncateMiddle(backendSessionId)}
                  <button
                    aria-label="Copy backend session id"
                    className="copy"
                    onClick={() => onCopy(backendSessionId, "backend session id")}
                    type="button"
                  >
                    <CopyIcon aria-hidden="true" />
                  </button>
                </span>
              </div>
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
              aria-selected={activeSection === "attachments"}
              className={activeSection === "attachments" ? "tab active" : "tab"}
              onClick={() => onSelectSection("attachments")}
              type="button"
            >
              Attachments
              {run.attachments.length > 0 ? (
                <span className="tab-count"> {run.attachments.length}</span>
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
              aria-selected={activeSection === "timing"}
              className={activeSection === "timing" ? "tab active" : "tab"}
              onClick={() => onSelectSection("timing")}
              type="button"
            >
              Timing
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

          {activeSection === "attachments" ? (
            <section aria-label="Attachments" className="drawer-panel drawer-panel--attachments">
              <div className="drawer-panel-card dependency-panel">
                <div className="dependency-summary">
                  <span>
                    {run.attachments.length === 0
                      ? "No attachments yet."
                      : `${run.attachments.length} attachment${run.attachments.length === 1 ? "" : "s"} · ${formatBytes(totalAttachmentSize)}`}
                  </span>
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
                </div>

                {run.attachments.length === 0 ? null : (
                  <ul aria-label="Attachment list" className="dependency-list">
                    {run.attachments.map((attachment) => {
                      const previewable = isPreviewableAttachment(attachment);
                      const rowClassName = previewable
                        ? "dependency-row dependency-row--interactive"
                        : "dependency-row";
                      const attachmentSummary = (
                        <span className="dependency-copy">
                          <span className="dependency-name">{attachment.name}</span>
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
                        <li className={rowClassName} key={attachment.id}>
                          {previewable ? (
                            <button
                              aria-label={`Preview ${attachment.name}`}
                              className="attachment-row-trigger"
                              onClick={() => onOpenAttachmentPreview(attachment.id)}
                              type="button"
                            >
                              {attachmentSummary}
                            </button>
                          ) : (
                            attachmentSummary
                          )}
                          <div className="dependency-actions">
                            <button
                              aria-label={`Download ${attachment.name}`}
                              className="icon-btn"
                              disabled={actionsLocked}
                              onClick={() => void submitAttachmentDownload(attachment)}
                              title={downloadAttachmentPending ? "Downloading..." : "Download"}
                              type="button"
                            >
                              <DownloadIcon aria-hidden="true" />
                            </button>
                            {confirmingAttachmentId === attachment.id ? (
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
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
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

          {activeSection === "timing" ? (
            <section aria-label="Timing" className="drawer-panel drawer-panel--timing">
              <div className="drawer-panel-card">
                <div className="timing-grid">
                  <div className="timing-row">
                    <span className="timing-label">Started</span>
                    <span className="timing-value">{formatTimestamp(run.startedAt)}</span>
                  </div>
                  <div className="timing-row">
                    <span className="timing-label">Ended</span>
                    <span className="timing-value">{formatTimestamp(run.endedAt)}</span>
                  </div>
                  <div className="timing-row">
                    <span className="timing-label">Exit code</span>
                    <span className="timing-value">
                      {run.exitCode === null ? "Not available" : String(run.exitCode)}
                    </span>
                  </div>
                  <div className="timing-row">
                    <span className="timing-label">CWD</span>
                    <span className="timing-value">{truncateMiddle(run.cwd)}</span>
                  </div>
                </div>
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

                {!timelineState.isLoading && timelineAttempts.length === 0 ? (
                  <p className="muted-inline">No attempt history is available for this run yet.</p>
                ) : null}

                {selectedAttemptRecord ? (
                  <div className="timeline-attempt-panel">
                    <div className="timeline-sticky-controls">
                      {timelineAttempts.length > 1 ? (
                        <div className="timeline-attempts">
                          <div
                            className="timeline-attempt-tabs"
                            role="tablist"
                            aria-label="Attempts"
                          >
                            {timelineAttempts.map((attempt) => (
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
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div className="task-tabs" role="tablist" aria-label="Attempt view">
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
                          aria-selected={timelineTab === "output"}
                          className={timelineTab === "output" ? "task-tab active" : "task-tab"}
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
                      {timelineTab === "prompt" ? (
                        selectedAttemptRecord.prompt ? (
                          <section aria-label="Attempt prompt">
                            <MarkdownContent
                              className="timeline-content"
                              text={selectedAttemptRecord.prompt}
                            />
                          </section>
                        ) : (
                          <p className="task-empty">This attempt did not record a prompt.</p>
                        )
                      ) : selectedAttemptOutput ? (
                        <section aria-label="Attempt output">
                          <MarkdownContent
                            className="timeline-content"
                            text={selectedAttemptOutput}
                          />
                        </section>
                      ) : (
                        <p className="task-empty">
                          {selectedAttemptRecord.live
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
            closeResumeDialog();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeResumeDialog();
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
                  onClick={() => setResumeMessageExpanded((current) => !current)}
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
                  onChange={(event) => setResumeMessageDraft(event.target.value)}
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
                onClick={closeResumeDialog}
                type="button"
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={
                  resumePending || (resumeRequiresMessage && trimmedResumeMessage.length === 0)
                }
                onClick={() => void submitResume()}
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
