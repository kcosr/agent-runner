import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_TOKEN_STORAGE_KEY } from "./daemon-token.js";
import {
  DashboardSettingsProvider,
  useDaemonAuthToken,
  useDashboardPreferences,
  useDashboardViewState,
} from "./settings.js";

function SettingsProbe() {
  const { preferences, resetPreference, resetPreferences, updatePreferences } =
    useDashboardPreferences();
  const { viewState, updateViewState } = useDashboardViewState();
  const { clearDaemonToken, daemonToken, saveDaemonToken } = useDaemonAuthToken();

  return (
    <div>
      <pre data-testid="preferences">{JSON.stringify(preferences)}</pre>
      <pre data-testid="view-state">{JSON.stringify(viewState)}</pre>
      <pre data-testid="daemon-token">{daemonToken ?? ""}</pre>
      <button onClick={() => updatePreferences({ showArchived: true })} type="button">
        Enable archived
      </button>
      <button
        onClick={() =>
          updatePreferences({
            sortField: "updatedAt",
            sortDirection: "desc",
          })
        }
        type="button"
      >
        Enable updated-at sort
      </button>
      <button onClick={() => updatePreferences({ auditNewestFirst: true })} type="button">
        Enable newest-first audit
      </button>
      <button
        onClick={() =>
          updatePreferences({
            showNotesOnly: true,
          })
        }
        type="button"
      >
        Enable notes only
      </button>
      <button
        onClick={() =>
          updatePreferences({
            showPinnedOnly: true,
          })
        }
        type="button"
      >
        Enable pinned only
      </button>
      <button
        onClick={() =>
          updatePreferences({
            showScheduledOnly: true,
          })
        }
        type="button"
      >
        Enable scheduled only
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
      <button onClick={() => updatePreferences({ themeMode: "dark" })} type="button">
        Enable dark theme
      </button>
      <button onClick={() => updatePreferences({ themeMode: "light" })} type="button">
        Enable light theme
      </button>
      <button onClick={() => updatePreferences({ themeMode: "auto" })} type="button">
        Enable auto theme
      </button>
      <button
        onClick={() =>
          updateViewState({
            viewMode: "list",
            drawerWidth: 700,
            activeRightSurface: "chat",
            drawerFullscreen: true,
            search: "agent-runner-web",
            activeBoardColumnKey: "running",
            drawerViewsByRunId: {
              "run-1": {
                detailSection: "events",
              },
            },
          })
        }
        type="button"
      >
        Update view state
      </button>
      <button
        onClick={() =>
          updateViewState({
            collapsedColumnKeys: ["running"],
          })
        }
        type="button"
      >
        Collapse running
      </button>
      <button onClick={() => resetPreference("showArchived")} type="button">
        Reset archived
      </button>
      <button onClick={() => resetPreference("visibleFocusIndicators")} type="button">
        Reset focus indicators
      </button>
      <button onClick={() => resetPreference("themeMode")} type="button">
        Reset theme
      </button>
      <button onClick={() => resetPreferences()} type="button">
        Reset all preferences
      </button>
      <button
        onClick={() =>
          updatePreferences((current) => ({
            structuredFilters: {
              ...current.structuredFilters,
              runGroupId: current.structuredFilters.runGroupId === "run-root" ? null : "run-root",
            },
          }))
        }
        type="button"
      >
        Toggle group filter
      </button>
      <button onClick={() => saveDaemonToken("  saved-token  ")} type="button">
        Save daemon token
      </button>
      <button onClick={() => clearDaemonToken()} type="button">
        Clear daemon token
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
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.theme;
  });

  it("boots with default persisted preferences and default collapsed-column view state", () => {
    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent(
      JSON.stringify({
        hideEmptyColumns: true,
        collapseFailureStates: true,
        showArchived: false,
        showNotesOnly: false,
        showScheduledOnly: false,
        showPinnedOnly: false,
        sortField: "startedAt",
        sortDirection: "desc",
        auditNewestFirst: false,
        visibleFocusIndicators: false,
        themeMode: "auto",
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
          runGroupId: null,
        },
      }),
    );
    expect(screen.getByTestId("view-state")).toHaveTextContent(
      JSON.stringify({
        viewMode: "board",
        search: "",
        collapsedColumnKeys: [],
        drawerWidth: 540,
        activeRightSurface: "detail",
        drawerFullscreen: false,
        drawerViewsByRunId: {},
        activeBoardColumnKey: null,
        diffsSidebarWidth: 272,
        filesSidebarWidth: 240,
        diffsViewMode: "unified",
      }),
    );
  });

  it("hydrates only the new persisted preference shape and ignores the old board-settings key", () => {
    window.localStorage.setItem(
      "agent-runner:web:board-settings",
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
          runGroupId: null,
        },
        drawerWidth: 1200,
      }),
    );
    window.localStorage.setItem(
      "agent-runner:web:dashboard-preferences",
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
        showNotesOnly: false,
        showScheduledOnly: false,
        showPinnedOnly: false,
        sortField: "updatedAt",
        sortDirection: "desc",
        auditNewestFirst: false,
        visibleFocusIndicators: true,
        themeMode: "auto",
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
          runGroupId: null,
        },
      }),
    );
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerWidth":540');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"activeRightSurface":"detail"');
  });

  it("hydrates, saves, trims, and clears the daemon token storage key", () => {
    window.localStorage.setItem(DAEMON_TOKEN_STORAGE_KEY, "  initial-token  ");

    renderSettingsProbe();

    expect(screen.getByTestId("daemon-token")).toHaveTextContent("initial-token");

    fireEvent.click(screen.getByRole("button", { name: "Save daemon token" }));
    expect(screen.getByTestId("daemon-token")).toHaveTextContent("saved-token");
    expect(window.localStorage.getItem(DAEMON_TOKEN_STORAGE_KEY)).toBe("saved-token");

    fireEvent.click(screen.getByRole("button", { name: "Clear daemon token" }));
    expect(screen.getByTestId("daemon-token")).toHaveTextContent("");
    expect(window.localStorage.getItem(DAEMON_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("migrates the legacy recent-updates preference while keeping unsaved view-state fields transient", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-preferences",
      JSON.stringify({ sortByRecentUpdates: true }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent('"sortField":"updatedAt"');
    expect(screen.getByTestId("preferences")).toHaveTextContent('"sortDirection":"desc"');
    expect(screen.getByTestId("preferences")).not.toHaveTextContent("sortByRecentUpdates");
    expect(screen.getByTestId("preferences")).toHaveTextContent(
      '"structuredFilters":{"repo":null,"agent":null,"backend":null,"runGroupId":null}',
    );
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerWidth":540');
  });

  it("hydrates persisted dashboard surface view state", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-view-state",
      JSON.stringify({
        collapsedColumnKeys: ["running"],
        drawerWidth: 700,
        activeRightSurface: "notes",
        drawerFullscreen: true,
        viewMode: "list",
      }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("view-state")).toHaveTextContent('"viewMode":"list"');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"collapsedColumnKeys":["running"]');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerWidth":700');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"activeRightSurface":"notes"');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerFullscreen":true');
  });

  it("hydrates the persisted files dashboard surface key", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-view-state",
      JSON.stringify({
        activeRightSurface: "files",
      }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("view-state")).toHaveTextContent('"activeRightSurface":"files"');
  });

  it("defaults malformed dashboard surface view state", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-view-state",
      JSON.stringify({
        drawerWidth: Number.NaN,
        activeRightSurface: "messages",
        viewMode: "table",
      }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("view-state")).toHaveTextContent('"viewMode":"board"');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerWidth":540');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"activeRightSurface":"detail"');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerFullscreen":false');
  });

  it("hydrates persisted collapsed column keys while defaulting unsaved columns to expanded", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-view-state",
      JSON.stringify({ collapsedColumnKeys: ["running", "failed"] }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("view-state")).toHaveTextContent(
      '"collapsedColumnKeys":["running","failed"]',
    );
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerWidth":540');
  });

  it("defaults missing structured-filter categories to Any while preserving stored values", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-preferences",
      JSON.stringify({
        structuredFilters: {
          repo: "agent-runner",
        },
      }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent(
      '"structuredFilters":{"repo":"agent-runner","agent":null,"backend":null,"runGroupId":null}',
    );
  });

  it("falls back to Any for malformed stored structured-filter values", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-preferences",
      JSON.stringify({
        showArchived: true,
        structuredFilters: {
          repo: 42,
          agent: "   ",
          backend: false,
          runGroupId: [],
        },
      }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent('"showArchived":true');
    expect(screen.getByTestId("preferences")).toHaveTextContent(
      '"structuredFilters":{"repo":null,"agent":null,"backend":null,"runGroupId":null}',
    );
  });

  it("hydrates and resets visible focus indicators independently", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-preferences",
      JSON.stringify({ visibleFocusIndicators: true }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent('"visibleFocusIndicators":true');

    fireEvent.click(screen.getByRole("button", { name: "Reset focus indicators" }));

    expect(screen.getByTestId("preferences")).toHaveTextContent('"visibleFocusIndicators":false');
  });

  it("hydrates, applies, and resets the persisted theme mode", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-preferences",
      JSON.stringify({ themeMode: "dark" }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent('"themeMode":"dark"');
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    fireEvent.click(screen.getByRole("button", { name: "Enable light theme" }));
    expect(screen.getByTestId("preferences")).toHaveTextContent('"themeMode":"light"');
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    fireEvent.click(screen.getByRole("button", { name: "Enable auto theme" }));
    expect(screen.getByTestId("preferences")).toHaveTextContent('"themeMode":"auto"');
    expect(document.documentElement).not.toHaveAttribute("data-theme");

    fireEvent.click(screen.getByRole("button", { name: "Enable dark theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    fireEvent.click(screen.getByRole("button", { name: "Reset theme" }));
    expect(screen.getByTestId("preferences")).toHaveTextContent('"themeMode":"auto"');
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("falls back to Auto for malformed stored theme mode values", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-preferences",
      JSON.stringify({ themeMode: "system" }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent('"themeMode":"auto"');
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("hydrates the persisted audit sort preference", () => {
    window.localStorage.setItem(
      "agent-runner:web:dashboard-preferences",
      JSON.stringify({ auditNewestFirst: true }),
    );

    renderSettingsProbe();

    expect(screen.getByTestId("preferences")).toHaveTextContent('"auditNewestFirst":true');
  });

  it("persists preferences and collapsed column keys without persisting transient view-state updates", () => {
    renderSettingsProbe();

    fireEvent.click(screen.getByRole("button", { name: "Enable archived" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable notes only" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable scheduled only" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable pinned only" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable updated-at sort" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable visible focus indicators" }));
    fireEvent.click(screen.getByRole("button", { name: "Update view state" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse running" }));

    expect(window.localStorage.getItem("agent-runner:web:dashboard-preferences")).toBe(
      JSON.stringify({
        hideEmptyColumns: true,
        collapseFailureStates: true,
        showArchived: true,
        showNotesOnly: true,
        showScheduledOnly: true,
        showPinnedOnly: true,
        sortField: "updatedAt",
        sortDirection: "desc",
        auditNewestFirst: false,
        visibleFocusIndicators: true,
        themeMode: "auto",
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
          runGroupId: null,
        },
      }),
    );
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerWidth":700');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"search":"agent-runner-web"');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"viewMode":"list"');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"activeBoardColumnKey":"running"');
    expect(screen.getByTestId("view-state")).toHaveTextContent('"drawerViewsByRunId":{"run-1"');
    expect(window.localStorage.getItem("agent-runner:web:dashboard-view-state")).toBe(
      JSON.stringify({
        viewMode: "list",
        collapsedColumnKeys: ["running"],
        drawerWidth: 700,
        activeRightSurface: "chat",
        drawerFullscreen: true,
        diffsSidebarWidth: 272,
        filesSidebarWidth: 240,
        diffsViewMode: "unified",
      }),
    );
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
        showNotesOnly: false,
        showScheduledOnly: false,
        showPinnedOnly: false,
        sortField: "startedAt",
        sortDirection: "desc",
        auditNewestFirst: false,
        visibleFocusIndicators: false,
        themeMode: "auto",
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
          runGroupId: null,
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
        showNotesOnly: false,
        showScheduledOnly: false,
        showPinnedOnly: false,
        sortField: "startedAt",
        sortDirection: "desc",
        auditNewestFirst: false,
        visibleFocusIndicators: false,
        themeMode: "auto",
        structuredFilters: {
          repo: null,
          agent: null,
          backend: null,
          runGroupId: null,
        },
      }),
    );
  });

  it("supports functional preference updates against the latest structured-filter state", () => {
    renderSettingsProbe();

    fireEvent.click(screen.getByRole("button", { name: "Toggle group filter" }));
    expect(screen.getByTestId("preferences")).toHaveTextContent(
      '"structuredFilters":{"repo":null,"agent":null,"backend":null,"runGroupId":"run-root"}',
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle group filter" }));
    expect(screen.getByTestId("preferences")).toHaveTextContent(
      '"structuredFilters":{"repo":null,"agent":null,"backend":null,"runGroupId":null}',
    );
  });
});
