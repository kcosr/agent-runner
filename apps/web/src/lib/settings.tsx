import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

export interface BoardSettings {
  repo: string;
  showArchived: boolean;
  hideEmptyColumns: boolean;
  collapseFailureStates: boolean;
  search: string;
  drawerWidth: number;
}

export const DRAWER_WIDTH_MIN = 360;
export const DRAWER_WIDTH_MAX = 1200;
export const DRAWER_WIDTH_DEFAULT = 540;

export function clampDrawerWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return DRAWER_WIDTH_DEFAULT;
  }
  return Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, Math.round(value)));
}

const STORAGE_KEY = "task-runner:web:board-settings";

const DEFAULT_SETTINGS: BoardSettings = {
  repo: "all",
  showArchived: false,
  hideEmptyColumns: true,
  collapseFailureStates: true,
  search: "",
  drawerWidth: DRAWER_WIDTH_DEFAULT,
};

interface BoardSettingsContextValue {
  settings: BoardSettings;
  updateSettings: (updates: Partial<BoardSettings>) => void;
}

const BoardSettingsContext = createContext<BoardSettingsContextValue | null>(null);

function loadSettings(): BoardSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<BoardSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    return { ...merged, drawerWidth: clampDrawerWidth(merged.drawerWidth) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function BoardSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<BoardSettings>(() => loadSettings());

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const value = useMemo<BoardSettingsContextValue>(
    () => ({
      settings,
      updateSettings: (updates) => {
        setSettings((current) => ({ ...current, ...updates }));
      },
    }),
    [settings],
  );

  return <BoardSettingsContext.Provider value={value}>{children}</BoardSettingsContext.Provider>;
}

export function useBoardSettings() {
  const context = useContext(BoardSettingsContext);
  if (!context) {
    throw new Error("Board settings context is unavailable");
  }
  return context;
}
