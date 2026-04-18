import type { RefObject } from "react";
import type { DashboardPreferences, DashboardViewState } from "../lib/settings.js";
import { AlertIcon, ArchiveIcon, GridIcon, SearchIcon } from "./icons.js";

export function RunFilters({
  preferences,
  repoOptions,
  searchInputRef,
  updatePreferences,
  updateViewState,
  viewState,
}: {
  preferences: DashboardPreferences;
  repoOptions: string[];
  searchInputRef?: RefObject<HTMLInputElement | null>;
  updatePreferences: (updates: Partial<DashboardPreferences>) => void;
  updateViewState: (updates: Partial<DashboardViewState>) => void;
  viewState: DashboardViewState;
}) {
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
            ref={searchInputRef}
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
