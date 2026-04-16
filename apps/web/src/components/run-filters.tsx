import type { BoardSettings } from "../lib/settings.js";
import { AlertIcon, ArchiveIcon, GridIcon, SearchIcon, SortIcon } from "./icons.js";

export function RunFilters({
  repoOptions,
  settings,
  updateSettings,
}: {
  repoOptions: string[];
  settings: BoardSettings;
  updateSettings: (updates: Partial<BoardSettings>) => void;
}) {
  const sortModeLabel = settings.sortMode === "recent-updates" ? "Recent updates" : "Started time";

  return (
    <header className="topbar">
      <span className="page-title">
        Runs
        {settings.showArchived ? <span className="page-title-meta">including archived</span> : null}
      </span>
      <span className="topbar-spacer" />
      <div className="toolbar-matrix">
        <label className="field search">
          <SearchIcon aria-hidden="true" />
          <input
            onChange={(event) => updateSettings({ search: event.target.value })}
            placeholder="Search runs"
            type="search"
            value={settings.search}
          />
        </label>

        <label className="field select">
          <span className="field-label">Repo</span>
          <select
            aria-label="Filter by repo"
            onChange={(event) => updateSettings({ repo: event.target.value })}
            value={settings.repo}
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
          aria-pressed={settings.hideEmptyColumns}
          className="icon-btn"
          onClick={() => updateSettings({ hideEmptyColumns: !settings.hideEmptyColumns })}
          title="Hide empty columns"
          type="button"
        >
          <GridIcon aria-hidden="true" />
        </button>

        <button
          aria-label="Collapse failure states"
          aria-pressed={settings.collapseFailureStates}
          className="icon-btn"
          onClick={() => updateSettings({ collapseFailureStates: !settings.collapseFailureStates })}
          title="Collapse failure states"
          type="button"
        >
          <AlertIcon aria-hidden="true" />
        </button>

        <button
          aria-label={`Board sort mode: ${sortModeLabel}. Activate to switch modes.`}
          aria-pressed={settings.sortMode === "recent-updates"}
          className="icon-btn"
          onClick={() =>
            updateSettings({
              sortMode: settings.sortMode === "started" ? "recent-updates" : "started",
            })
          }
          title={`Board sort mode: ${sortModeLabel}`}
          type="button"
        >
          <SortIcon aria-hidden="true" />
        </button>

        <button
          aria-label="Show archived runs"
          aria-pressed={settings.showArchived}
          className="icon-btn"
          onClick={() => updateSettings({ showArchived: !settings.showArchived })}
          title="Show archived runs"
          type="button"
        >
          <ArchiveIcon aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
