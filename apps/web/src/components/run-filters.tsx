import type { Ref, RefObject } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type {
  DashboardPreferences,
  DashboardStructuredFilters,
  DashboardViewState,
} from "../lib/settings.js";
import {
  EMPTY_DASHBOARD_STRUCTURED_FILTERS,
  hasActiveDashboardStructuredFilters,
} from "../lib/settings.js";
import { AlertIcon, ArchiveIcon, FilterIcon, GridIcon, SearchIcon } from "./icons.js";

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (!ref) {
    return;
  }

  if (typeof ref === "function") {
    ref(value);
    return;
  }

  ref.current = value;
}

export function RunFilters({
  preferences,
  filterOptions,
  filtersTriggerRef,
  openFiltersRequestVersion,
  searchInputRef,
  updatePreferences,
  updateViewState,
  viewState,
}: {
  preferences: DashboardPreferences;
  filterOptions: {
    repo: string[];
    agent: string[];
    backend: string[];
  };
  filtersTriggerRef?: Ref<HTMLButtonElement>;
  openFiltersRequestVersion?: number;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  updatePreferences: (updates: Partial<DashboardPreferences>) => void;
  updateViewState: (updates: Partial<DashboardViewState>) => void;
  viewState: DashboardViewState;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstFilterRef = useRef<HTMLSelectElement | null>(null);
  const titleId = useId();
  const panelId = useId();
  const hasActiveStructuredFilter = hasActiveDashboardStructuredFilters(
    preferences.structuredFilters,
  );

  useEffect(() => {
    if (!filtersOpen) {
      return;
    }

    firstFilterRef.current?.focus();
  }, [filtersOpen]);

  useEffect(() => {
    if (openFiltersRequestVersion === undefined || openFiltersRequestVersion === 0) {
      return;
    }

    if (filtersOpen) {
      firstFilterRef.current?.focus();
      return;
    }

    setFiltersOpen(true);
  }, [filtersOpen, openFiltersRequestVersion]);

  useEffect(() => {
    if (!filtersOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setFiltersOpen(false);
      triggerRef.current?.focus();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [filtersOpen]);

  function updateStructuredFilter(key: keyof DashboardStructuredFilters, value: string | null) {
    updatePreferences({
      structuredFilters: {
        ...preferences.structuredFilters,
        [key]: value,
      },
    });
  }

  function clearStructuredFilters() {
    updatePreferences({
      structuredFilters: EMPTY_DASHBOARD_STRUCTURED_FILTERS,
    });
  }

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

        <div className="filters-control">
          <button
            aria-controls={filtersOpen ? panelId : undefined}
            aria-expanded={filtersOpen}
            aria-haspopup="dialog"
            aria-label="Filters"
            className="field filters-trigger"
            data-active={hasActiveStructuredFilter ? "true" : undefined}
            onClick={() => setFiltersOpen((current) => !current)}
            ref={(node) => {
              triggerRef.current = node;
              assignRef(filtersTriggerRef, node);
            }}
            type="button"
          >
            <FilterIcon aria-hidden="true" />
            <span className="filters-trigger__label">Filters</span>
          </button>

          {filtersOpen ? (
            <>
              <button
                aria-label="Close filters"
                className="filters-backdrop"
                onClick={() => setFiltersOpen(false)}
                type="button"
              />
              <dialog aria-labelledby={titleId} className="filters-panel" id={panelId} open>
                <div className="filters-panel__header">
                  <div>
                    <h2 className="filters-panel__title" id={titleId}>
                      Filters
                    </h2>
                    <p className="filters-panel__copy">
                      Match exact repo, agent, and backend values from the current run list.
                    </p>
                  </div>
                  <button
                    className="btn btn--quiet"
                    disabled={!hasActiveStructuredFilter}
                    onClick={clearStructuredFilters}
                    type="button"
                  >
                    Clear all
                  </button>
                </div>

                <div className="filters-panel__body">
                  <label className="field select filters-panel__field">
                    <span className="field-label">Repo</span>
                    <select
                      onChange={(event) =>
                        updateStructuredFilter("repo", event.target.value || null)
                      }
                      ref={firstFilterRef}
                      value={preferences.structuredFilters.repo ?? ""}
                    >
                      <option value="">Any</option>
                      {filterOptions.repo.map((repo) => (
                        <option key={repo} value={repo}>
                          {repo}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field select filters-panel__field">
                    <span className="field-label">Agent</span>
                    <select
                      onChange={(event) =>
                        updateStructuredFilter("agent", event.target.value || null)
                      }
                      value={preferences.structuredFilters.agent ?? ""}
                    >
                      <option value="">Any</option>
                      {filterOptions.agent.map((agent) => (
                        <option key={agent} value={agent}>
                          {agent}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field select filters-panel__field">
                    <span className="field-label">Backend</span>
                    <select
                      onChange={(event) =>
                        updateStructuredFilter("backend", event.target.value || null)
                      }
                      value={preferences.structuredFilters.backend ?? ""}
                    >
                      <option value="">Any</option>
                      {filterOptions.backend.map((backend) => (
                        <option key={backend} value={backend}>
                          {backend}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </dialog>
            </>
          ) : null}
        </div>

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
