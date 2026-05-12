import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { formatScheduleState, formatTimestampWithRelative, truncateEnd } from "../lib/format.js";
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

function runIdLabel(run: RunSummary): string {
  return run.runGroupId === run.runId ? run.runId : `${run.runGroupId}/${run.runId}`;
}

function progressPercent(run: RunSummary): number {
  return run.tasksTotal === 0 ? 0 : Math.round((run.tasksCompleted / run.tasksTotal) * 100);
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

export function RunRow({
  actionPending,
  run,
  selected,
  sortField,
  structuredFilters,
  onRequestActionMenu,
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
  onSelect: () => void;
  onSetPinned: (pinned: boolean) => Promise<void>;
  onStructuredFilterToggle: (key: keyof DashboardStructuredFilters, value: string) => void;
}) {
  const accessibleName = run.name ?? "Unnamed";
  const visibleName = truncateEnd(accessibleName, 72);
  const assignmentName = run.assignmentName ?? "Ad hoc run";
  const progress = progressPercent(run);
  const timeLabel = timeFieldLabel(sortField);
  const rawTimeValue = timeFieldValue(run, sortField);
  const formattedTime = formatTimestampWithRelative(rawTimeValue);
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

  return (
    <article className={selected ? "run-row run-row--selected" : "run-row"} data-run-id={run.runId}>
      <button
        aria-label={`Open run ${accessibleName}`}
        aria-pressed={selected}
        className="run-row__main"
        onClick={onSelect}
        onContextMenu={(event) => {
          event.preventDefault();
          onRequestActionMenu({ clientX: event.clientX, clientY: event.clientY });
        }}
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
          data-active-filter={structuredFilters.runGroupId === run.runGroupId ? "true" : undefined}
          onClick={() => onStructuredFilterToggle("runGroupId", run.runGroupId)}
          title={`Filter by run group ${run.runGroupId}`}
          type="button"
        >
          <GroupIcon aria-hidden="true" />
          <span>{run.runGroupId}</span>
        </button>
      </div>

      <div className="run-row__progress">
        <span className="progress-text">
          {run.tasksCompleted} / {run.tasksTotal}
        </span>
        <div aria-label="Task progress" className="progress">
          <div className="progress-bar" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="run-row__signals" aria-label={`Signals for ${accessibleName}`}>
        {run.pinned ? (
          <span aria-label="Pinned" className="run-row-signal run-row-signal--neutral">
            <PinIcon aria-hidden="true" />
          </span>
        ) : null}
        {run.notePresent ? (
          <span aria-label="Note present" className="run-row-signal run-row-signal--neutral">
            <NotepadTextIcon aria-hidden="true" />
          </span>
        ) : null}
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
        {run.activeTask ? (
          <span className="run-row-signal run-row-signal--active" title={run.activeTask.title}>
            <RunningIcon aria-hidden="true" />
            <span className="run-row-signal__text">{run.activeTask.title}</span>
          </span>
        ) : null}
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
