import type { UseQueryResult } from "@tanstack/react-query";
import type { RunDetail } from "@task-runner/core/contracts/runs.js";
import type { RunActionPending } from "./use-runs-dashboard-state.js";

import { RunDetailDrawer } from "../components/run-detail-drawer.js";
import { isNotFoundError } from "../lib/api-client.js";

export function RunDetailPanel({
  actionError,
  actionPending,
  onAbort,
  onArchive,
  onClose,
  onCopy,
  onResume,
  onUnarchive,
  selectedRunId,
  selectedRunQuery,
}: {
  actionError?: string;
  actionPending?: RunActionPending;
  onAbort: (runId: string) => void;
  onArchive: (runId: string) => void;
  onClose: () => void;
  onCopy: (value: string, label: string) => Promise<void>;
  onResume: (runId: string) => void;
  onUnarchive: (runId: string) => void;
  selectedRunId?: string;
  selectedRunQuery: UseQueryResult<RunDetail, Error>;
}) {
  if (!selectedRunId) {
    return undefined;
  }

  if (selectedRunQuery.isPending) {
    return (
      <aside aria-label="Run detail" className="drawer drawer-skeleton">
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
      <aside aria-label="Run detail" className="drawer">
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
      actionError={actionError}
      actionPending={actionPending}
      key={selectedRun.runId}
      onAbort={() => onAbort(selectedRun.runId)}
      onArchive={() => onArchive(selectedRun.runId)}
      onClose={onClose}
      onCopy={(value, label) => void onCopy(value, label)}
      onResume={() => onResume(selectedRun.runId)}
      onUnarchive={() => onUnarchive(selectedRun.runId)}
      run={selectedRun}
    />
  );
}
