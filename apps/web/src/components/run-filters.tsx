import type { RefObject } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  DashboardPreferences,
  DashboardStructuredFilters,
  DashboardViewState,
} from "../lib/settings.js";
import {
  EMPTY_DASHBOARD_STRUCTURED_FILTERS,
  hasActiveDashboardStructuredFilters,
} from "../lib/settings.js";
import {
  AlertIcon,
  ArchiveIcon,
  ChevronsRightLeftIcon,
  FilterIcon,
  NotepadTextIcon,
  PinIcon,
  SearchIcon,
} from "./icons.js";

export function RunFilters({
  preferences,
  filterOptions,
  toggleFiltersVersion,
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
  toggleFiltersVersion?: number;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  updatePreferences: (updates: Partial<DashboardPreferences>) => void;
  updateViewState: (updates: Partial<DashboardViewState>) => void;
  viewState: DashboardViewState;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstFilterRef = useRef<HTMLSelectElement | null>(null);
  const lastHandledToggleVersionRef = useRef(toggleFiltersVersion ?? 0);
  const titleId = useId();
  const panelId = useId();
  const hasActiveStructuredFilter = hasActiveDashboardStructuredFilters(
    preferences.structuredFilters,
  );

  const closeFilters = useCallback(({ focusTrigger = false }: { focusTrigger?: boolean } = {}) => {
    setFiltersOpen(false);
    if (!focusTrigger) {
      return;
    }
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (!filtersOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      firstFilterRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [filtersOpen]);

  useEffect(() => {
    if (toggleFiltersVersion === undefined || toggleFiltersVersion === 0) {
      return;
    }

    if (toggleFiltersVersion <= lastHandledToggleVersionRef.current) {
      return;
    }

    lastHandledToggleVersionRef.current = toggleFiltersVersion;

    if (filtersOpen) {
      closeFilters({ focusTrigger: true });
      return;
    }

    setFiltersOpen(true);
  }, [closeFilters, filtersOpen, toggleFiltersVersion]);

  useEffect(() => {
    if (!filtersOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const toggleShortcut =
        ((event.ctrlKey && !event.metaKey) || (!event.ctrlKey && event.metaKey)) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f";

      if (!toggleShortcut && event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      closeFilters({ focusTrigger: true });
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [closeFilters, filtersOpen]);

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
        {preferences.showNotesOnly ? <span className="page-title-meta">notes only</span> : null}
        {preferences.showPinnedOnly ? <span className="page-title-meta">pinned only</span> : null}
        {preferences.structuredFilters.family ? (
          <span className="page-title-meta">family {preferences.structuredFilters.family}</span>
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
            className="icon-btn filters-trigger"
            data-active={hasActiveStructuredFilter ? "true" : undefined}
            onClick={() => setFiltersOpen((current) => !current)}
            ref={triggerRef}
            title="Filters"
            type="button"
          >
            <FilterIcon aria-hidden="true" />
          </button>

          {filtersOpen ? (
            <>
              <button
                aria-label="Close filters"
                className="filters-backdrop"
                onClick={() => closeFilters()}
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
                    Clear
                  </button>
                </div>

                <div className="filters-panel__body">
                  <div className="filters-panel__field">
                    <div aria-hidden="true" className="field filters-panel__field-label">
                      <span className="field-label">Family</span>
                    </div>
                    <label className="field filters-panel__field-control">
                      <input
                        aria-label="Family"
                        readOnly
                        value={preferences.structuredFilters.family ?? "Any"}
                      />
                    </label>
                  </div>

                  <div className="filters-panel__field">
                    <div aria-hidden="true" className="field filters-panel__field-label">
                      <span className="field-label">Repo</span>
                    </div>
                    <label className="field select filters-panel__field-control">
                      <select
                        aria-label="Repo"
                        onChange={(event) =>
                          updateStructuredFilter("repo", event.target.value || null)
                        }
                        ref={firstFilterRef}
                        value={preferences.structuredFilters.repo ?? ""}
                      >
                        <option value="" />
                        {filterOptions.repo.map((repo) => (
                          <option key={repo} value={repo}>
                            {repo}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="filters-panel__field">
                    <div aria-hidden="true" className="field filters-panel__field-label">
                      <span className="field-label">Agent</span>
                    </div>
                    <label className="field select filters-panel__field-control">
                      <select
                        aria-label="Agent"
                        onChange={(event) =>
                          updateStructuredFilter("agent", event.target.value || null)
                        }
                        value={preferences.structuredFilters.agent ?? ""}
                      >
                        <option value="" />
                        {filterOptions.agent.map((agent) => (
                          <option key={agent} value={agent}>
                            {agent}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="filters-panel__field">
                    <div aria-hidden="true" className="field filters-panel__field-label">
                      <span className="field-label">Backend</span>
                    </div>
                    <label className="field select filters-panel__field-control">
                      <select
                        aria-label="Backend"
                        onChange={(event) =>
                          updateStructuredFilter("backend", event.target.value || null)
                        }
                        value={preferences.structuredFilters.backend ?? ""}
                      >
                        <option value="" />
                        {filterOptions.backend.map((backend) => (
                          <option key={backend} value={backend}>
                            {backend}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
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
          <ChevronsRightLeftIcon aria-hidden="true" />
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
          aria-label="Show pinned runs only"
          aria-pressed={preferences.showPinnedOnly}
          className="icon-btn"
          onClick={() => updatePreferences({ showPinnedOnly: !preferences.showPinnedOnly })}
          title="Show pinned runs only"
          type="button"
        >
          <PinIcon aria-hidden="true" />
        </button>

        <button
          aria-label="Show runs with notes only"
          aria-pressed={preferences.showNotesOnly}
          className="icon-btn"
          onClick={() => updatePreferences({ showNotesOnly: !preferences.showNotesOnly })}
          title="Show runs with notes only"
          type="button"
        >
          <NotepadTextIcon aria-hidden="true" />
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
