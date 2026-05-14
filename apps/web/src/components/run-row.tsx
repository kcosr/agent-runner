import type { RunSummary } from "@kcosr/agent-runner-core/contracts/runs.js";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { formatRelativeTimestamp, formatScheduleState, truncateEnd } from "../lib/format.js";
import type { DashboardSortField, DashboardStructuredFilters } from "../lib/settings.js";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import {
  AttachmentIcon,
  ClockIcon,
  DependencyIcon,
  GroupIcon,
  MessageIcon,
  MoreHorizontalIcon,
  NotepadTextIcon,
  PinIcon,
  RunningIcon,
} from "./icons.js";
import { StatusBadge } from "./status-badge.js";

const ROW_MENU_LONG_PRESS_MS = 520;
const ROW_MENU_LONG_PRESS_MOVE_TOLERANCE_PX = 8;
const ROW_MENU_CLICK_SUPPRESS_MS = 900;

function runIdLabel(run: RunSummary): string {
  return run.runGroupId === run.runId ? run.runId : `${run.runGroupId}/${run.runId}`;
}

function timeFieldLabel(sortField: DashboardSortField): string {
  switch (sortField) {
    case "startedAt":
      return "Started";
    case "updatedAt":
      return "Updated";
    case "endedAt":
      return "Ended";
  }
}

function timeFieldValue(run: RunSummary, sortField: DashboardSortField): string | null {
  switch (sortField) {
    case "startedAt":
      return run.startedAt;
    case "updatedAt":
      return run.updatedAt;
    case "endedAt":
      return run.endedAt;
  }
}

function eventStartedFromControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, select, textarea, summary, [role='button']") !== null
  );
}

function eventStartedFromAuxiliaryControl(target: EventTarget | null): boolean {
  return eventStartedFromControl(target) && target instanceof Element
    ? target.closest(".run-row__main") === null
    : false;
}

export function RunRow({
  actionPending,
  run,
  selected,
  sortField,
  structuredFilters,
  onRequestActionMenu,
  onOpenNote,
  onSelect,
  onSetPinned,
  onStructuredFilterToggle,
}: {
  actionPending?: RunActionPending;
  run: RunSummary;
  selected: boolean;
  sortField: DashboardSortField;
  structuredFilters: DashboardStructuredFilters;
  onRequestActionMenu: (point: { clientX: number; clientY: number }) => void;
  onOpenNote: () => void;
  onSelect: () => void;
  onSetPinned: (pinned: boolean) => Promise<void>;
  onStructuredFilterToggle: (key: keyof DashboardStructuredFilters, value: string) => void;
}) {
  const rowRef = useRef<HTMLElement | null>(null);
  const longPressTimeoutRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressNextClickTimeoutRef = useRef<number | null>(null);
  const accessibleName = run.name ?? "Unnamed";
  const visibleName = truncateEnd(accessibleName, 72);
  const assignmentName = run.assignmentName ?? "Ad hoc run";
  const timeLabel = timeFieldLabel(sortField);
  const rawTimeValue = timeFieldValue(run, sortField);
  const formattedTime = formatRelativeTimestamp(rawTimeValue) || "Not available";
  const timeMuted = rawTimeValue === null;
  const dependencySignal =
    run.dependencyState.total > 0
      ? `${run.dependencyState.satisfied}/${run.dependencyState.total}`
      : null;
  const dependencySignalClass =
    run.dependencyState.unsatisfied > 0
      ? "run-row-signal run-row-signal--warning"
      : "run-row-signal run-row-signal--success";

  function requestActionMenuFromButton(button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect();
    onRequestActionMenu({
      clientX: rect.right,
      clientY: rect.bottom,
    });
  }

  const clearLongPressTimeout = useCallback(() => {
    longPressStartRef.current = null;
    if (longPressTimeoutRef.current === null || typeof window === "undefined") {
      return;
    }
    window.clearTimeout(longPressTimeoutRef.current);
    longPressTimeoutRef.current = null;
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
    }, ROW_MENU_CLICK_SUPPRESS_MS);
  }, [clearSuppressNextClickTimeout]);

  function handleRowClick(event: MouseEvent<HTMLElement>) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      clearSuppressNextClickTimeout();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.defaultPrevented || eventStartedFromControl(event.target)) {
      return;
    }
    onSelect();
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (
      event.defaultPrevented ||
      eventStartedFromControl(event.target) ||
      (event.key !== "Enter" && event.key !== " ")
    ) {
      return;
    }
    event.preventDefault();
    onSelect();
  }

  function handleRowContextMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    clearLongPressTimeout();
    onRequestActionMenu({ clientX: event.clientX, clientY: event.clientY });
  }

  function handleRowPointerDown(event: PointerEvent<HTMLElement>) {
    if (
      (event.pointerType !== "touch" && event.pointerType !== "pen") ||
      eventStartedFromAuxiliaryControl(event.target) ||
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
    }, ROW_MENU_LONG_PRESS_MS);
  }

  function handleRowPointerMove(event: PointerEvent<HTMLElement>) {
    const start = longPressStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.clientX - start.clientX;
    const deltaY = event.clientY - start.clientY;
    if (Math.hypot(deltaX, deltaY) > ROW_MENU_LONG_PRESS_MOVE_TOLERANCE_PX) {
      clearLongPressTimeout();
    }
  }

  useEffect(() => {
    if (!selected) {
      return;
    }
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

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

  return (
    <article
      className={selected ? "run-row run-row--selected" : "run-row"}
      data-run-id={run.runId}
      onClick={handleRowClick}
      onContextMenu={handleRowContextMenu}
      onKeyDown={handleRowKeyDown}
      onPointerCancel={clearLongPressTimeout}
      onPointerDown={handleRowPointerDown}
      onPointerLeave={clearLongPressTimeout}
      onPointerMove={handleRowPointerMove}
      onPointerUp={clearLongPressTimeout}
      ref={rowRef}
    >
      <button
        aria-label={`Open run ${accessibleName}`}
        aria-pressed={selected}
        className="run-row__main"
        onClick={onSelect}
        type="button"
      >
        <span className="run-row__status">
          <StatusBadge status={run.effectiveStatus} />
        </span>
        <span className="run-row__identity">
          <span className="run-row__title" title={accessibleName}>
            {visibleName}
          </span>
          <span className="run-row__subtitle">
            <span>{assignmentName}</span>
            <span aria-hidden="true">/</span>
            <span>{runIdLabel(run)}</span>
          </span>
        </span>
      </button>

      <div className="run-row__metadata" aria-label={`Metadata for ${accessibleName}`}>
        <div className="run-row__metadata-badges">
          <button
            aria-label={`Filter by repo ${run.repo}`}
            className="repo-badge meta-filter-badge meta-filter-badge--repo"
            data-active-filter={structuredFilters.repo === run.repo ? "true" : undefined}
            onClick={() => onStructuredFilterToggle("repo", run.repo)}
            type="button"
          >
            {run.repo}
          </button>
          <button
            aria-label={`Filter by agent ${run.agentName}`}
            className="meta-item meta-filter-badge meta-filter-badge--agent"
            data-active-filter={structuredFilters.agent === run.agentName ? "true" : undefined}
            onClick={() => onStructuredFilterToggle("agent", run.agentName)}
            type="button"
          >
            {run.agentName}
          </button>
          <button
            aria-label={`Filter by backend ${run.backend}`}
            className="backend-badge meta-filter-badge meta-filter-badge--backend"
            data-active-filter={structuredFilters.backend === run.backend ? "true" : undefined}
            onClick={() => onStructuredFilterToggle("backend", run.backend)}
            type="button"
          >
            {run.backend}
          </button>
          <button
            aria-label={`Filter by run group ${run.runGroupId}`}
            className="run-row-group-filter"
            data-active-filter={
              structuredFilters.runGroupId === run.runGroupId ? "true" : undefined
            }
            onClick={() => onStructuredFilterToggle("runGroupId", run.runGroupId)}
            title={`Filter by run group ${run.runGroupId}`}
            type="button"
          >
            <GroupIcon aria-hidden="true" />
            <span>{run.runGroupId}</span>
          </button>
          {run.schedule !== null ? (
            <span
              aria-label={`Scheduled run: ${formatScheduleState(run.scheduleState)}`}
              className={
                run.scheduleState === "due"
                  ? "run-row-signal run-row-signal--warning"
                  : run.scheduleState === "paused"
                    ? "run-row-signal run-row-signal--muted"
                    : "run-row-signal run-row-signal--neutral"
              }
            >
              <ClockIcon aria-hidden="true" />
            </span>
          ) : null}
          {dependencySignal ? (
            <span
              aria-label={`${run.dependencyState.satisfied} of ${run.dependencyState.total} dependencies satisfied`}
              className={dependencySignalClass}
            >
              <DependencyIcon aria-hidden="true" />
              {dependencySignal}
            </span>
          ) : null}
          {run.attachmentCount > 0 ? (
            <span
              aria-label={`${run.attachmentCount} attachment${run.attachmentCount === 1 ? "" : "s"}`}
              className="run-row-signal run-row-signal--neutral"
            >
              <AttachmentIcon aria-hidden="true" />
              {run.attachmentCount}
            </span>
          ) : null}
          {run.queuedResumeMessageCount > 0 ? (
            <span
              aria-label={`${run.queuedResumeMessageCount} queued message${run.queuedResumeMessageCount === 1 ? "" : "s"}`}
              className="run-row-signal run-row-signal--neutral"
            >
              <MessageIcon aria-hidden="true" />
              {run.queuedResumeMessageCount}
            </span>
          ) : null}
        </div>
        {run.activeTask ? (
          <div className="run-row__metadata-progress">
            <span className="active-task run-row__active-task" title={run.activeTask.title}>
              <RunningIcon aria-hidden="true" />
              <span className="active-task__text">{run.activeTask.title}</span>
            </span>
          </div>
        ) : null}
      </div>

      <div
        aria-label={`${run.tasksCompleted} of ${run.tasksTotal} tasks completed`}
        className="progress-text run-row__task-count"
      >
        {run.tasksCompleted} / {run.tasksTotal}
      </div>

      <div className="run-row__time">
        <span className="run-row__time-label">{timeLabel}</span>
        <span
          className={
            timeMuted ? "run-row__time-value run-row__time-value--muted" : "run-row__time-value"
          }
        >
          {formattedTime}
        </span>
      </div>

      <div className="run-row__actions">
        <button
          aria-label={
            run.notePresent
              ? `Preview or edit note for run ${run.runId}`
              : `Add note for run ${run.runId}`
          }
          className={
            run.notePresent ? "icon-btn card-action card-action--active" : "icon-btn card-action"
          }
          onClick={onOpenNote}
          title={run.notePresent ? "Preview or edit note" : "Add note"}
          type="button"
        >
          <NotepadTextIcon aria-hidden="true" />
        </button>
        <button
          aria-label={run.pinned ? `Unpin run ${run.runId}` : `Pin run ${run.runId}`}
          aria-pressed={run.pinned}
          className={
            run.pinned ? "icon-btn card-action card-action--active" : "icon-btn card-action"
          }
          disabled={actionPending === "pin"}
          onClick={() => void onSetPinned(!run.pinned)}
          title={run.pinned ? "Unpin run" : "Pin run"}
          type="button"
        >
          <PinIcon aria-hidden="true" />
        </button>
        <button
          aria-label={`Run actions for ${run.runId}`}
          className="icon-btn card-action"
          onClick={(event) => requestActionMenuFromButton(event.currentTarget)}
          title="Run actions"
          type="button"
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
