import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

export interface DashboardPreferences {
  hideEmptyColumns: boolean;
  collapseFailureStates: boolean;
  showArchived: boolean;
  sortByRecentUpdates: boolean;
}

export type DashboardPreferenceKey = keyof DashboardPreferences;

export type DrawerDetailSection = "tasks" | "attachments" | "dependencies" | "timing" | "events";
export type AttachmentTab = "run" | "group";

export type RunDrawerView =
  | {
      mode: "detail";
      detailSection: DrawerDetailSection;
      attachmentId: null;
      attachmentOwnerRunId: null;
      attachmentTab: AttachmentTab;
    }
  | {
      mode: "attachment";
      detailSection: "attachments";
      attachmentId: string;
      attachmentOwnerRunId: string;
      attachmentTab: AttachmentTab;
    };

export interface DashboardViewState {
  repo: string;
  search: string;
  collapsedColumnKeys: string[];
  drawerWidth: number;
  drawerFullscreen: boolean;
  drawerViewsByRunId: Record<string, RunDrawerView>;
  activeBoardColumnKey: string | null;
}

export const DEFAULT_DRAWER_VIEW: RunDrawerView = {
  mode: "detail",
  detailSection: "tasks",
  attachmentId: null,
  attachmentOwnerRunId: null,
  attachmentTab: "run",
};

export const DRAWER_WIDTH_MIN = 360;
export const DRAWER_WIDTH_MAX = 2400;
export const DRAWER_WIDTH_DEFAULT = 540;
export const DRAWER_SIDEBAR_ALLOWANCE = 56;
export const DRAWER_BOARD_MIN = 280;

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  hideEmptyColumns: true,
  collapseFailureStates: true,
  showArchived: false,
  sortByRecentUpdates: false,
};

export const DEFAULT_DASHBOARD_VIEW_STATE: DashboardViewState = {
  repo: "all",
  search: "",
  collapsedColumnKeys: [],
  drawerWidth: DRAWER_WIDTH_DEFAULT,
  drawerFullscreen: false,
  drawerViewsByRunId: {},
  activeBoardColumnKey: null,
};

export function clampDrawerWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return DRAWER_WIDTH_DEFAULT;
  }
  return Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, Math.round(value)));
}

export function computeDrawerMaxWidth(viewportWidth: number): number {
  const available = viewportWidth - DRAWER_SIDEBAR_ALLOWANCE - DRAWER_BOARD_MIN;
  return Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, Math.round(available)));
}

const PREFERENCES_STORAGE_KEY = "task-runner:web:dashboard-preferences";

interface DashboardPreferencesContextValue {
  preferences: DashboardPreferences;
  updatePreferences: (updates: Partial<DashboardPreferences>) => void;
  resetPreferences: () => void;
  resetPreference: (key: DashboardPreferenceKey) => void;
}

interface DashboardViewStateContextValue {
  viewState: DashboardViewState;
  updateViewState: (
    updates:
      | Partial<DashboardViewState>
      | ((current: DashboardViewState) => Partial<DashboardViewState>),
  ) => void;
}

const DashboardPreferencesContext = createContext<DashboardPreferencesContextValue | null>(null);
const DashboardViewStateContext = createContext<DashboardViewStateContextValue | null>(null);

function loadDashboardPreferences(): DashboardPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_DASHBOARD_PREFERENCES;
  }

  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_DASHBOARD_PREFERENCES;
    }
    return parseStoredDashboardPreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_DASHBOARD_PREFERENCES;
  }
}

function parseStoredDashboardPreferences(value: unknown): DashboardPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_DASHBOARD_PREFERENCES;
  }

  const record = value as Record<string, unknown>;
  return {
    hideEmptyColumns:
      typeof record.hideEmptyColumns === "boolean"
        ? record.hideEmptyColumns
        : DEFAULT_DASHBOARD_PREFERENCES.hideEmptyColumns,
    collapseFailureStates:
      typeof record.collapseFailureStates === "boolean"
        ? record.collapseFailureStates
        : DEFAULT_DASHBOARD_PREFERENCES.collapseFailureStates,
    showArchived:
      typeof record.showArchived === "boolean"
        ? record.showArchived
        : DEFAULT_DASHBOARD_PREFERENCES.showArchived,
    sortByRecentUpdates:
      typeof record.sortByRecentUpdates === "boolean"
        ? record.sortByRecentUpdates
        : DEFAULT_DASHBOARD_PREFERENCES.sortByRecentUpdates,
  };
}

export function DashboardSettingsProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<DashboardPreferences>(() =>
    loadDashboardPreferences(),
  );
  const [viewState, setViewState] = useState<DashboardViewState>(DEFAULT_DASHBOARD_VIEW_STATE);

  useEffect(() => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  const preferencesValue = useMemo<DashboardPreferencesContextValue>(
    () => ({
      preferences,
      updatePreferences: (updates) => {
        setPreferences((current) => ({ ...current, ...updates }));
      },
      resetPreferences: () => {
        setPreferences(DEFAULT_DASHBOARD_PREFERENCES);
      },
      resetPreference: (key) => {
        setPreferences((current) => ({
          ...current,
          [key]: DEFAULT_DASHBOARD_PREFERENCES[key],
        }));
      },
    }),
    [preferences],
  );

  const viewStateValue = useMemo<DashboardViewStateContextValue>(
    () => ({
      viewState,
      updateViewState: (updates) => {
        setViewState((current) => ({
          ...current,
          ...(typeof updates === "function" ? updates(current) : updates),
        }));
      },
    }),
    [viewState],
  );

  return (
    <DashboardPreferencesContext.Provider value={preferencesValue}>
      <DashboardViewStateContext.Provider value={viewStateValue}>
        {children}
      </DashboardViewStateContext.Provider>
    </DashboardPreferencesContext.Provider>
  );
}

export function useDashboardPreferences() {
  const context = useContext(DashboardPreferencesContext);
  if (!context) {
    throw new Error("Dashboard preferences context is unavailable");
  }
  return context;
}

export function useDashboardViewState() {
  const context = useContext(DashboardViewStateContext);
  if (!context) {
    throw new Error("Dashboard view state context is unavailable");
  }
  return context;
}
