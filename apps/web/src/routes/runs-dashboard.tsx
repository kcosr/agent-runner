import { AppShell } from "../components/app-shell.js";
import { RunFilters } from "../components/run-filters.js";
import { RunDetailPanel } from "./run-detail-panel.js";
import { RunsBoardPanel } from "./runs-board-panel.js";
import { useRunsDashboardState } from "./use-runs-dashboard-state.js";

export function RunsDashboardRoute() {
  const state = useRunsDashboardState();

  const topNotices = [
    state.streamStale ? (
      <div className="notice" data-tone="warning" key="stream-stale">
        <span className="notice__message">
          Live updates are temporarily stale. The board stays usable and falls back to HTTP refetch.
        </span>
        <div className="notice__actions">
          <button className="btn" onClick={() => void state.runsQuery.refetch()} type="button">
            Refetch now
          </button>
        </div>
      </div>
    ) : null,
  ].filter(Boolean);

  const bottomNotices = state.notices.map((notice) => (
    <div className="notice" data-tone={notice.tone} key={notice.id}>
      <span className="notice__message">{notice.message}</span>
      <div className="notice__actions">
        <button
          aria-label="Dismiss notice"
          className="icon-btn icon-btn--small"
          onClick={() => state.dismissNotice(notice.id)}
          type="button"
        >
          ×
        </button>
      </div>
    </div>
  ));

  return (
    <AppShell
      board={
        <RunsBoardPanel
          boardColumns={state.boardColumns}
          onResetFilters={() =>
            state.updateSettings({ repo: "all", search: "", showArchived: false })
          }
          onSelectRun={state.openRun}
          runs={state.runs}
          runsQuery={state.runsQuery}
          selectedRunActiveTask={state.selectedRunActiveTask}
          selectedRunId={state.selectedRunId}
          visibleRuns={state.visibleRuns}
        />
      }
      bottomNotices={bottomNotices.length > 0 ? bottomNotices : undefined}
      detail={
        <RunDetailPanel
          actionError={state.actionError}
          actionPending={state.actionPending}
          onAbort={state.runActions.abort}
          onArchive={state.runActions.archive}
          onClose={state.closeRun}
          onCopy={state.copyText}
          onResume={state.runActions.resume}
          onUnarchive={state.runActions.unarchive}
          selectedRunId={state.selectedRunId}
          selectedRunQuery={state.selectedRunQuery}
        />
      }
      topNotices={topNotices.length > 0 ? topNotices : undefined}
      toolbar={
        <RunFilters
          repoOptions={state.repoOptions}
          settings={state.settings}
          updateSettings={state.updateSettings}
        />
      }
    />
  );
}
