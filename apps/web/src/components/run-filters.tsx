import type { BoardSettings } from "../lib/settings.js";
import { ArchiveIcon, MoreIcon, SearchIcon } from "./icons.js";

export function RunFilters({
  repoOptions,
  settings,
  showOptions,
  updateSettings,
  toggleOptions,
}: {
  repoOptions: string[];
  settings: BoardSettings;
  showOptions: boolean;
  updateSettings: (updates: Partial<BoardSettings>) => void;
  toggleOptions: () => void;
}) {
  return (
    <>
      <header className="topbar">
        <span className="page-title">
          Runs
          {settings.showArchived ? (
            <span className="page-title-meta">including archived</span>
          ) : null}
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
            aria-label="Show archived runs"
            aria-pressed={settings.showArchived}
            className="icon-btn"
            onClick={() => updateSettings({ showArchived: !settings.showArchived })}
            title="Show archived runs"
            type="button"
          >
            <ArchiveIcon aria-hidden="true" />
          </button>

          <button
            aria-expanded={showOptions}
            className="icon-btn"
            onClick={toggleOptions}
            title="Board options"
            type="button"
          >
            <MoreIcon aria-hidden="true" />
          </button>
        </div>
      </header>
      {showOptions ? (
        <div className="options-panel">
          <label className="options-checkbox">
            <input
              checked={settings.hideEmptyColumns}
              onChange={(event) => updateSettings({ hideEmptyColumns: event.target.checked })}
              type="checkbox"
            />
            Hide empty columns
          </label>
          <label className="options-checkbox">
            <input
              checked={settings.collapseFailureStates}
              onChange={(event) => updateSettings({ collapseFailureStates: event.target.checked })}
              type="checkbox"
            />
            Collapse failure states
          </label>
        </div>
      ) : null}
    </>
  );
}
