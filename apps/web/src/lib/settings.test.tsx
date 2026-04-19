import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DashboardSettingsProvider,
  useDashboardPreferences,
  useDashboardViewState,
} from "./settings.js";

function SettingsProbe() {
  const { preferences, resetPreference, resetPreferences, updatePreferences } =
    useDashboardPreferences();
  const { viewState, updateViewState } = useDashboardViewState();

  return (
    <div>
      <pre data-testid="preferences">{JSON.stringify(preferences)}</pre>
      <pre data-testid="view-state">{JSON.stringify(viewState)}</pre>
      <button onClick={() => updatePreferences({ showArchived: true })} type="button">
        Enable archived
      </button>
      <button
        onClick={() =>
          updatePreferences({
            sortByRecentUpdates: true,
          })
        }
        type="button"
      >
        Enable recent updates sort
      </button>
      <button
        onClick={() =>
          updatePreferences({
            visibleFocusIndicators: true,
          })
        }
        type="button"
      >
        Enable visible focus indicators
      </button>
      <button
        onClick={() =>
          updateViewState({
            drawerWidth: 700,
            search: "task-runner-web",
          })
        }
        type="button"
      >
        Update view state
      </button>
      <button onClick={() => resetPreference("showArchived")} type="button">
        Reset archived
      </button>
      <button onClick={() => resetPreference("visibleFocusIndicators")} type="button">
        Reset focus indicators
      </button>
      <button onClick={() => resetPreferences()} type="button">
        Reset all preferences
      </button>
    </div>
  );
}

function renderSettingsProbe() {
  return render(
    <DashboardSettingsProvider>
      <SettingsProbe />
    </DashboardSettingsProvider>,
  );
}

describe("DashboardSettingsProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("boots with default persisted preferences and transient view state", () => {
    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent(
      JSON.stringify({
        hideEmptyColumns: true,
        collapseFailureStates: true,
        showArchived: false,
        sortByRecentUpdates: false,
        visibleFocusIndicators: false,
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
        },
      }),
    );
    expect(screen.getByTestId("view-state")).toHaveTextContent(
      JSON.stringify({
        search: "",
        collapsedColumnKeys: [],
        drawerWidth: 540,
        drawerFullscreen: false,
        drawerViewsByRunId: {},
        activeBoardColumnKey: null,
      }),
    );
  });

  it("hydrates only the new persisted preference shape and ignores the old board-settings key", () => {
    window.localStorage.setItem(
      "task-runner:web:board-settings",
      JSON.stringify({
        showArchived: true,
        hideEmptyColumns: false,
        collapseFailureStates: false,
        sortByRecentUpdates: true,
        visibleFocusIndicators: true,
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
        },
        drawerWidth: 1200,
      }),
    );
    window.localStorage.setItem(
      "task-runner:web:dashboard-preferences",
      JSON.stringify({
        showArchived: true,
        hideEmptyColumns: false,
        collapseFailureStates: false,
        sortByRecentUpdates: true,
        visibleFocusIndicators: true,
      }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent(
      JSON.stringify({
        hideEmptyColumns: false,
        collapseFailureStates: false,
        showArchived: true,
        sortByRecentUpdates: true,
        visibleFocusIndicators: true,
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
        },
      }),
    );
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerWidth":540');
  });

  it("hydrates the persisted recent-updates preference while keeping view-state fields transient", () => {
    window.localStorage.setItem(
      "task-runner:web:dashboard-preferences",
      JSON.stringify({ sortByRecentUpdates: true }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent('"sortByRecentUpdates":true');
    expect(screen.getByTestId("preferences")).toHaveTextContent(
      '"structuredFilters":{"repo":null,"agent":null,"backend":null}',
    );
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerWidth":540');
  });

  it("defaults missing structured-filter categories to Any while preserving stored values", () => {
    window.localStorage.setItem(
      "task-runner:web:dashboard-preferences",
      JSON.stringify({
        structuredFilters: {
          repo: "task-runner",
        },
      }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent(
      '"structuredFilters":{"repo":"task-runner","agent":null,"backend":null}',
    );
  });

  it("falls back to Any for malformed stored structured-filter values", () => {
    window.localStorage.setItem(
      "task-runner:web:dashboard-preferences",
      JSON.stringify({
        showArchived: true,
        structuredFilters: {
          repo: 42,
          agent: "   ",
          backend: false,
        },
      }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent('"showArchived":true');
    expect(screen.getByTestId("preferences")).toHaveTextContent(
      '"structuredFilters":{"repo":null,"agent":null,"backend":null}',
    );
  });

  it("hydrates and resets visible focus indicators independently", () => {
    window.localStorage.setItem(
      "task-runner:web:dashboard-preferences",
      JSON.stringify({ visibleFocusIndicators: true }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent('"visibleFocusIndicators":true');

    fireEvent.click(screen.getByRole("button", { name: "Reset focus indicators" }));

    expect(screen.getByTestId("preferences")).toHaveTextContent('"visibleFocusIndicators":false');
  });

  it("persists preferences without persisting transient view-state updates", () => {
    renderSettingsProbe();

    fireEvent.click(screen.getByRole("button", { name: "Enable archived" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable recent updates sort" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable visible focus indicators" }));
    fireEvent.click(screen.getByRole("button", { name: "Update view state" }));

    expect(window.localStorage.getItem("task-runner:web:dashboard-preferences")).toBe(
      JSON.stringify({
        hideEmptyColumns: true,
        collapseFailureStates: true,
        showArchived: true,
        sortByRecentUpdates: true,
        visibleFocusIndicators: true,
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
        },
      }),
    );
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerWidth":700');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"search":"task-runner-web"');
  });

  it("resets a single preference without affecting the others", () => {
    renderSettingsProbe();

    fireEvent.click(screen.getByRole("button", { name: "Enable archived" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset archived" }));

    expect(screen.getByTestId("preferences")).toHaveTextContent(
      JSON.stringify({
        hideEmptyColumns: true,
        collapseFailureStates: true,
        showArchived: false,
        sortByRecentUpdates: false,
        visibleFocusIndicators: false,
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
        },
      }),
    );
  });

  it("resets all preferences to the defaults", () => {
    renderSettingsProbe();

    fireEvent.click(screen.getByRole("button", { name: "Enable archived" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset all preferences" }));

    expect(screen.getByTestId("preferences")).toHaveTextContent(
      JSON.stringify({
        hideEmptyColumns: true,
        collapseFailureStates: true,
        showArchived: false,
        sortByRecentUpdates: false,
        visibleFocusIndicators: false,
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
        },
      }),
    );
  });
});
