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
    actionPending: false,
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
          key: "s",
          metaKey: false,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.toggleScheduledOnly");
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
    ).toBe("run.showNotes");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "c",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.showChat");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "d",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.showDetail");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "t",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.showTasks");
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
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "a",
          metaKey: false,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("run.destructiveCleanup");
  });

  it("supports the Cmd+Shift filter namespace while leaving plain letter shortcuts on run actions", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "s",
          metaKey: true,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("ui.toggleScheduledOnly");
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
          key: "a",
          metaKey: false,
          shiftKey: true,
        },
        context,
      ),
    ).toBe("run.destructiveCleanup");
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
    ).toBe("run.showNotes");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "c",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.showChat");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "d",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.showDetail");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "t",
          metaKey: false,
          shiftKey: false,
        },
        context,
      ),
    ).toBe("run.showTasks");
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

  it("keeps surface navigation but suppresses selected-run actions while viewing an attachment", () => {
    const attachmentContext = {
      ...context,
      selectedDrawerView: {
        attachmentId: "attachment-1",
        attachmentOwnerRunId: "run-running-1",
        detailSection: "attachments",
        mode: "attachment",
      },
    } as const;

    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "c",
          metaKey: false,
          shiftKey: false,
        },
        attachmentContext,
      ),
    ).toBe("run.showChat");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "d",
          metaKey: false,
          shiftKey: false,
        },
        attachmentContext,
      ),
    ).toBe("run.showDetail");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "n",
          metaKey: false,
          shiftKey: false,
        },
        attachmentContext,
      ),
    ).toBe("run.showNotes");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "t",
          metaKey: false,
          shiftKey: false,
        },
        attachmentContext,
      ),
    ).toBe("run.showTasks");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Escape",
          metaKey: false,
          shiftKey: false,
        },
        attachmentContext,
      ),
    ).toBe("run.closeAttachmentPreview");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Enter",
          metaKey: false,
          shiftKey: false,
        },
        attachmentContext,
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
        attachmentContext,
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "a",
          metaKey: false,
          shiftKey: false,
        },
        attachmentContext,
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "a",
          metaKey: false,
          shiftKey: true,
        },
        attachmentContext,
      ),
    ).toBeNull();
  });

  it("suppresses selected-run actions while an action is pending", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "a",
          metaKey: false,
          shiftKey: true,
        },
        {
          ...context,
          actionPending: true,
        },
      ),
    ).toBeNull();
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "a",
          metaKey: false,
          shiftKey: false,
        },
        {
          ...context,
          actionPending: true,
        },
      ),
    ).toBeNull();
  });

  it("maps Shift+A in fullscreen through the same selected-run guard", () => {
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "a",
          metaKey: false,
          shiftKey: true,
        },
        {
          ...context,
          drawerFullscreen: true,
        },
      ),
    ).toBe("run.destructiveCleanup");
  });

  it("guards Shift+A for modal, resume, search, typing, and no selected run", () => {
    const event = {
      altKey: false,
      ctrlKey: false,
      key: "a",
      metaKey: false,
      shiftKey: true,
    };

    expect(resolveRunsShortcutCommand(event, { ...context, modalOpen: true })).toBeNull();
    expect(resolveRunsShortcutCommand(event, { ...context, resumeDialogOpen: true })).toBeNull();
    expect(resolveRunsShortcutCommand(event, { ...context, searchFocused: true })).toBeNull();
    expect(resolveRunsShortcutCommand(event, { ...context, typingTarget: true })).toBeNull();
    expect(resolveRunsShortcutCommand(event, { ...context, selectedRunId: undefined })).toBeNull();
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
          typingTarget: true,
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
          key: "t",
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
          key: "c",
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
          modalOpen: true,
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
          modalOpen: true,
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
          modalOpen: true,
        },
      ),
    ).toBeNull();
  });

  it("allows selected-run actions but blocks board shortcuts while the drawer is fullscreen", () => {
    const fullscreenContext = {
      ...context,
      drawerFullscreen: true,
    };

    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "c",
          metaKey: false,
          shiftKey: false,
        },
        fullscreenContext,
      ),
    ).toBe("run.showChat");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "d",
          metaKey: false,
          shiftKey: false,
        },
        fullscreenContext,
      ),
    ).toBe("run.showDetail");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "t",
          metaKey: false,
          shiftKey: false,
        },
        fullscreenContext,
      ),
    ).toBe("run.showTasks");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: true,
          key: "f",
          metaKey: false,
          shiftKey: true,
        },
        fullscreenContext,
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
        fullscreenContext,
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
        fullscreenContext,
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
        fullscreenContext,
      ),
    ).toBe("ui.toggleDrawerFullscreen");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "Enter",
          metaKey: false,
          shiftKey: false,
        },
        fullscreenContext,
      ),
    ).toBe("run.primaryAction");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "n",
          metaKey: false,
          shiftKey: false,
        },
        fullscreenContext,
      ),
    ).toBe("run.showNotes");
    expect(
      resolveRunsShortcutCommand(
        {
          altKey: false,
          ctrlKey: false,
          key: "p",
          metaKey: false,
          shiftKey: false,
        },
        fullscreenContext,
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
        fullscreenContext,
      ),
    ).toBe("run.toggleArchived");
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
          ...fullscreenContext,
          modalOpen: true,
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
          ...fullscreenContext,
          selectedRunPrimaryActionAvailable: false,
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
        fullscreenContext,
      ),
    ).toBe("ui.toggleDrawerFullscreen");
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
          ...fullscreenContext,
          modalOpen: true,
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
          ...fullscreenContext,
          resumeDialogOpen: true,
        },
      ),
    ).toBeNull();
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
