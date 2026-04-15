import type { UseQueryResult } from "@tanstack/react-query";
import type { RunDetail, RunSummary } from "@task-runner/core/contracts/runs.js";
import type { CSSProperties } from "react";
import type { RunTimelineState } from "../lib/run-timeline.js";
import type { RunActionPending } from "./use-runs-dashboard-state.js";

import { RunDetailDrawer } from "../components/run-detail-drawer.js";
import { isNotFoundError } from "../lib/api-client.js";

export function RunDetailPanel({
  onAddDependency,
  actionError,
  actionPending,
  drawerWidth,
  runs,
  onAbort,
  onArchive,
  onClearDependencies,
  onClose,
  onCopy,
  onDownloadAttachment,
  onRemoveDependency,
  onRemoveAttachment,
  onRename,
  onResume,
  onUnarchive,
  onUploadAttachment,
  selectedRunId,
  selectedRunQuery,
  timelineState,
}: {
  onAddDependency: (runId: string, dependencyRunId: string) => Promise<void>;
  actionError?: string;
  actionPending?: RunActionPending;
  drawerWidth: number;
  runs: RunSummary[];
  onAbort: (runId: string) => void;
  onArchive: (runId: string) => void;
  onClearDependencies: (runId: string) => Promise<void>;
  onClose: () => void;
  onCopy: (value: string, label: string) => Promise<void>;
  onDownloadAttachment: (runId: string, attachmentId: string, name: string) => Promise<void>;
  onRemoveDependency: (runId: string, dependencyRunId: string) => Promise<void>;
  onRemoveAttachment: (runId: string, attachmentId: string) => Promise<void>;
  onRename: (runId: string, name: string | null) => Promise<void>;
  onResume: (runId: string, message?: string) => Promise<void>;
  onUnarchive: (runId: string) => void;
  onUploadAttachment: (runId: string, file: File) => Promise<void>;
  selectedRunId?: string;
  selectedRunQuery: UseQueryResult<RunDetail, Error>;
  timelineState: RunTimelineState;
}) {
  if (!selectedRunId) {
    return undefined;
  }

  const drawerStyle = { "--drawer-width": `${drawerWidth}px` } as CSSProperties;

  if (selectedRunQuery.isPending) {
    return (
      <aside aria-label="Run detail" className="drawer drawer-skeleton" style={drawerStyle}>
        <div className="drawer-state">
          <div className="skeleton-line skeleton-line--short" />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
        </div>
      </aside>
    );
  }

  if (selectedRunQuery.isError && !isNotFoundError(selectedRunQuery.error)) {
    return (
      <aside aria-label="Run detail" className="drawer" style={drawerStyle}>
        <div className="drawer-state">
          <h3>Run detail failed to load</h3>
          <p>{selectedRunQuery.error.message}</p>
          <button className="btn" onClick={() => void selectedRunQuery.refetch()} type="button">
            Retry detail load
          </button>
        </div>
      </aside>
    );
  }

  if (!selectedRunQuery.data) {
    return undefined;
  }

  const selectedRun = selectedRunQuery.data;
  return (
    <RunDetailDrawer
      dependencyCandidateRuns={runs}
      onAddDependency={(dependencyRunId) => onAddDependency(selectedRun.runId, dependencyRunId)}
      actionError={actionError}
      actionPending={actionPending}
      key={selectedRun.runId}
      onAbort={() => onAbort(selectedRun.runId)}
      onArchive={() => onArchive(selectedRun.runId)}
      onClearDependencies={() => onClearDependencies(selectedRun.runId)}
      onClose={onClose}
      onCopy={(value, label) => void onCopy(value, label)}
      onDownloadAttachment={(attachmentId, name) =>
        onDownloadAttachment(selectedRun.runId, attachmentId, name)
      }
      onRemoveDependency={(dependencyRunId) =>
        onRemoveDependency(selectedRun.runId, dependencyRunId)
      }
      onRemoveAttachment={(attachmentId) => onRemoveAttachment(selectedRun.runId, attachmentId)}
      onRename={(name) => onRename(selectedRun.runId, name)}
      onResume={(message) => onResume(selectedRun.runId, message)}
      timelineState={timelineState}
      onUnarchive={() => onUnarchive(selectedRun.runId)}
      onUploadAttachment={(file) => onUploadAttachment(selectedRun.runId, file)}
      run={selectedRun}
    />
  );
}
