import type { RunSummary } from "@kcosr/agent-runner-core/contracts/runs.js";
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, FocusEvent, MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createApiClient } from "../lib/api-client.js";
import { truncateEnd } from "../lib/format.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { type DashboardStructuredFilters, useDaemonAuthToken } from "../lib/settings.js";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import {
  AttachmentIcon,
  ClockIcon,
  CloseIcon,
  DependencyIcon,
  GroupIcon,
  MessageIcon,
  NotepadTextIcon,
  PinIcon,
  RunningIcon,
} from "./icons.js";
import { MarkdownContent } from "./markdown.js";
import { useNativeModalDialog } from "./native-dialog.js";
import { RunNoteEditor, usePreferredRunNoteEditorMode } from "./run-note-editor.js";
import { StatusBadge } from "./status-badge.js";

export interface RunCardMotion {
  kind: "insert" | "move" | "reorder";
  revision: number;
}

interface CardRectSnapshot {
  left: number;
  top: number;
}

const CARD_MOVE_DURATION_MS = 260;
const CARD_HIGHLIGHT_DURATION_MS = 720;
const CARD_MENU_LONG_PRESS_MS = 520;
const CARD_MENU_LONG_PRESS_MOVE_TOLERANCE_PX = 8;
const CARD_MENU_CLICK_SUPPRESS_MS = 900;
const NOTE_PREVIEW_CLOSE_DELAY_MS = 140;
const NOTE_CONTROL_REOPEN_SUPPRESS_MS = 900;
const cardRectByRunId = new Map<string, CardRectSnapshot>();

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(mediaQuery.matches);
    };
    update();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => {
        mediaQuery.removeEventListener("change", update);
      };
    }

    mediaQuery.addListener(update);
    return () => {
      mediaQuery.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

export function RunCard({
  actionPending,
  run,
  selected,
  onSelect,
  onRequestActionMenu,
  onSetNote,
  onSetPinned,
  onStructuredFilterToggle,
  structuredFilters,
  motion,
}: {
  actionPending?: RunActionPending;
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
  onRequestActionMenu: (point: { clientX: number; clientY: number }) => void;
  onSetNote: (note: string | null) => Promise<void>;
  onSetPinned: (pinned: boolean) => Promise<void>;
  onStructuredFilterToggle: (key: keyof DashboardStructuredFilters, value: string) => void;
  structuredFilters: DashboardStructuredFilters;
  motion?: RunCardMotion;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const noteControlRef = useRef<HTMLDivElement | null>(null);
  const notePreviewRef = useRef<HTMLDivElement | null>(null);
  const notePreviewCloseTimeoutRef = useRef<number | null>(null);
  const noteControlSuppressedUntilRef = useRef(0);
  const longPressTimeoutRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressNextClickTimeoutRef = useRef<number | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const preferredNoteEditorMode = usePreferredRunNoteEditorMode();
  const previewFirstNoteMode = preferredNoteEditorMode === "preview";
  const [activeMotionRevision, setActiveMotionRevision] = useState<number | null>(null);
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [notePreviewOpen, setNotePreviewOpen] = useState(false);
  const progress =
    run.tasksTotal === 0 ? 0 : Math.round((run.tasksCompleted / run.tasksTotal) * 100);
  const accessibleName = run.name ?? "Unnamed";
  const visibleName = truncateEnd(run.name ?? "Unnamed");
  const showDependencyIndicator = run.dependencyState.total > 0;
  const dependencyIndicatorClass =
    run.dependencyState.unsatisfied > 0
      ? "meta-indicator meta-indicator--warning"
      : "meta-indicator meta-indicator--success";
  const showAttachmentIndicator = run.attachmentCount > 0;
  const showQueuedMessageIndicator = run.queuedResumeMessageCount > 0;
  const scheduleIndicatorClass = [
    "meta-indicator",
    run.scheduleState === "due"
      ? "meta-indicator--warning"
      : run.scheduleState === "paused"
        ? "meta-indicator--muted"
        : "meta-indicator--neutral",
  ].join(" ");
  const scheduleIndicatorLabel =
    run.schedule === null
      ? null
      : `Scheduled run: ${run.scheduleState === "future" ? "scheduled" : run.scheduleState}`;
  const repoFilterActive = structuredFilters.repo === run.repo;
  const agentFilterActive = structuredFilters.agent === run.agentName;
  const backendFilterActive = structuredFilters.backend === run.backend;
  const groupFilterActive = structuredFilters.runGroupId === run.runGroupId;
  const runIdLabel = run.runGroupId === run.runId ? run.runId : `${run.runGroupId}/${run.runId}`;
  const notePending = actionPending === "note";
  const pinPending = actionPending === "pin";
  const cardClassName = ["card", selected ? "selected" : null].filter(Boolean).join(" ");
  const config = useRuntimeConfig();
  const { daemonToken } = useDaemonAuthToken();
  const api = useMemo(() => createApiClient(config, { daemonToken }), [config, daemonToken]);
  const shouldLoadNoteDetail =
    noteDialogOpen || (run.notePresent && notePreviewOpen && !previewFirstNoteMode);
  const noteTitleId = useId();
  const noteDetailQuery = useQuery({
    queryKey: runQueryKeys.detail(run.runId),
    queryFn: async ({ signal }) => await api.getRun(run.runId, { signal }),
    enabled: shouldLoadNoteDetail,
    initialData: () => queryClient.getQueryData(runQueryKeys.detail(run.runId)),
  });
  const noteLoading = noteDetailQuery.isPending && noteDetailQuery.data === undefined;
  const note = noteDetailQuery.data?.note ?? null;
  const [notePreviewStyle, setNotePreviewStyle] = useState<CSSProperties | null>(null);

  function previewContainsTarget(target: EventTarget | null) {
    if (!(target instanceof Node)) {
      return false;
    }
    return (
      noteControlRef.current?.contains(target) === true ||
      notePreviewRef.current?.contains(target) === true
    );
  }

  const clearNotePreviewCloseTimeout = useCallback(() => {
    if (notePreviewCloseTimeoutRef.current === null || typeof window === "undefined") {
      return;
    }
    window.clearTimeout(notePreviewCloseTimeoutRef.current);
    notePreviewCloseTimeoutRef.current = null;
  }, []);

  const clearSuppressNextClickTimeout = useCallback(() => {
    if (suppressNextClickTimeoutRef.current === null || typeof window === "undefined") {
      return;
    }
    window.clearTimeout(suppressNextClickTimeoutRef.current);
    suppressNextClickTimeoutRef.current = null;
  }, []);

  const suppressNextClick = useCallback(() => {
    suppressNextClickRef.current = true;
    clearSuppressNextClickTimeout();
    if (typeof window === "undefined") {
      return;
    }
    suppressNextClickTimeoutRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressNextClickTimeoutRef.current = null;
    }, CARD_MENU_CLICK_SUPPRESS_MS);
  }, [clearSuppressNextClickTimeout]);

  function openNotePreview() {
    if (
      !run.notePresent ||
      previewFirstNoteMode ||
      Date.now() < noteControlSuppressedUntilRef.current
    ) {
      return;
    }
    clearNotePreviewCloseTimeout();
    setNotePreviewOpen(true);
  }

  function scheduleNotePreviewClose() {
    if (!run.notePresent || typeof window === "undefined") {
      setNotePreviewOpen(false);
      return;
    }
    clearNotePreviewCloseTimeout();
    notePreviewCloseTimeoutRef.current = window.setTimeout(() => {
      notePreviewCloseTimeoutRef.current = null;
      setNotePreviewOpen(false);
    }, NOTE_PREVIEW_CLOSE_DELAY_MS);
  }

  function handleCardClick(event: MouseEvent<HTMLButtonElement>) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      clearSuppressNextClickTimeout();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const filterBadge =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-structured-filter-key]")
        : null;
    if (filterBadge) {
      const key = filterBadge.dataset.structuredFilterKey as keyof DashboardStructuredFilters;
      const value = filterBadge.dataset.structuredFilterValue;
      if (value) {
        onStructuredFilterToggle(key, value);
      }
      return;
    }

    if (!selected) {
      onSelect();
    }
  }

  const clearLongPressTimeout = useCallback(() => {
    longPressStartRef.current = null;
    if (longPressTimeoutRef.current === null || typeof window === "undefined") {
      return;
    }
    window.clearTimeout(longPressTimeoutRef.current);
    longPressTimeoutRef.current = null;
  }, []);

  function handleCardContextMenu(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    clearLongPressTimeout();
    onRequestActionMenu({ clientX: event.clientX, clientY: event.clientY });
  }

  function handleCardPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (
      (event.pointerType !== "touch" && event.pointerType !== "pen") ||
      typeof window === "undefined"
    ) {
      return;
    }

    clearLongPressTimeout();
    const point = { clientX: event.clientX, clientY: event.clientY };
    longPressStartRef.current = point;
    longPressTimeoutRef.current = window.setTimeout(() => {
      longPressTimeoutRef.current = null;
      longPressStartRef.current = null;
      suppressNextClick();
      onRequestActionMenu(point);
    }, CARD_MENU_LONG_PRESS_MS);
  }

  function handleCardPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const start = longPressStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.clientX - start.clientX;
    const deltaY = event.clientY - start.clientY;
    if (Math.hypot(deltaX, deltaY) > CARD_MENU_LONG_PRESS_MOVE_TOLERANCE_PX) {
      clearLongPressTimeout();
    }
  }

  const openNoteDialog = useCallback(() => {
    if (Date.now() < noteControlSuppressedUntilRef.current) {
      return;
    }
    clearNotePreviewCloseTimeout();
    setNotePreviewOpen(false);
    setNoteDialogOpen(true);
  }, [clearNotePreviewCloseTimeout]);

  const closeNoteDialog = useCallback(() => {
    noteControlSuppressedUntilRef.current = Date.now() + NOTE_CONTROL_REOPEN_SUPPRESS_MS;
    clearNotePreviewCloseTimeout();
    setNotePreviewOpen(false);
    setNoteDialogOpen(false);
  }, [clearNotePreviewCloseTimeout]);
  const { dialogProps: noteDialogProps, ref: noteDialogRef } = useNativeModalDialog(
    true,
    closeNoteDialog,
  );

  function handleNotePointerEnter() {
    openNotePreview();
  }

  function handleNotePointerLeave(event: MouseEvent<HTMLDivElement>) {
    if (!run.notePresent) {
      return;
    }
    if (previewContainsTarget(event.relatedTarget)) {
      return;
    }
    scheduleNotePreviewClose();
  }

  function handleNoteBlur(event: FocusEvent<HTMLDivElement>) {
    if (!run.notePresent) {
      return;
    }
    if (previewContainsTarget(event.relatedTarget)) {
      return;
    }
    scheduleNotePreviewClose();
  }

  useEffect(() => {
    return () => {
      if (notePreviewCloseTimeoutRef.current === null || typeof window === "undefined") {
        return;
      }
      window.clearTimeout(notePreviewCloseTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", clearLongPressTimeout, true);
    window.addEventListener("blur", clearLongPressTimeout);
    return () => {
      window.removeEventListener("scroll", clearLongPressTimeout, true);
      window.removeEventListener("blur", clearLongPressTimeout);
      clearLongPressTimeout();
      clearSuppressNextClickTimeout();
    };
  }, [clearLongPressTimeout, clearSuppressNextClickTimeout]);

  useLayoutEffect(() => {
    if (
      !notePreviewOpen ||
      previewFirstNoteMode ||
      !run.notePresent ||
      cardRef.current === null ||
      typeof window === "undefined"
    ) {
      setNotePreviewStyle(null);
      return;
    }

    const updatePreviewStyle = () => {
      if (cardRef.current === null) {
        return;
      }
      const cardRect = cardRef.current.getBoundingClientRect();
      const noteControlRect = noteControlRef.current?.getBoundingClientRect() ?? cardRect;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const margin = 20;
      const gap = 10;
      const preferredWidth = Math.min(420, Math.max(280, cardRect.width - 24));
      const width = Math.min(preferredWidth, viewportWidth - margin * 2);
      const left = Math.min(
        Math.max(margin, noteControlRect.right - width),
        viewportWidth - width - margin,
      );
      const top = noteControlRect.bottom + gap;
      const maxHeight = Math.max(48, Math.min(240, viewportHeight - top - margin));

      setNotePreviewStyle({
        left,
        maxHeight,
        top,
        width,
      });
    };

    updatePreviewStyle();
    window.addEventListener("resize", updatePreviewStyle);
    window.addEventListener("scroll", updatePreviewStyle, true);
    return () => {
      window.removeEventListener("resize", updatePreviewStyle);
      window.removeEventListener("scroll", updatePreviewStyle, true);
    };
  }, [notePreviewOpen, previewFirstNoteMode, run.notePresent]);

  useEffect(() => {
    if (!motion) {
      setActiveMotionRevision(null);
      return;
    }

    setActiveMotionRevision(motion.revision);
    const timeoutId = window.setTimeout(() => {
      setActiveMotionRevision((current) => (current === motion.revision ? null : current));
    }, CARD_HIGHLIGHT_DURATION_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [motion]);

  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node) {
      return;
    }

    const rect = node.getBoundingClientRect();
    const previousRect = cardRectByRunId.get(run.runId);
    cardRectByRunId.set(run.runId, { left: rect.left, top: rect.top });

    if (!motion || !previousRect || prefersReducedMotion || motion.kind === "insert") {
      return;
    }

    const deltaX = previousRect.left - rect.left;
    const deltaY = previousRect.top - rect.top;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
      return;
    }

    node.animate(
      [{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: "translate(0, 0)" }],
      {
        duration: CARD_MOVE_DURATION_MS,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      },
    );
  }, [motion, prefersReducedMotion, run.runId]);

  return (
    <article className={cardClassName} ref={cardRef}>
      <button
        aria-label={accessibleName}
        aria-pressed={selected}
        className="card-main"
        data-motion-active={activeMotionRevision === motion?.revision ? "true" : undefined}
        data-motion-kind={motion?.kind}
        data-motion-revision={motion?.revision}
        data-run-id={run.runId}
        onClick={handleCardClick}
        onContextMenu={handleCardContextMenu}
        onPointerCancel={clearLongPressTimeout}
        onPointerDown={handleCardPointerDown}
        onPointerLeave={clearLongPressTimeout}
        onPointerMove={handleCardPointerMove}
        onPointerUp={clearLongPressTimeout}
        title={accessibleName}
        type="button"
      >
        <div className="card-header-block">
          <div className="card-row card-row--header">
            <span className="run-id">{runIdLabel}</span>
            <span
              aria-label={`Filter by run group ${run.runGroupId}`}
              className="card-group-filter"
              data-active-filter={groupFilterActive ? "true" : undefined}
              data-structured-filter-key="runGroupId"
              data-structured-filter-value={run.runGroupId}
              title={`Filter by run group ${run.runGroupId}`}
            >
              <GroupIcon aria-hidden="true" />
            </span>
            <span className="card-row-spacer" />
            <StatusBadge status={run.effectiveStatus} />
          </div>
          <div className="card-row">
            <span className="card-title">{visibleName}</span>
          </div>
          <div className="card-row card-row--subtitle">
            <span className="card-subtitle">{run.assignmentName ?? "Ad hoc run"}</span>
          </div>
          <div className="card-row card-meta">
            <span
              aria-label={`Filter by repo ${run.repo}`}
              className="repo-badge meta-filter-badge meta-filter-badge--repo"
              data-active-filter={repoFilterActive ? "true" : undefined}
              data-structured-filter-key="repo"
              data-structured-filter-value={run.repo}
            >
              {run.repo}
            </span>
            <span
              aria-label={`Filter by agent ${run.agentName}`}
              className="meta-item meta-filter-badge meta-filter-badge--agent"
              data-active-filter={agentFilterActive ? "true" : undefined}
              data-structured-filter-key="agent"
              data-structured-filter-value={run.agentName}
            >
              {run.agentName}
            </span>
            <span
              aria-label={`Filter by backend ${run.backend}`}
              className="backend-badge meta-filter-badge meta-filter-badge--backend"
              data-active-filter={backendFilterActive ? "true" : undefined}
              data-structured-filter-key="backend"
              data-structured-filter-value={run.backend}
            >
              {run.backend}
            </span>
            {showDependencyIndicator ? (
              <span
                aria-label={`${run.dependencyState.satisfied} of ${run.dependencyState.total} dependencies satisfied`}
                className={dependencyIndicatorClass}
                title={`${run.dependencyState.satisfied}/${run.dependencyState.total} dependency run(s) satisfied`}
              >
                <DependencyIcon aria-hidden="true" />
                {run.dependencyState.satisfied}/{run.dependencyState.total}
              </span>
            ) : null}
            {showAttachmentIndicator ? (
              <span
                aria-label={`${run.attachmentCount} attachment${run.attachmentCount === 1 ? "" : "s"}`}
                className="meta-indicator meta-indicator--neutral"
                title={`${run.attachmentCount} attachment${run.attachmentCount === 1 ? "" : "s"}`}
              >
                <AttachmentIcon aria-hidden="true" />
              </span>
            ) : null}
            {showQueuedMessageIndicator ? (
              <span
                aria-label={`${run.queuedResumeMessageCount} queued message${run.queuedResumeMessageCount === 1 ? "" : "s"}`}
                className="meta-indicator meta-indicator--neutral"
                title={`${run.queuedResumeMessageCount} queued message${run.queuedResumeMessageCount === 1 ? "" : "s"}`}
              >
                <MessageIcon aria-hidden="true" />
                {run.queuedResumeMessageCount}
              </span>
            ) : null}
            {run.schedule !== null && scheduleIndicatorLabel !== null ? (
              <span
                aria-label={scheduleIndicatorLabel}
                className={scheduleIndicatorClass}
                title={scheduleIndicatorLabel}
              >
                <ClockIcon aria-hidden="true" />
              </span>
            ) : null}
          </div>
        </div>
        <div className="card-row">
          <div className="card-progress">
            <div className="card-progress__meta">
              <span className="progress-text">
                {run.tasksCompleted} / {run.tasksTotal}
              </span>
            </div>
            <div className="progress" aria-label="task progress">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
        {run.activeTask ? (
          <div className="card-row">
            <span className="active-task" title={run.activeTask.title}>
              <RunningIcon aria-hidden="true" />
              <span className="active-task__text">{run.activeTask.title}</span>
            </span>
          </div>
        ) : null}
      </button>

      <div className="card-actions">
        <div
          className="card-note-control"
          onBlurCapture={handleNoteBlur}
          onFocusCapture={handleNotePointerEnter}
          onMouseEnter={handleNotePointerEnter}
          onMouseLeave={handleNotePointerLeave}
          ref={noteControlRef}
        >
          <button
            aria-label={
              run.notePresent
                ? `Preview or edit note for run ${run.runId}`
                : `Add note for run ${run.runId}`
            }
            aria-pressed={noteDialogOpen}
            className={
              run.notePresent ? "icon-btn card-action card-action--active" : "icon-btn card-action"
            }
            onClick={openNoteDialog}
            title={run.notePresent ? "Preview or edit note" : "Add note"}
            type="button"
          >
            <NotepadTextIcon aria-hidden="true" />
          </button>
        </div>
        <button
          aria-label={run.pinned ? `Unpin run ${run.runId}` : `Pin run ${run.runId}`}
          aria-pressed={run.pinned}
          className={
            run.pinned ? "icon-btn card-action card-action--active" : "icon-btn card-action"
          }
          disabled={pinPending}
          onClick={() => void onSetPinned(!run.pinned)}
          title={run.pinned ? "Unpin run" : "Pin run"}
          type="button"
        >
          <PinIcon aria-hidden="true" />
        </button>
      </div>

      {run.notePresent &&
      notePreviewOpen &&
      !previewFirstNoteMode &&
      notePreviewStyle &&
      typeof document !== "undefined"
        ? createPortal(
            <div
              aria-label={`Note preview for ${accessibleName}`}
              className="card-note-preview"
              onBlurCapture={handleNoteBlur}
              onFocusCapture={handleNotePointerEnter}
              onMouseEnter={handleNotePointerEnter}
              onMouseLeave={handleNotePointerLeave}
              ref={notePreviewRef}
              style={notePreviewStyle}
            >
              {noteLoading ? (
                <div aria-label="Loading note preview" className="card-note-preview__loading">
                  <div className="skeleton-line skeleton-line--short" />
                  <div className="skeleton-line skeleton-line--medium" />
                  <div className="skeleton-line skeleton-line--medium" />
                </div>
              ) : noteDetailQuery.isError ? (
                <p className="card-note-preview__state">{noteDetailQuery.error.message}</p>
              ) : note ? (
                <MarkdownContent className="card-note-preview__markdown" text={note} />
              ) : (
                <p className="card-note-preview__state">No note recorded yet.</p>
              )}
            </div>,
            document.body,
          )
        : null}

      {noteDialogOpen ? (
        <dialog
          aria-labelledby={noteTitleId}
          className="note-dialog-backdrop"
          {...noteDialogProps}
          ref={noteDialogRef}
        >
          <div className="note-dialog" role="document">
            <div className="note-dialog__header">
              <div>
                <h3 className="note-dialog__title" id={noteTitleId}>
                  {accessibleName}
                </h3>
              </div>
              <button
                aria-label="Close note editor"
                className="icon-btn"
                onClick={closeNoteDialog}
                type="button"
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
            {noteDetailQuery.isError ? (
              <p className="note-dialog__error">{noteDetailQuery.error.message}</p>
            ) : null}
            {noteLoading ? (
              <div aria-label="Loading note editor" className="note-loading-state">
                <div className="note-loading-state__toolbar">
                  <div className="skeleton-line skeleton-line--short" />
                </div>
                <div className="note-loading-state__body">
                  <div className="skeleton-line skeleton-line--short" />
                  <div className="skeleton-line skeleton-line--medium" />
                  <div className="skeleton-line skeleton-line--medium" />
                  <div className="skeleton-line skeleton-line--short" />
                </div>
                <div className="note-loading-state__actions">
                  <div className="skeleton-line skeleton-line--short" />
                  <div className="skeleton-line skeleton-line--short" />
                </div>
              </div>
            ) : (
              <RunNoteEditor
                autoFocusEditor={true}
                closeOnCancel={true}
                closeOnSave={true}
                emptyPreviewMessage="No note recorded yet."
                initialMode={preferredNoteEditorMode}
                note={note}
                onClose={closeNoteDialog}
                onSave={onSetNote}
                pending={notePending}
                textareaLabel={`Run note for ${accessibleName}`}
              />
            )}
          </div>
        </dialog>
      ) : null}
    </article>
  );
}
