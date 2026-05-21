import type { BoardColumn } from "../components/run-column.js";
import type { DashboardViewMode } from "./settings.js";

type RunsShortcutCommand =
  | "board.moveUp"
  | "board.moveDown"
  | "board.moveLeft"
  | "board.moveRight"
  | "list.moveUp"
  | "list.moveDown"
  | "ui.toggleScheduledOnly"
  | "ui.togglePinnedOnly"
  | "ui.toggleNotesOnly"
  | "ui.toggleArchived"
  | "ui.toggleHideEmptyColumns"
  | "run.showAttachments"
  | "run.showChat"
  | "run.showDetail"
  | "run.showDiffs"
  | "run.showFiles"
  | "run.showNotes"
  | "run.showTasks"
  | "run.destructiveCleanup"
  | "run.toggleArchived"
  | "run.togglePinned"
  | "ui.toggleFilters"
  | "ui.toggleDrawerFullscreen"
  | "ui.cycleViewMode"
  | "ui.blurSearch"
  | "ui.clearStructuredFilters"
  | "run.close"
  | "run.primaryAction"
  | "ui.clearSearch"
  | "ui.focusSearch";

type SettingsShortcutCommand = "settings.close";

interface ShortcutEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

interface RunsShortcutContext {
  actionPending: boolean;
  activeBoardColumnKey: string | null;
  boardColumns: BoardColumn[];
  drawerFullscreen: boolean;
  hasActiveStructuredFilters: boolean;
  modalOpen: boolean;
  selectedRunPrimaryActionAvailable: boolean;
  resumeDialogOpen: boolean;
  searchFocused: boolean;
  searchValue: string;
  selectedRunId?: string;
  typingTarget: boolean;
  viewMode: DashboardViewMode;
}

type BoardDirection = "up" | "down" | "left" | "right";
type ListDirection = "up" | "down";

type BoardFilterShortcutCommand = Extract<
  RunsShortcutCommand,
  | "ui.toggleScheduledOnly"
  | "ui.togglePinnedOnly"
  | "ui.toggleNotesOnly"
  | "ui.toggleArchived"
  | "ui.toggleHideEmptyColumns"
>;

const BOARD_FILTER_SHORTCUTS: readonly {
  command: BoardFilterShortcutCommand;
  key: string;
}[] = [
  { command: "ui.toggleScheduledOnly", key: "s" },
  { command: "ui.togglePinnedOnly", key: "p" },
  { command: "ui.toggleNotesOnly", key: "n" },
  { command: "ui.toggleArchived", key: "a" },
  { command: "ui.toggleHideEmptyColumns", key: "e" },
];

const EDITABLE_TARGET_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest(EDITABLE_TARGET_SELECTOR)) {
    return true;
  }

  const shadowActiveElement = target.shadowRoot?.activeElement;
  return shadowActiveElement instanceof HTMLElement
    ? isEditableEventTarget(shadowActiveElement)
    : false;
}

export function isEditableKeyboardEvent(event: Event): boolean {
  return (
    event.composedPath().some((target) => isEditableEventTarget(target)) ||
    isEditableEventTarget(event.target)
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

function matchesBareLetter(event: ShortcutEventLike, key: string): boolean {
  return normalizeEventKey(event.key) === key && !event.altKey && !event.ctrlKey && !event.metaKey;
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

function canTriggerPrimaryAction(context: RunsShortcutContext): boolean {
  return (
    !context.typingTarget &&
    !context.searchFocused &&
    !context.modalOpen &&
    !context.resumeDialogOpen &&
    !context.actionPending &&
    Boolean(context.selectedRunId) &&
    context.selectedRunPrimaryActionAvailable
  );
}

function canTriggerSelectedRunShortcut(context: RunsShortcutContext): boolean {
  return (
    !context.typingTarget &&
    !context.searchFocused &&
    !context.modalOpen &&
    !context.resumeDialogOpen &&
    !context.actionPending &&
    Boolean(context.selectedRunId)
  );
}

function resolveSelectedRunShortcut(
  event: ShortcutEventLike,
  context: RunsShortcutContext,
): Extract<
  RunsShortcutCommand,
  "run.primaryAction" | "run.togglePinned" | "run.destructiveCleanup" | "run.toggleArchived"
> | null {
  if (matchesShortcut(event, { key: "enter" }) && canTriggerPrimaryAction(context)) {
    return "run.primaryAction";
  }
  if (matchesShortcut(event, { key: "p" }) && canTriggerSelectedRunShortcut(context)) {
    return "run.togglePinned";
  }
  if (
    matchesShortcut(event, { key: "d", shiftKey: true }) &&
    canTriggerSelectedRunShortcut(context)
  ) {
    return "run.destructiveCleanup";
  }
  if (
    matchesShortcut(event, { key: "a", shiftKey: true }) &&
    canTriggerSelectedRunShortcut(context)
  ) {
    return "run.toggleArchived";
  }
  return null;
}

function resolveRunSurfaceShortcut(
  event: ShortcutEventLike,
  context: RunsShortcutContext,
): Extract<
  RunsShortcutCommand,
  | "run.showAttachments"
  | "run.showChat"
  | "run.showDetail"
  | "run.showDiffs"
  | "run.showFiles"
  | "run.showNotes"
  | "run.showTasks"
> | null {
  if (
    context.typingTarget ||
    context.modalOpen ||
    context.resumeDialogOpen ||
    !context.selectedRunId
  ) {
    return null;
  }

  if (matchesShortcut(event, { key: "a" })) {
    return "run.showAttachments";
  }
  if (matchesShortcut(event, { key: "c" })) {
    return "run.showChat";
  }
  if (matchesShortcut(event, { key: "i" })) {
    return "run.showDetail";
  }
  if (matchesShortcut(event, { key: "d" })) {
    return "run.showDiffs";
  }
  if (matchesShortcut(event, { key: "f" })) {
    return "run.showFiles";
  }
  if (matchesShortcut(event, { key: "n" })) {
    return "run.showNotes";
  }
  if (matchesShortcut(event, { key: "t" })) {
    return "run.showTasks";
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

export function resolveListNeighborRunId(options: {
  direction: ListDirection;
  listRunIds: string[];
  selectedRunId?: string;
}): string | null {
  const { direction, listRunIds, selectedRunId } = options;
  if (listRunIds.length === 0) {
    return null;
  }

  if (!selectedRunId) {
    return listRunIds[0] ?? null;
  }

  const currentIndex = listRunIds.indexOf(selectedRunId);
  if (currentIndex === -1) {
    return listRunIds[0] ?? null;
  }

  const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  return listRunIds[nextIndex] ?? null;
}

export function resolveRunsShortcutCommand(
  event: ShortcutEventLike,
  context: RunsShortcutContext,
): RunsShortcutCommand | null {
  if (
    matchesShortcut(event, { key: "f", shiftKey: true }) &&
    !context.typingTarget &&
    !context.resumeDialogOpen &&
    !context.modalOpen &&
    context.selectedRunId
  ) {
    return "ui.toggleDrawerFullscreen";
  }

  const surfaceCommand = resolveRunSurfaceShortcut(event, context);
  if (surfaceCommand) {
    return surfaceCommand;
  }

  if (context.drawerFullscreen) {
    if (context.modalOpen) {
      return null;
    }
    if (normalizeEventKey(event.key) === "escape") {
      if (context.selectedRunId && !context.resumeDialogOpen) {
        return "ui.toggleDrawerFullscreen";
      }
    }
    const selectedRunCommand = resolveSelectedRunShortcut(event, context);
    if (selectedRunCommand) {
      return selectedRunCommand;
    }
    return null;
  }

  if (context.modalOpen) {
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
    if (boardFilterCommand === "ui.toggleHideEmptyColumns" && context.viewMode !== "board") {
      return null;
    }
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

  if (matchesBareLetter(event, "v") && !context.typingTarget && !context.searchFocused) {
    return "ui.cycleViewMode";
  }

  if (normalizeEventKey(event.key) === "escape") {
    if (context.searchFocused && context.searchValue.length > 0) {
      return "ui.clearSearch";
    }
    if (context.searchFocused) {
      return "ui.blurSearch";
    }
    if (context.selectedRunId) {
      return "run.close";
    }
    if (context.hasActiveStructuredFilters) {
      return "ui.clearStructuredFilters";
    }
    return null;
  }

  if (matchesShortcut(event, { key: "enter" }) && context.searchFocused) {
    return "ui.blurSearch";
  }

  if (context.typingTarget) {
    return null;
  }

  if (context.viewMode === "list") {
    if (matchesShortcut(event, { key: "arrowup" })) {
      return "list.moveUp";
    }
    if (matchesShortcut(event, { key: "arrowdown" })) {
      return "list.moveDown";
    }
    return resolveSelectedRunShortcut(event, context);
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

  return resolveSelectedRunShortcut(event, context);
}

export function resolveSettingsShortcutCommand(
  event: ShortcutEventLike,
): SettingsShortcutCommand | null {
  return normalizeEventKey(event.key) === "escape" ? "settings.close" : null;
}
