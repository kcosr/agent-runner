import type {
  WorkspaceDiff,
  WorkspaceDiffFile,
  WorkspaceDiffFileStatus,
  WorkspaceDiffInput,
} from "@kcosr/agent-runner-core/contracts/workspace-diffs.js";
import {
  type CodeViewItem,
  type CodeViewLineSelection,
  type FileDiffMetadata,
  type SelectionSide,
  parsePatchFiles,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import type { GitStatusEntry } from "@pierre/trees";
import {
  FileTree,
  useFileTree,
  useFileTreeSearch,
  useFileTreeSelection,
} from "@pierre/trees/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createApiClient } from "../lib/api-client.js";
import { formatBytes } from "../lib/format.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import {
  DIFFS_SIDEBAR_WIDTH_DEFAULT,
  WORKSPACE_SIDEBAR_WIDTH_MAX,
  WORKSPACE_SIDEBAR_WIDTH_MIN,
  clampWorkspaceSidebarWidth,
  useDaemonAuthToken,
  useDashboardPreferences,
  useDashboardViewState,
} from "../lib/settings.js";
import { type TaskReference, defaultTaskTitle } from "../lib/task-reference.js";
import { CreateTaskDialog } from "./create-task-dialog.js";
import { ChevronIcon, CloseIcon, RefreshIcon, SearchIcon } from "./icons.js";

type DiffComparisonMode = "merge-base" | "direct";
type DiffViewMode = "unified" | "split";

interface ParsedDiffItem {
  id: string;
  item: CodeViewItem;
  fileDiff: FileDiffMetadata;
  path: string;
}

interface RunDiffsSurfaceProps {
  canCreateTask: boolean;
  onTaskCreated: (taskId: string) => void;
  runId: string;
  searchRequestVersion?: number;
}

const DEFAULT_BASE_REF = "main";
const DEFAULT_HEAD_REF = "HEAD";
const DEFAULT_RANGE = `${DEFAULT_BASE_REF}...${DEFAULT_HEAD_REF}`;

interface ParsedRangeInput {
  display: string;
  input: WorkspaceDiffInput;
}

function hashCodeViewVersion(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

function branchRangeInput(
  base: string,
  head: string,
  comparison: DiffComparisonMode,
): ParsedRangeInput {
  const separator = comparison === "direct" ? ".." : "...";
  return {
    display: `${base}${separator}${head}`,
    input: {
      mode: "branch",
      base,
      head,
      comparison,
    },
  };
}

function parseRangeInput(value: string): ParsedRangeInput | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^working[- ]tree$/i.test(trimmed)) {
    return {
      display: "working tree",
      input: { mode: "working-tree" },
    };
  }
  const mergeBaseParts = trimmed.split("...");
  if (mergeBaseParts.length === 2) {
    const [base, head] = mergeBaseParts.map((part) => part.trim());
    return base && head ? branchRangeInput(base, head, "merge-base") : null;
  }
  const directParts = trimmed.split("..");
  if (directParts.length === 2) {
    const [base, head] = directParts.map((part) => part.trim());
    return base && head ? branchRangeInput(base, head, "direct") : null;
  }
  return null;
}

function treeGitStatus(status: WorkspaceDiffFileStatus): GitStatusEntry["status"] {
  if (status === "copied" || status === "binary") {
    return "modified";
  }
  return status;
}

function parseDiffItems(diff: WorkspaceDiff): ParsedDiffItem[] {
  if (diff.patch.trim().length === 0) {
    return [];
  }
  return parsePatchFiles(diff.patch, `${diff.runId}:${diff.displayRange}`, false).flatMap(
    (patch, patchIndex) =>
      patch.files.map((fileDiff, fileIndex) => {
        const id = `${fileDiff.name}:${patchIndex}:${fileIndex}`;
        return {
          id,
          item: {
            id,
            type: "diff",
            fileDiff,
          },
          fileDiff,
          path: fileDiff.name,
        };
      }),
  );
}

function firstSelectablePath(files: WorkspaceDiffFile[]): string | null {
  return files[0]?.path ?? null;
}

function selectedTextFromFileDiff(
  fileDiff: FileDiffMetadata,
  side: SelectionSide,
  startLine: number,
  endLine: number,
): string {
  const sourceLines = side === "additions" ? fileDiff.additionLines : fileDiff.deletionLines;
  const selected: string[] = [];
  for (const hunk of fileDiff.hunks) {
    const hunkStart = side === "additions" ? hunk.additionStart : hunk.deletionStart;
    const hunkCount = side === "additions" ? hunk.additionCount : hunk.deletionCount;
    const hunkLineIndex = side === "additions" ? hunk.additionLineIndex : hunk.deletionLineIndex;
    const hunkEnd = hunkStart + Math.max(0, hunkCount - 1);
    const from = Math.max(startLine, hunkStart);
    const to = Math.min(endLine, hunkEnd);
    if (from > to) {
      continue;
    }
    const offset = from - hunkStart;
    selected.push(
      ...sourceLines.slice(hunkLineIndex + offset, hunkLineIndex + offset + to - from + 1),
    );
  }
  return selected.join("\n");
}

export function RunDiffsSurface({
  canCreateTask,
  onTaskCreated,
  runId,
  searchRequestVersion = 0,
}: RunDiffsSurfaceProps) {
  const config = useRuntimeConfig();
  const { daemonToken } = useDaemonAuthToken();
  const { preferences } = useDashboardPreferences();
  const { viewState, updateViewState } = useDashboardViewState();
  const api = useMemo(() => createApiClient(config, { daemonToken }), [config, daemonToken]);
  const [rangeInput, setRangeInput] = useState<ParsedRangeInput>(() =>
    branchRangeInput(DEFAULT_BASE_REF, DEFAULT_HEAD_REF, "merge-base"),
  );
  const [rangeDraft, setRangeDraft] = useState(DEFAULT_RANGE);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(false);
  const viewMode: DiffViewMode = viewState.diffsViewMode;
  const setViewMode = useCallback(
    (mode: DiffViewMode) => updateViewState({ diffsViewMode: mode }),
    [updateViewState],
  );
  const [collapsedDiffItemIds, setCollapsedDiffItemIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [codeViewItemsVersion, setCodeViewItemsVersion] = useState(0);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [dialogReference, setDialogReference] = useState<TaskReference | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const codeViewRef = useRef<CodeViewHandle<undefined> | null>(null);
  const mobileCollapsedPathRef = useRef<string | null>(null);
  const searchRequestVersionRef = useRef(searchRequestVersion);
  const persistedSidebarWidth = viewState.diffsSidebarWidth;
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [draggingWidth, setDraggingWidth] = useState<number | null>(null);
  const sidebarWidth = draggingWidth ?? persistedSidebarWidth;
  const resizing = draggingWidth !== null;
  const activeInput = rangeInput.input;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia("(max-width: 760px)");
    function updateLayout() {
      setMobileLayout(query.matches);
    }
    updateLayout();
    query.addEventListener("change", updateLayout);
    return () => query.removeEventListener("change", updateLayout);
  }, []);

  useEffect(() => {
    if (!mobileLayout) {
      mobileCollapsedPathRef.current = null;
      setBrowserCollapsed(false);
      return;
    }
    if (selectedPath && mobileCollapsedPathRef.current !== selectedPath) {
      mobileCollapsedPathRef.current = selectedPath;
      setBrowserCollapsed(true);
    }
  }, [mobileLayout, selectedPath]);

  const diffQuery = useQuery({
    queryKey: runQueryKeys.workspaceDiff(runId, activeInput),
    queryFn: ({ signal }) => api.getWorkspaceDiff(runId, activeInput, { signal }),
    retry: false,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await queryClient.invalidateQueries({
        queryKey: runQueryKeys.workspaceDiff(runId, activeInput),
      });
    },
  });
  const createTaskMutation = useMutation({
    mutationFn: (input: { body: string; title: string }) => api.createTask(runId, input),
    onSuccess: async (task) => {
      setDialogReference(null);
      setSelectedLines(null);
      onTaskCreated(task.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.lists() }),
      ]);
    },
  });

  const diff = diffQuery.data;
  const files = diff?.files ?? [];
  const filePaths = useMemo(() => files.map((file) => file.path), [files]);
  const filePathSet = useMemo(() => new Set(filePaths), [filePaths]);
  const gitStatus = useMemo(
    () =>
      files.map(
        (file): GitStatusEntry => ({ path: file.path, status: treeGitStatus(file.status) }),
      ),
    [files],
  );
  const tree = useFileTree({
    fileTreeSearchMode: "hide-non-matches",
    gitStatus,
    initialExpansion: "open",
    paths: filePaths,
    search: true,
  });
  const selectedTreePaths = useFileTreeSelection(tree.model);
  const treeSearch = useFileTreeSearch(tree.model);
  const parsedDiffItems = useMemo(() => (diff ? parseDiffItems(diff) : []), [diff]);
  const codeViewItems = useMemo(
    () => parsedDiffItems.map((entry) => entry.item),
    [parsedDiffItems],
  );
  const codeViewItemIds = useMemo(() => codeViewItems.map((item) => item.id), [codeViewItems]);
  const allDiffItemsCollapsed =
    codeViewItemIds.length > 0 && codeViewItemIds.every((id) => collapsedDiffItemIds.has(id));
  const codeViewContentVersionKey = diff ? `${diff.displayRange}\0${diff.patch}` : "";
  const codeViewContentVersion = useMemo(
    () => hashCodeViewVersion(codeViewContentVersionKey),
    [codeViewContentVersionKey],
  );
  useEffect(() => {
    const validIds = new Set(codeViewItemIds);
    setCollapsedDiffItemIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [codeViewItemIds]);
  const displayedCodeViewItems = useMemo(
    () =>
      codeViewItems.map(
        (item): CodeViewItem =>
          ({
            ...item,
            collapsed: collapsedDiffItemIds.has(item.id),
            version: codeViewContentVersion + codeViewItemsVersion,
          }) as CodeViewItem,
      ),
    [codeViewContentVersion, codeViewItems, codeViewItemsVersion, collapsedDiffItemIds],
  );
  const codeViewItemByPath = useMemo(() => {
    const entries = new Map<string, string>();
    for (const item of parsedDiffItems) {
      if (!entries.has(item.path)) {
        entries.set(item.path, item.id);
      }
    }
    return entries;
  }, [parsedDiffItems]);
  const parsedDiffItemById = useMemo(() => {
    const entries = new Map<string, ParsedDiffItem>();
    for (const item of parsedDiffItems) {
      entries.set(item.id, item);
    }
    return entries;
  }, [parsedDiffItems]);
  const selectedFile = files.find((file) => file.path === selectedPath);
  const selectedCodeViewItemId = selectedPath ? codeViewItemByPath.get(selectedPath) : undefined;
  const selectedReference = useMemo<TaskReference | null>(() => {
    if (!diff || !selectedLines) {
      return null;
    }
    const parsedItem = parsedDiffItemById.get(selectedLines.id);
    if (!parsedItem) {
      return null;
    }
    const side = selectedLines.range.side ?? selectedLines.range.endSide;
    if (
      (side !== "additions" && side !== "deletions") ||
      (selectedLines.range.endSide !== undefined && selectedLines.range.endSide !== side)
    ) {
      return null;
    }
    const startLine = Math.min(selectedLines.range.start, selectedLines.range.end);
    const endLine = Math.max(selectedLines.range.start, selectedLines.range.end);
    const selectedText = selectedTextFromFileDiff(parsedItem.fileDiff, side, startLine, endLine);
    if (selectedText.trim().length === 0) {
      return null;
    }
    const file = files.find((entry) => entry.path === parsedItem.path);
    return {
      baseRef: diff.baseRef,
      comparison: diff.comparison,
      displayRange: diff.displayRange,
      endLine,
      headRef: diff.headRef,
      oldPath: file?.oldPath ?? parsedItem.fileDiff.prevName,
      path: parsedItem.path,
      selectedText,
      side,
      startLine,
      view: "diff",
    };
  }, [diff, files, parsedDiffItemById, selectedLines]);

  useEffect(() => {
    if (!diff) {
      setSelectedPath(null);
      setSelectedLines(null);
      return;
    }
    setSelectedPath((current) =>
      current && filePathSet.has(current) ? current : firstSelectablePath(files),
    );
    setSelectedLines(null);
  }, [diff, files, filePathSet]);

  useEffect(() => {
    tree.model.resetPaths(filePaths);
    tree.model.setGitStatus(gitStatus);
  }, [filePaths, gitStatus, tree.model]);

  useEffect(() => {
    const selected = selectedTreePaths.find((path) => filePathSet.has(path));
    if (selected !== undefined) {
      setSelectedPath((current) => {
        if (current === selected) {
          return current;
        }
        setSelectedLines(null);
        return selected;
      });
    }
  }, [filePathSet, selectedTreePaths]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    const item = tree.model.getItem(selectedPath);
    item?.select();
    tree.model.scrollToPath(selectedPath, { offset: "nearest" });
  }, [selectedPath, tree.model]);

  useEffect(() => {
    if (!selectedCodeViewItemId) {
      return;
    }
    codeViewRef.current?.scrollTo({
      type: "item",
      id: selectedCodeViewItemId,
      align: "start",
      behavior: "smooth-auto",
    });
  }, [selectedCodeViewItemId]);

  useEffect(() => {
    if (searchRequestVersion === searchRequestVersionRef.current) {
      return;
    }
    searchRequestVersionRef.current = searchRequestVersion;
    focusTreeSearchInput();
  }, [searchRequestVersion]);

  function applyRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseRangeInput(rangeDraft);
    if (!parsed) {
      setRangeError("Use a range like main...HEAD, main..HEAD, or working tree.");
      return;
    }
    setRangeInput(parsed);
    setRangeDraft(parsed.display);
    setRangeError(null);
    setSelectedLines(null);
  }

  function updateSelectedLines(selection: CodeViewLineSelection | null) {
    setSelectedLines(selection);
    if (selection) {
      const parsedItem = parsedDiffItemById.get(selection.id);
      if (parsedItem) {
        setSelectedPath(parsedItem.path);
      }
    }
  }

  function toggleAllDiffItemsCollapsed() {
    setCollapsedDiffItemIds((current) => {
      const nextCollapsed = !(
        codeViewItemIds.length > 0 && codeViewItemIds.every((id) => current.has(id))
      );
      if (nextCollapsed) {
        setSelectedLines(null);
      }
      return nextCollapsed ? new Set(codeViewItemIds) : new Set();
    });
    setCodeViewItemsVersion((version) => version + 1);
  }

  function toggleDiffItemCollapsed(itemId: string) {
    setCollapsedDiffItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
        if (selectedLines?.id === itemId) {
          setSelectedLines(null);
        }
      }
      return next;
    });
    setCodeViewItemsVersion((version) => version + 1);
  }

  function getTreeSearchInput(): HTMLInputElement | null {
    const treeHost = rootRef.current?.querySelector(".diffs-file-tree");
    const input = treeHost?.shadowRoot?.querySelector("[data-file-tree-search-input]");
    return input instanceof HTMLInputElement ? input : null;
  }

  function focusTreeSearchInput() {
    setBrowserCollapsed(false);
    treeSearch.open(treeSearch.value);
    window.requestAnimationFrame(() => {
      const input = getTreeSearchInput();
      input?.focus();
      input?.select();
    });
  }

  function handleBrowserClickCapture(event: ReactMouseEvent<HTMLElement>) {
    if (!mobileLayout || browserCollapsed) {
      return;
    }
    const clickedFile = event.nativeEvent
      .composedPath()
      .some(
        (target) =>
          target instanceof Element && target.matches('[data-type="item"][data-item-type="file"]'),
      );
    if (!clickedFile) {
      return;
    }
    window.requestAnimationFrame(() => setBrowserCollapsed(true));
  }

  function handleResizerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    const layout = layoutRef.current;
    if (!layout) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const layoutLeft = layout.getBoundingClientRect().left;

    function clamp(clientX: number) {
      return clampWorkspaceSidebarWidth(clientX - layoutLeft, DIFFS_SIDEBAR_WIDTH_DEFAULT);
    }

    setDraggingWidth(clamp(event.clientX));

    function handleMove(moveEvent: PointerEvent) {
      setDraggingWidth(clamp(moveEvent.clientX));
    }

    function handleEnd(endEvent: PointerEvent) {
      const next = clamp(endEvent.clientX);
      setDraggingWidth(null);
      updateViewState({ diffsSidebarWidth: next });
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleCancel);
    }

    function handleCancel() {
      setDraggingWidth(null);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleCancel);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleCancel);
  }

  function handleResizerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === "ArrowLeft" ? -step : step;
    updateViewState({
      diffsSidebarWidth: clampWorkspaceSidebarWidth(
        sidebarWidth + delta,
        DIFFS_SIDEBAR_WIDTH_DEFAULT,
      ),
    });
  }

  const loading = diffQuery.isPending;
  const empty = diff && diff.files.length === 0 && diff.patch.length === 0;
  const themeType = preferences.themeMode === "auto" ? "system" : preferences.themeMode;
  const showResizer = !browserCollapsed && !mobileLayout;
  const showDiffViewer = !mobileLayout || browserCollapsed;
  const treeHeader = (
    <div className="diffs-tree-header">
      <span>Files</span>
      <button
        aria-label={treeSearch.isOpen ? "Close changed-file search" : "Search changed files"}
        className="icon-btn icon-btn--small"
        onClick={() => {
          if (treeSearch.isOpen) {
            treeSearch.close();
            return;
          }
          focusTreeSearchInput();
        }}
        title={treeSearch.isOpen ? "Close search" : "Search files"}
        type="button"
      >
        {treeSearch.isOpen ? <CloseIcon aria-hidden="true" /> : <SearchIcon aria-hidden="true" />}
      </button>
    </div>
  );

  return (
    <section aria-label="Diffs" className="drawer-panel drawer-panel--diffs" ref={rootRef}>
      <form className="diffs-range-form" onSubmit={applyRange}>
        <label>
          <span>Range</span>
          <input
            aria-label="Diff range"
            onChange={(event) => {
              setRangeDraft(event.target.value);
              setRangeError(null);
            }}
            value={rangeDraft}
          />
        </label>
        <button className="btn btn-compact" disabled={rangeDraft.trim().length === 0} type="submit">
          Apply
        </button>
        <button
          aria-label="Refresh workspace diff"
          className="icon-btn"
          disabled={refreshMutation.isPending}
          onClick={() => refreshMutation.mutate()}
          title="Refresh"
          type="button"
        >
          <RefreshIcon aria-hidden="true" />
        </button>
      </form>

      {rangeError ? <p className="files-error">{rangeError}</p> : null}
      {diff?.truncated ? (
        <p className="diffs-notice">Patch output was truncated at {formatBytes(diff.maxBytes)}.</p>
      ) : null}
      {diffQuery.isError ? <p className="files-error">{diffQuery.error.message}</p> : null}
      {loading ? <p className="task-empty">Loading diff...</p> : null}
      {empty ? <p className="task-empty">No changes in this comparison.</p> : null}

      <div
        className={[
          "diffs-layout",
          browserCollapsed ? "diffs-layout--browser-collapsed" : null,
          mobileLayout && !browserCollapsed ? "diffs-layout--mobile-browser-expanded" : null,
          resizing ? "diffs-layout--resizing" : null,
          showResizer ? "diffs-layout--with-resizer" : null,
        ]
          .filter(Boolean)
          .join(" ")}
        ref={layoutRef}
        style={
          showResizer
            ? ({ "--diffs-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties)
            : undefined
        }
      >
        <aside
          className={browserCollapsed ? "diffs-sidebar diffs-sidebar--collapsed" : "diffs-sidebar"}
          aria-label="Changed files"
          onClickCapture={handleBrowserClickCapture}
        >
          {browserCollapsed ? (
            <div className="diffs-browser__header">
              <button
                aria-expanded={!browserCollapsed}
                className="diffs-browser__toggle"
                onClick={() => setBrowserCollapsed(false)}
                title="Show changed files"
                type="button"
              >
                <ChevronIcon aria-hidden="true" />
                <span>{selectedPath ?? "Changed files"}</span>
              </button>
            </div>
          ) : files.length > 0 ? (
            <FileTree className="diffs-file-tree" header={treeHeader} model={tree.model} />
          ) : (
            <p className="task-empty">No changed files.</p>
          )}
          {diff && !browserCollapsed ? (
            <dl className="diffs-stats-panel" aria-label="Diff stats">
              <div>
                <dt>Files</dt>
                <dd>{diff.stats.files}</dd>
              </div>
              <div>
                <dt>Additions</dt>
                <dd className="diffs-stat-addition">{diff.stats.additions}</dd>
              </div>
              <div>
                <dt>Deletions</dt>
                <dd className="diffs-stat-deletion">{diff.stats.deletions}</dd>
              </div>
            </dl>
          ) : null}
        </aside>

        {showResizer ? (
          <div
            aria-label="Resize changed-files sidebar"
            aria-orientation="vertical"
            aria-valuemax={WORKSPACE_SIDEBAR_WIDTH_MAX}
            aria-valuemin={WORKSPACE_SIDEBAR_WIDTH_MIN}
            aria-valuenow={sidebarWidth}
            className="workspace-sidebar-resizer"
            onKeyDown={handleResizerKeyDown}
            onPointerDown={handleResizerPointerDown}
            role="separator"
            tabIndex={0}
          />
        ) : null}

        {showDiffViewer ? (
          <div className="diffs-viewer" aria-label="Diff viewer">
            <div className="diffs-viewer__header">
              {selectedReference ? (
                <div className="diffs-selection-controls">
                  {canCreateTask ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => setDialogReference(selectedReference)}
                      type="button"
                    >
                      Add task
                    </button>
                  ) : null}
                  <button
                    aria-label="Clear diff selection"
                    className="icon-btn icon-btn--small"
                    onClick={() => setSelectedLines(null)}
                    title="Clear selection"
                    type="button"
                  >
                    <CloseIcon aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <div className="diffs-view-actions">
                <button
                  className="btn btn-compact"
                  disabled={codeViewItems.length === 0}
                  onClick={toggleAllDiffItemsCollapsed}
                  type="button"
                >
                  {allDiffItemsCollapsed ? "Expand all" : "Collapse all"}
                </button>
                <div className="task-tabs" role="tablist" aria-label="Diff view mode">
                  <button
                    aria-selected={viewMode === "unified"}
                    className={viewMode === "unified" ? "task-tab active" : "task-tab"}
                    onClick={() => setViewMode("unified")}
                    role="tab"
                    type="button"
                  >
                    Unified
                  </button>
                  <button
                    aria-selected={viewMode === "split"}
                    className={viewMode === "split" ? "task-tab active" : "task-tab"}
                    onClick={() => setViewMode("split")}
                    role="tab"
                    type="button"
                  >
                    Split
                  </button>
                </div>
              </div>
            </div>
            {selectedFile?.binary ? (
              <p className="task-empty">This file is binary or too large to preview.</p>
            ) : null}
            {!selectedFile?.binary && selectedPath && !selectedCodeViewItemId ? (
              <p className="task-empty">No text patch is available for this file.</p>
            ) : null}
            {codeViewItems.length > 0 ? (
              <CodeView
                className="diffs-code-view"
                items={displayedCodeViewItems}
                onSelectedLinesChange={updateSelectedLines}
                options={{
                  controlledSelection: true,
                  diffStyle: viewMode,
                  enableLineSelection: true,
                  hunkSeparators: "line-info-basic",
                  overflow: "wrap",
                  stickyHeaders: true,
                  theme: { dark: "pierre-dark", light: "pierre-light" },
                  themeType,
                }}
                ref={codeViewRef}
                renderHeaderPrefix={(item) => {
                  if (item.type !== "diff") {
                    return null;
                  }
                  const collapsed = collapsedDiffItemIds.has(item.id);
                  return (
                    <button
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? "Expand" : "Collapse"} ${item.fileDiff.name}`}
                      className={
                        collapsed
                          ? "diffs-file-collapse diffs-file-collapse--collapsed"
                          : "diffs-file-collapse"
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleDiffItemCollapsed(item.id);
                      }}
                      title={collapsed ? "Expand file" : "Collapse file"}
                      type="button"
                    >
                      <ChevronIcon aria-hidden="true" />
                    </button>
                  );
                }}
                selectedLines={selectedLines}
              />
            ) : !loading && !diffQuery.isError && !empty ? (
              <p className="task-empty">No text patch content to preview.</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {dialogReference ? (
        <CreateTaskDialog
          initialTitle={defaultTaskTitle(dialogReference.path)}
          onClose={() => setDialogReference(null)}
          onSubmit={async (input) => {
            await createTaskMutation.mutateAsync(input);
          }}
          pending={createTaskMutation.isPending}
          reference={dialogReference}
          submitError={createTaskMutation.error?.message}
        />
      ) : null}
    </section>
  );
}
