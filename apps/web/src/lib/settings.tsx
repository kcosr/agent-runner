import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  type DashboardSortDirection,
  type DashboardSortField,
  isDashboardSortDirection,
  isDashboardSortField,
} from "./run-order.js";

export type { DashboardSortDirection, DashboardSortField };

export interface DashboardPreferences {
  hideEmptyColumns: boolean;
  collapseFailureStates: boolean;
  showArchived: boolean;
  showNotesOnly: boolean;
  showScheduledOnly: boolean;
  showPinnedOnly: boolean;
  sortField: DashboardSortField;
  sortDirection: DashboardSortDirection;
  auditNewestFirst: boolean;
  visibleFocusIndicators: boolean;
  structuredFilters: DashboardStructuredFilters;
}

export type DashboardPreferenceKey = keyof DashboardPreferences;

export interface DashboardStructuredFilters {
  repo: string | null;
  agent: string | null;
  backend: string | null;
  runGroupId: string | null;
}

export const EMPTY_DASHBOARD_STRUCTURED_FILTERS: DashboardStructuredFilters = {
  repo: null,
  agent: null,
  backend: null,
  runGroupId: null,
};

export type DrawerDetailSection = "attachments" | "dependencies" | "audit" | "events" | "data";

export type RunDrawerView =
  | {
      mode: "detail";
      detailSection: DrawerDetailSection;
      attachmentId: null;
      attachmentOwnerRunId: null;
    }
  | {
      mode: "attachment";
      detailSection: "attachments";
      attachmentId: string;
      attachmentOwnerRunId: string;
    };

export type DashboardRightSurface = "detail" | "chat" | "notes" | "tasks";

export interface DashboardViewState {
  search: string;
  collapsedColumnKeys: string[];
  drawerWidth: number;
  activeRightSurface: DashboardRightSurface;
  drawerFullscreen: boolean;
  drawerViewsByRunId: Record<string, RunDrawerView>;
  activeBoardColumnKey: string | null;
}

export const DEFAULT_DRAWER_VIEW: RunDrawerView = {
  mode: "detail",
  detailSection: "attachments",
  attachmentId: null,
  attachmentOwnerRunId: null,
};

export const DRAWER_WIDTH_MIN = 360;
const DRAWER_WIDTH_MAX = 2400;
const DRAWER_WIDTH_DEFAULT = 540;
const DRAWER_SIDEBAR_ALLOWANCE = 56;
const DRAWER_BOARD_MIN = 280;

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
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
  structuredFilters: EMPTY_DASHBOARD_STRUCTURED_FILTERS,
};

const DEFAULT_DASHBOARD_VIEW_STATE: DashboardViewState = {
  search: "",
  collapsedColumnKeys: [],
  drawerWidth: DRAWER_WIDTH_DEFAULT,
  activeRightSurface: "detail",
  drawerFullscreen: false,
  drawerViewsByRunId: {},
  activeBoardColumnKey: null,
};

function clampDrawerWidth(value: number): number {
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
const VIEW_STATE_STORAGE_KEY = "task-runner:web:dashboard-view-state";

interface DashboardPreferencesContextValue {
  preferences: DashboardPreferences;
  updatePreferences: (
    updates:
      | Partial<DashboardPreferences>
      | ((current: DashboardPreferences) => Partial<DashboardPreferences>),
  ) => void;
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

function loadDashboardViewState(): DashboardViewState {
  if (typeof window === "undefined") {
    return DEFAULT_DASHBOARD_VIEW_STATE;
  }

  try {
    const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_DASHBOARD_VIEW_STATE;
    }
    return parseStoredDashboardViewState(JSON.parse(raw));
  } catch {
    return DEFAULT_DASHBOARD_VIEW_STATE;
  }
}

function parseStoredDashboardPreferences(value: unknown): DashboardPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_DASHBOARD_PREFERENCES;
  }

  const record = value as Record<string, unknown>;
  const legacySortByRecentUpdates =
    typeof record.sortByRecentUpdates === "boolean" ? record.sortByRecentUpdates : undefined;
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
    showNotesOnly:
      typeof record.showNotesOnly === "boolean"
        ? record.showNotesOnly
        : DEFAULT_DASHBOARD_PREFERENCES.showNotesOnly,
    showScheduledOnly:
      typeof record.showScheduledOnly === "boolean"
        ? record.showScheduledOnly
        : DEFAULT_DASHBOARD_PREFERENCES.showScheduledOnly,
    showPinnedOnly:
      typeof record.showPinnedOnly === "boolean"
        ? record.showPinnedOnly
        : DEFAULT_DASHBOARD_PREFERENCES.showPinnedOnly,
    sortField: isDashboardSortField(record.sortField)
      ? record.sortField
      : legacySortByRecentUpdates === true
        ? "updatedAt"
        : DEFAULT_DASHBOARD_PREFERENCES.sortField,
    sortDirection: isDashboardSortDirection(record.sortDirection)
      ? record.sortDirection
      : DEFAULT_DASHBOARD_PREFERENCES.sortDirection,
    auditNewestFirst:
      typeof record.auditNewestFirst === "boolean"
        ? record.auditNewestFirst
        : DEFAULT_DASHBOARD_PREFERENCES.auditNewestFirst,
    visibleFocusIndicators:
      typeof record.visibleFocusIndicators === "boolean"
        ? record.visibleFocusIndicators
        : DEFAULT_DASHBOARD_PREFERENCES.visibleFocusIndicators,
    structuredFilters: parseStoredStructuredFilters(record.structuredFilters),
  };
}

function parseStoredStructuredFilters(value: unknown): DashboardStructuredFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_DASHBOARD_STRUCTURED_FILTERS;
  }

  const record = value as Record<string, unknown>;
  return {
    repo: parseStoredStructuredFilterValue(record.repo),
    agent: parseStoredStructuredFilterValue(record.agent),
    backend: parseStoredStructuredFilterValue(record.backend),
    runGroupId: parseStoredStructuredFilterValue(record.runGroupId),
  };
}

function parseStoredStructuredFilterValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseStoredDashboardViewState(value: unknown): DashboardViewState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_DASHBOARD_VIEW_STATE;
  }

  const record = value as Record<string, unknown>;
  return {
    ...DEFAULT_DASHBOARD_VIEW_STATE,
    drawerWidth:
      typeof record.drawerWidth === "number"
        ? clampDrawerWidth(record.drawerWidth)
        : DEFAULT_DASHBOARD_VIEW_STATE.drawerWidth,
    activeRightSurface:
      record.activeRightSurface === "detail" ||
      record.activeRightSurface === "chat" ||
      record.activeRightSurface === "notes" ||
      record.activeRightSurface === "tasks"
        ? record.activeRightSurface
        : DEFAULT_DASHBOARD_VIEW_STATE.activeRightSurface,
    collapsedColumnKeys: Array.isArray(record.collapsedColumnKeys)
      ? record.collapsedColumnKeys.filter((key): key is string => typeof key === "string")
      : DEFAULT_DASHBOARD_VIEW_STATE.collapsedColumnKeys,
  };
}

export function hasActiveDashboardStructuredFilters(
  structuredFilters: DashboardStructuredFilters,
): boolean {
  return (
    structuredFilters.repo !== null ||
    structuredFilters.agent !== null ||
    structuredFilters.backend !== null ||
    structuredFilters.runGroupId !== null
  );
}

export function toggleDashboardStructuredFilter(
  structuredFilters: DashboardStructuredFilters,
  key: keyof DashboardStructuredFilters,
  value: string,
): DashboardStructuredFilters {
  return {
    ...structuredFilters,
    [key]: structuredFilters[key] === value ? null : value,
  };
}

export function DashboardSettingsProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<DashboardPreferences>(() =>
    loadDashboardPreferences(),
  );
  const [viewState, setViewState] = useState<DashboardViewState>(() => loadDashboardViewState());

  useEffect(() => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    window.localStorage.setItem(
      VIEW_STATE_STORAGE_KEY,
      JSON.stringify({
        collapsedColumnKeys: viewState.collapsedColumnKeys,
        drawerWidth: viewState.drawerWidth,
        activeRightSurface: viewState.activeRightSurface,
      }),
    );
  }, [viewState.activeRightSurface, viewState.collapsedColumnKeys, viewState.drawerWidth]);

  const preferencesValue = useMemo<DashboardPreferencesContextValue>(
    () => ({
      preferences,
      updatePreferences: (updates) => {
        setPreferences((current) => ({
          ...current,
          ...(typeof updates === "function" ? updates(current) : updates),
        }));
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
