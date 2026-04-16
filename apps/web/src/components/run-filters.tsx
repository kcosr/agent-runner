import type { DashboardPreferences, DashboardViewState } from "../lib/settings.js";
import { AlertIcon, ArchiveIcon, GridIcon, SearchIcon, SortIcon } from "./icons.js";

export function RunFilters({
  preferences,
  repoOptions,
  updatePreferences,
  updateViewState,
  viewState,
}: {
  preferences: DashboardPreferences;
  repoOptions: string[];
  updatePreferences: (updates: Partial<DashboardPreferences>) => void;
  updateViewState: (updates: Partial<DashboardViewState>) => void;
  viewState: DashboardViewState;
}) {
  const sortModeLabel = viewState.sortMode === "recent-updates" ? "Recent updates" : "Started time";

  return (
    <header className="topbar">
      <span className="page-title">
        Runs
        {preferences.showArchived ? (
          <span className="page-title-meta">including archived</span>
        ) : null}
      </span>
      <span className="topbar-spacer" />
      <div className="toolbar-matrix">
        <label className="field search">
          <SearchIcon aria-hidden="true" />
          <input
            onChange={(event) => updateViewState({ search: event.target.value })}
            placeholder="Search runs"
            type="search"
            value={viewState.search}
          />
        </label>

        <label className="field select">
          <span className="field-label">Repo</span>
          <select
            aria-label="Filter by repo"
            onChange={(event) => updateViewState({ repo: event.target.value })}
            value={viewState.repo}
          >
            <option value="all">All</option>
            {repoOptions.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </label>

        <button
          aria-label="Hide empty columns"
          aria-pressed={preferences.hideEmptyColumns}
          className="icon-btn"
          onClick={() => updatePreferences({ hideEmptyColumns: !preferences.hideEmptyColumns })}
          title="Hide empty columns"
          type="button"
        >
          <GridIcon aria-hidden="true" />
        </button>

        <button
          aria-label="Collapse failure states"
          aria-pressed={preferences.collapseFailureStates}
          className="icon-btn"
          onClick={() =>
            updatePreferences({
              collapseFailureStates: !preferences.collapseFailureStates,
            })
          }
          title="Collapse failure states"
          type="button"
        >
          <AlertIcon aria-hidden="true" />
        </button>

        <button
          aria-label={`Board sort mode: ${sortModeLabel}. Activate to switch modes.`}
          aria-pressed={viewState.sortMode === "recent-updates"}
          className="icon-btn"
          onClick={() =>
            updateViewState({
              sortMode: viewState.sortMode === "started" ? "recent-updates" : "started",
            })
          }
          title={`Board sort mode: ${sortModeLabel}`}
          type="button"
        >
          <SortIcon aria-hidden="true" />
        </button>

        <button
          aria-label="Show archived runs"
          aria-pressed={preferences.showArchived}
          className="icon-btn"
          onClick={() => updatePreferences({ showArchived: !preferences.showArchived })}
          title="Show archived runs"
          type="button"
        >
          <ArchiveIcon aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
