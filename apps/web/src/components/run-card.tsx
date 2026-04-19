import { useQuery } from "@tanstack/react-query";
import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import type { FocusEvent, MouseEvent } from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "../lib/api-client.js";
import { truncateEnd } from "../lib/format.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import type { DashboardStructuredFilters } from "../lib/settings.js";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import { AttachmentIcon, DependencyIcon, PencilIcon, PinIcon, RunningIcon } from "./icons.js";
import { MarkdownContent } from "./markdown.js";
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
  onSetNote: (note: string | null) => Promise<void>;
  onSetPinned: (pinned: boolean) => Promise<void>;
  onStructuredFilterToggle: (key: keyof DashboardStructuredFilters, value: string) => void;
  structuredFilters: DashboardStructuredFilters;
  motion?: RunCardMotion;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const noteControlRef = useRef<HTMLDivElement | null>(null);
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
  const repoFilterActive = structuredFilters.repo === run.repo;
  const agentFilterActive = structuredFilters.agent === run.agentName;
  const backendFilterActive = structuredFilters.backend === run.backend;
  const notePending = actionPending === "note";
  const pinPending = actionPending === "pin";
  const cardClassName = ["card", selected ? "selected" : null].filter(Boolean).join(" ");
  const config = useRuntimeConfig();
  const api = useMemo(() => createApiClient(config), [config]);
  const shouldLoadNoteDetail =
    noteDialogOpen || (run.notePresent && notePreviewOpen && !previewFirstNoteMode);
  const noteTitleId = useId();
  const noteDetailQuery = useQuery({
    queryKey: runQueryKeys.detail(run.runId),
    queryFn: async ({ signal }) => await api.getRun(run.runId, { signal }),
    enabled: shouldLoadNoteDetail,
    initialData: () => queryClient.getQueryData(runQueryKeys.detail(run.runId)),
  });
  const note = noteDetailQuery.data?.note ?? null;

  function handleCardClick(event: MouseEvent<HTMLButtonElement>) {
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

  function openNoteDialog() {
    setNotePreviewOpen(false);
    setNoteDialogOpen(true);
  }

  function closeNoteDialog() {
    setNoteDialogOpen(false);
  }

  function handleNotePointerEnter() {
    if (!run.notePresent || previewFirstNoteMode) {
      return;
    }
    setNotePreviewOpen(true);
  }

  function handleNotePointerLeave(event: MouseEvent<HTMLDivElement>) {
    if (!run.notePresent) {
      return;
    }
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      noteControlRef.current !== null &&
      noteControlRef.current.contains(nextTarget)
    ) {
      return;
    }
    setNotePreviewOpen(false);
  }

  function handleNoteBlur(event: FocusEvent<HTMLDivElement>) {
    if (!run.notePresent) {
      return;
    }
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      noteControlRef.current !== null &&
      noteControlRef.current.contains(nextTarget)
    ) {
      return;
    }
    setNotePreviewOpen(false);
  }

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
        title={accessibleName}
        type="button"
      >
        <div className="card-row">
          <span className="run-id">{run.runId}</span>
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
          {run.pinned ? (
            <span className="meta-indicator meta-indicator--neutral">Pinned</span>
          ) : null}
          {run.notePresent ? (
            <span className="meta-indicator meta-indicator--neutral">Note</span>
          ) : null}
        </div>
        <div className="card-row">
          <div className="progress" aria-label="task progress">
            <div className="progress-bar" style={{ width: `${progress}%` }} />
          </div>
          <span className="progress-text">
            {run.tasksCompleted} / {run.tasksTotal}
          </span>
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
            <PencilIcon aria-hidden="true" />
          </button>

          {run.notePresent && notePreviewOpen && !previewFirstNoteMode ? (
            <div aria-label={`Note preview for ${accessibleName}`} className="card-note-preview">
              {noteDetailQuery.isPending ? (
                <p className="card-note-preview__state">Loading note…</p>
              ) : noteDetailQuery.isError ? (
                <p className="card-note-preview__state">{noteDetailQuery.error.message}</p>
              ) : note ? (
                <MarkdownContent className="card-note-preview__markdown" text={note} />
              ) : (
                <p className="card-note-preview__state">No note recorded yet.</p>
              )}
            </div>
          ) : null}
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

      {noteDialogOpen ? (
        <dialog aria-labelledby={noteTitleId} className="note-dialog-backdrop" open>
          <button
            aria-label="Close note editor"
            className="note-dialog-backdrop__button"
            onClick={closeNoteDialog}
            type="button"
          />
          <div className="note-dialog" role="document">
            <div className="note-dialog__header">
              <div>
                <h3 className="note-dialog__title" id={noteTitleId}>
                  {accessibleName}
                </h3>
                <p className="note-dialog__copy">Run note</p>
              </div>
              <button
                aria-label="Close note editor"
                className="icon-btn"
                onClick={closeNoteDialog}
                type="button"
              >
                ×
              </button>
            </div>
            {noteDetailQuery.isError ? (
              <p className="note-dialog__error">{noteDetailQuery.error.message}</p>
            ) : null}
            <RunNoteEditor
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
          </div>
        </dialog>
      ) : null}
    </article>
  );
}
