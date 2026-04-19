import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import type { MouseEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { truncateEnd } from "../lib/format.js";
import type { DashboardStructuredFilters } from "../lib/settings.js";
import { AttachmentIcon, DependencyIcon, RunningIcon } from "./icons.js";
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
  run,
  selected,
  onSelect,
  onStructuredFilterToggle,
  structuredFilters,
  motion,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
  onStructuredFilterToggle: (key: keyof DashboardStructuredFilters, value: string) => void;
  structuredFilters: DashboardStructuredFilters;
  motion?: RunCardMotion;
}) {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [activeMotionRevision, setActiveMotionRevision] = useState<number | null>(null);
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
  const cardClassName = [
    "card",
    selected ? "selected" : null,
    motion ? `card--motion-${motion.kind}` : null,
  ]
    .filter(Boolean)
    .join(" ");

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
    <button
      aria-label={accessibleName}
      aria-pressed={selected}
      className={cardClassName}
      data-motion-active={activeMotionRevision === motion?.revision ? "true" : undefined}
      data-motion-kind={motion?.kind}
      data-motion-revision={motion?.revision}
      data-run-id={run.runId}
      onClick={handleCardClick}
      ref={cardRef}
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
  );
}
