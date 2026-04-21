import type { BoardColumn } from "../components/run-column.js";
import type { RunDrawerView } from "./settings.js";

export type RunsShortcutCommand =
  | "board.moveUp"
  | "board.moveDown"
  | "board.moveLeft"
  | "board.moveRight"
  | "ui.togglePinnedOnly"
  | "ui.toggleNotesOnly"
  | "ui.toggleArchived"
  | "ui.toggleHideEmptyColumns"
  | "run.openNote"
  | "run.toggleArchived"
  | "run.togglePinned"
  | "ui.toggleFilters"
  | "ui.toggleDrawerFullscreen"
  | "ui.blurSearch"
  | "run.close"
  | "run.closeAttachmentPreview"
  | "run.primaryAction"
  | "ui.clearSearch"
  | "ui.focusSearch";

export type SettingsShortcutCommand = "settings.close";

export type ShortcutCommand = RunsShortcutCommand | SettingsShortcutCommand;

export interface ShortcutEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface RunsShortcutContext {
  activeBoardColumnKey: string | null;
  boardColumns: BoardColumn[];
  drawerFullscreen: boolean;
  modalOpen: boolean;
  selectedRunPrimaryActionAvailable: boolean;
  resumeDialogOpen: boolean;
  searchFocused: boolean;
  searchValue: string;
  selectedDrawerView?: RunDrawerView;
  selectedRunId?: string;
  typingTarget: boolean;
}

export type BoardDirection = "up" | "down" | "left" | "right";

type BoardFilterShortcutCommand = Extract<
  RunsShortcutCommand,
  "ui.togglePinnedOnly" | "ui.toggleNotesOnly" | "ui.toggleArchived" | "ui.toggleHideEmptyColumns"
>;

const BOARD_FILTER_SHORTCUTS: readonly {
  command: BoardFilterShortcutCommand;
  key: string;
}[] = [
  { command: "ui.togglePinnedOnly", key: "p" },
  { command: "ui.toggleNotesOnly", key: "n" },
  { command: "ui.toggleArchived", key: "a" },
  { command: "ui.toggleHideEmptyColumns", key: "e" },
];

export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'),
  );
}

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") {
    return "escape";
  }
  return normalized;
}

function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: {
    ctrlKey?: boolean;
    key: string;
    metaKey?: boolean;
    shiftKey?: boolean;
  },
): boolean {
  return (
    normalizeEventKey(event.key) === shortcut.key &&
    event.ctrlKey === Boolean(shortcut.ctrlKey) &&
    event.metaKey === Boolean(shortcut.metaKey) &&
    event.shiftKey === Boolean(shortcut.shiftKey) &&
    event.altKey === false
  );
}

function firstRunIdInColumn(column: BoardColumn | undefined): string | null {
  return column?.runs[0]?.runId ?? null;
}

function resolveBoardFilterShortcut(
  event: ShortcutEventLike,
  context: Pick<RunsShortcutContext, "resumeDialogOpen" | "typingTarget">,
): BoardFilterShortcutCommand | null {
  if (context.typingTarget || context.resumeDialogOpen) {
    return null;
  }

  for (const shortcut of BOARD_FILTER_SHORTCUTS) {
    if (
      matchesShortcut(event, { ctrlKey: true, key: shortcut.key, shiftKey: true }) ||
      matchesShortcut(event, { key: shortcut.key, metaKey: true, shiftKey: true })
    ) {
      return shortcut.command;
    }
  }

  return null;
}

export function resolveBoardEntryRunId(
  boardColumns: BoardColumn[],
  activeBoardColumnKey: string | null,
): string | null {
  if (activeBoardColumnKey) {
    const activeColumn = boardColumns.find(
      (column) => column.key === activeBoardColumnKey && column.runs.length > 0,
    );
    const activeRunId = firstRunIdInColumn(activeColumn);
    if (activeRunId) {
      return activeRunId;
    }
  }
  return firstRunIdInColumn(boardColumns.find((column) => column.runs.length > 0));
}

export function resolveBoardNeighborRunId(options: {
  activeBoardColumnKey: string | null;
  boardColumns: BoardColumn[];
  direction: BoardDirection;
  selectedRunId?: string;
}): string | null {
  const { activeBoardColumnKey, boardColumns, direction, selectedRunId } = options;
  const positions = new Map<string, { columnIndex: number; runIndex: number }>();
  boardColumns.forEach((column, columnIndex) => {
    column.runs.forEach((run, runIndex) => {
      positions.set(run.runId, { columnIndex, runIndex });
    });
  });

  if (!selectedRunId || !positions.has(selectedRunId)) {
    return resolveBoardEntryRunId(boardColumns, activeBoardColumnKey);
  }

  const position = positions.get(selectedRunId);
  if (!position) {
    return null;
  }

  const currentColumn = boardColumns[position.columnIndex];
  if (!currentColumn) {
    return null;
  }

  if (direction === "up") {
    return currentColumn.runs[position.runIndex - 1]?.runId ?? null;
  }

  if (direction === "down") {
    return currentColumn.runs[position.runIndex + 1]?.runId ?? null;
  }

  const step = direction === "left" ? -1 : 1;
  for (
    let columnIndex = position.columnIndex + step;
    columnIndex >= 0 && columnIndex < boardColumns.length;
    columnIndex += step
  ) {
    const candidateColumn = boardColumns[columnIndex];
    if (!candidateColumn || candidateColumn.runs.length === 0) {
      continue;
    }
    const candidateRunIndex = Math.min(position.runIndex, candidateColumn.runs.length - 1);
    return candidateColumn.runs[candidateRunIndex]?.runId ?? null;
  }

  return null;
}

export function resolveRunsShortcutCommand(
  event: ShortcutEventLike,
  context: RunsShortcutContext,
): RunsShortcutCommand | null {
  if (
    matchesShortcut(event, { key: "f" }) &&
    !context.typingTarget &&
    !context.resumeDialogOpen &&
    context.selectedRunId
  ) {
    return "ui.toggleDrawerFullscreen";
  }

  if (context.drawerFullscreen) {
    if (normalizeEventKey(event.key) === "escape") {
      if (context.selectedRunId) {
        return "ui.toggleDrawerFullscreen";
      }
    }
    return null;
  }

  if (
    matchesShortcut(event, { ctrlKey: true, key: "f", shiftKey: true }) ||
    matchesShortcut(event, { key: "f", metaKey: true, shiftKey: true })
  ) {
    return context.typingTarget || context.resumeDialogOpen ? null : "ui.toggleFilters";
  }

  const boardFilterCommand = resolveBoardFilterShortcut(event, context);
  if (boardFilterCommand) {
    return boardFilterCommand;
  }

  if (
    matchesShortcut(event, { ctrlKey: true, key: "f" }) ||
    matchesShortcut(event, { metaKey: true, key: "f" })
  ) {
    return context.typingTarget ? null : "ui.focusSearch";
  }

  if (context.resumeDialogOpen) {
    return null;
  }

  if (normalizeEventKey(event.key) === "escape") {
    if (context.searchFocused && context.searchValue.length > 0) {
      return "ui.clearSearch";
    }
    if (context.searchFocused) {
      return "ui.blurSearch";
    }
    if (context.selectedDrawerView?.mode === "attachment") {
      return "run.closeAttachmentPreview";
    }
    if (context.selectedRunId) {
      return "run.close";
    }
    return null;
  }

  if (matchesShortcut(event, { key: "enter" }) && context.searchFocused) {
    return "ui.blurSearch";
  }

  if (context.typingTarget) {
    return null;
  }

  if (context.modalOpen) {
    return null;
  }

  if (matchesShortcut(event, { key: "arrowup" })) {
    return "board.moveUp";
  }
  if (matchesShortcut(event, { key: "arrowdown" })) {
    return "board.moveDown";
  }
  if (matchesShortcut(event, { key: "arrowleft" })) {
    return "board.moveLeft";
  }
  if (matchesShortcut(event, { key: "arrowright" })) {
    return "board.moveRight";
  }
  if (
    matchesShortcut(event, { key: "enter" }) &&
    context.selectedRunId &&
    context.selectedRunPrimaryActionAvailable
  ) {
    return "run.primaryAction";
  }
  if (matchesShortcut(event, { key: "n" }) && context.selectedRunId) {
    return "run.openNote";
  }
  if (matchesShortcut(event, { key: "p" }) && context.selectedRunId) {
    return "run.togglePinned";
  }
  if (matchesShortcut(event, { key: "a" }) && context.selectedRunId) {
    return "run.toggleArchived";
  }

  return null;
}

export function resolveSettingsShortcutCommand(
  event: ShortcutEventLike,
): SettingsShortcutCommand | null {
  return normalizeEventKey(event.key) === "escape" ? "settings.close" : null;
}
