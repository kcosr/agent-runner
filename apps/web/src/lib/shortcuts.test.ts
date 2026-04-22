import { describe, expect, it } from "vitest";
import type { BoardColumn } from "../components/run-column.js";
import {
  resolveBoardEntryRunId,
  resolveBoardNeighborRunId,
  resolveRunsShortcutCommand,
} from "./shortcuts.js";

function makeBoardColumns(): BoardColumn[] {
  return [
    {
      key: "pending",
      runs: [{ runId: "run-pending-1" }, { runId: "run-pending-2" }] as BoardColumn["runs"],
      statuses: ["initialized"],
      title: "Pending",
    },
    {
      key: "running",
      runs: [{ runId: "run-running-1" }] as BoardColumn["runs"],
      statuses: ["running"],
      title: "Running",
    },
    {
      key: "completed",
      runs: [{ runId: "run-completed-1" }, { runId: "run-completed-2" }] as BoardColumn["runs"],
      statuses: ["success"],
      title: "Completed",
    },
  ];
}

describe("resolveBoardEntryRunId", () => {
  it("prefers the active board column and falls back to the first non-empty column", () => {
    const boardColumns = makeBoardColumns();
    expect(resolveBoardEntryRunId(boardColumns, "running")).toBe("run-running-1");
    expect(resolveBoardEntryRunId(boardColumns, "missing")).toBe("run-pending-1");
  });
});

describe("resolveBoardNeighborRunId", () => {
  it("enters navigation using the active column when nothing is selected", () => {
    expect(
      resolveBoardNeighborRunId({
        activeBoardColumnKey: "completed",
        boardColumns: makeBoardColumns(),
        direction: "right",
      }),
    ).toBe("run-completed-1");
  });

  it("moves vertically within a column and horizontally to adjacent columns", () => {
    const boardColumns = makeBoardColumns();
    expect(
      resolveBoardNeighborRunId({
        activeBoardColumnKey: null,
        boardColumns,
        direction: "down",
        selectedRunId: "run-pending-1",
      }),
    ).toBe("run-pending-2");
    expect(
      resolveBoardNeighborRunId({
        activeBoardColumnKey: null,
        boardColumns,
        direction: "right",
        selectedRunId: "run-pending-2",
      }),
    ).toBe("run-running-1");
    expect(
      resolveBoardNeighborRunId({
        activeBoardColumnKey: null,
        boardColumns,
        direction: "right",
        selectedRunId: "run-running-1",
      }),
    ).toBe("run-completed-1");
    expect(
      resolveBoardNeighborRunId({
        activeBoardColumnKey: null,
        boardColumns,
        direction: "left",
        selectedRunId: "run-completed-2",
      }),
    ).toBe("run-running-1");
  });

  it("returns null at movement edges", () => {
    const boardColumns = makeBoardColumns();
    expect(
      resolveBoardNeighborRunId({
        activeBoardColumnKey: null,
        boardColumns,
        direction: "up",
        selectedRunId: "run-pending-1",
      }),
    ).toBeNull();
    expect(
      resolveBoardNeighborRunId({
        activeBoardColumnKey: null,
        boardColumns,
        direction: "right",
        selectedRunId: "run-completed-2",
      }),
    ).toBeNull();
  });
});

describe("resolveRunsShortcutCommand", () => {
  const context = {
    activeBoardColumnKey: "running",
    boardColumns: makeBoardColumns(),
    drawerFullscreen: false,
    hasActiveStructuredFilters: false,
    modalOpen: false,
    resumeDialogOpen: false,
    searchFocused: false,
    searchValue: "",
    selectedRunPrimaryActionAvailable: true,
    selectedDrawerView: undefined,
    selectedRunId: "run-running-1",
    typingTarget: false,
  } as const;

  it("maps global navigation and focus shortcuts", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "ArrowLeft",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("board.moveLeft");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "f",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("ui.focusSearch");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "f",
          metaKey: false,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.toggleFilters");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "p",
          metaKey: false,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.togglePinnedOnly");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "n",
          metaKey: false,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.toggleNotesOnly");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "a",
          metaKey: false,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.toggleArchived");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "e",
          metaKey: false,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.toggleHideEmptyColumns");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "f",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("ui.toggleDrawerFullscreen");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "n",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.openNote");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "p",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.togglePinned");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "a",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.toggleArchived");
  });

  it("supports the Cmd+Shift filter namespace while leaving plain letter shortcuts on run actions", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "p",
          metaKey: true,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.togglePinnedOnly");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "n",
          metaKey: true,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.toggleNotesOnly");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "a",
          metaKey: true,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.toggleArchived");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "e",
          metaKey: true,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.toggleHideEmptyColumns");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "n",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.openNote");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "p",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.togglePinned");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "a",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.toggleArchived");
  });

  it("prioritizes search clearing before route close on Escape", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Escape",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          searchFocused: true,
          searchValue: "dashboard",
        },
      ),
    ).toBe("ui.clearSearch");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Escape",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          searchFocused: true,
        },
      ),
    ).toBe("ui.blurSearch");
  });

  it("uses bare-board Escape as a final fallback to clear active structured filters", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Escape",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          hasActiveStructuredFilters: true,
          selectedRunId: undefined,
        },
      ),
    ).toBe("ui.clearStructuredFilters");
  });

  it("blurs a focused search on Enter without triggering run actions", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Enter",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          searchFocused: true,
          typingTarget: true,
        },
      ),
    ).toBe("ui.blurSearch");
  });

  it("blocks board commands while typing or when a resume dialog is open", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "f",
          metaKey: false,
          shiftKey: true,
        },
        {
          ...context,
          typingTarget: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "p",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          drawerFullscreen: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "n",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          typingTarget: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "ArrowRight",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          typingTarget: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Enter",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          resumeDialogOpen: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "f",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          resumeDialogOpen: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "p",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          resumeDialogOpen: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "n",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          modalOpen: true,
        },
      ),
    ).toBeNull();
  });

  it("blocks non-Escape dashboard shortcuts while the drawer is fullscreen except fullscreen toggle", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "ArrowRight",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          drawerFullscreen: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "f",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          drawerFullscreen: true,
        },
      ),
    ).toBe("ui.toggleDrawerFullscreen");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "f",
          metaKey: false,
          shiftKey: true,
        },
        {
          ...context,
          drawerFullscreen: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "f",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          drawerFullscreen: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Enter",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          drawerFullscreen: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Escape",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          drawerFullscreen: true,
        },
      ),
    ).toBe("ui.toggleDrawerFullscreen");
  });

  it("does not emit run.primaryAction when the selected run action is unavailable", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Enter",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          selectedRunPrimaryActionAvailable: false,
        },
      ),
    ).toBeNull();
  });
});
