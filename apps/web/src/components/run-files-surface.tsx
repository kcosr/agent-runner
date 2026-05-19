import type {
  WorkspaceFileContent,
  WorkspaceFileEntry,
} from "@kcosr/agent-runner-core/contracts/workspace-files.js";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createApiClient } from "../lib/api-client.js";
import { formatBytes } from "../lib/format.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { useDaemonAuthToken } from "../lib/settings.js";
import { isEditableEventTarget } from "../lib/shortcuts.js";
import { type TaskReference, defaultTaskTitle, languageForPath } from "../lib/task-reference.js";
import { CreateTaskDialog } from "./create-task-dialog.js";
import { ChevronIcon, CloseIcon, FileIcon, FolderIcon, SearchIcon } from "./icons.js";
import { MarkdownContent } from "./markdown.js";

type FileViewMode = "rendered-markdown" | "source";

interface SourceSelection {
  anchorLine: number;
  endLine: number;
  selectedText?: string;
  startLine: number;
}

function entryLabel(entry: WorkspaceFileEntry): string {
  const details = [
    entry.kind === "directory"
      ? "Directory"
      : entry.supportedText
        ? "Text file"
        : "Unsupported file",
    entry.size === null ? null : formatBytes(entry.size),
  ].filter(Boolean);
  return `${entry.name} (${details.join(", ")})`;
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function lineRangeText(file: WorkspaceFileContent, selection: SourceSelection): string {
  return file.text
    .split(/\r?\n/)
    .slice(selection.startLine - 1, selection.endLine)
    .join("\n");
}

function isSelectionInside(container: HTMLElement, selection: Selection): boolean {
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return Boolean(
    anchor &&
      focus &&
      container.contains(anchor) &&
      container.contains(focus) &&
      selection.toString().trim().length > 0,
  );
}

function selectionLineNumber(container: HTMLElement, node: Node | null): number | null {
  let element = node instanceof Element ? node : node?.parentElement;
  while (element && element !== container) {
    const lineNumber = element.getAttribute("data-line-number");
    if (lineNumber) {
      const parsed = Number.parseInt(lineNumber, 10);
      return Number.isNaN(parsed) ? null : parsed;
    }
    element = element.parentElement;
  }
  return null;
}

export function RunFilesSurface({
  canCreateTask,
  onTaskCreated,
  runId,
  taskCreationUnavailableReason,
}: {
  canCreateTask: boolean;
  onTaskCreated: (taskId: string) => void;
  runId: string;
  taskCreationUnavailableReason: string | null;
}) {
  const config = useRuntimeConfig();
  const { daemonToken } = useDaemonAuthToken();
  const api = useMemo(() => createApiClient(config, { daemonToken }), [config, daemonToken]);
  const [directoryPath, setDirectoryPath] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(false);
  const [viewMode, setViewMode] = useState<FileViewMode>("source");
  const [sourceSelection, setSourceSelection] = useState<SourceSelection | null>(null);
  const [renderedSelection, setRenderedSelection] = useState("");
  const [dialogReference, setDialogReference] = useState<TaskReference | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedFileRef = useRef<WorkspaceFileContent | undefined>(undefined);
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const trimmedSearch = debouncedSearch.trim();
  const searchActive = trimmedSearch.length > 0;

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
    if (searchDraft.trim().length === 0) {
      setDebouncedSearch("");
      return;
    }
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(searchDraft);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchDraft]);

  const directoryQuery = useQuery({
    queryKey: runQueryKeys.workspaceFiles(runId, directoryPath),
    queryFn: ({ signal }) => api.listWorkspaceFiles(runId, { path: directoryPath, signal }),
    retry: false,
  });
  const searchQuery = useQuery({
    enabled: searchActive,
    queryKey: runQueryKeys.workspaceSearch(runId, trimmedSearch, 50),
    queryFn: ({ signal }) => api.searchWorkspaceFiles(runId, trimmedSearch, { limit: 50, signal }),
    retry: false,
  });
  const fileQuery = useQuery({
    enabled: selectedFilePath !== null,
    queryKey: selectedFilePath
      ? runQueryKeys.workspaceFile(runId, selectedFilePath)
      : runQueryKeys.workspaceFile(runId, "__none__"),
    queryFn: ({ signal }) => {
      if (!selectedFilePath) {
        throw new Error("Selected file path is required");
      }
      return api.getWorkspaceFile(runId, selectedFilePath, { signal });
    },
    retry: false,
  });
  const createTaskMutation = useMutation({
    mutationFn: (input: { body: string; title: string }) => api.createTask(runId, input),
    onSuccess: async (task) => {
      setDialogReference(null);
      setRenderedSelection("");
      setSourceSelection(null);
      onTaskCreated(task.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.lists() }),
      ]);
    },
  });

  useEffect(() => {
    const file = fileQuery.data;
    if (!file) {
      return;
    }
    setViewMode(file.markdown ? "rendered-markdown" : "source");
    setRenderedSelection("");
    setSourceSelection(null);
  }, [fileQuery.data]);

  const entries = searchActive
    ? (searchQuery.data?.matches ?? [])
    : (directoryQuery.data?.entries ?? []);
  const entriesPending = searchActive ? searchQuery.isPending : directoryQuery.isPending;
  const entriesError = searchActive ? searchQuery.error : directoryQuery.error;
  const selectedFile = fileQuery.data;

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  const selectedSourceText =
    selectedFile && sourceSelection
      ? (sourceSelection.selectedText ?? lineRangeText(selectedFile, sourceSelection))
      : "";
  const selectedReference = useMemo<TaskReference | null>(() => {
    if (!selectedFile) {
      return null;
    }
    if (viewMode === "rendered-markdown" && renderedSelection.trim()) {
      return {
        path: selectedFile.path,
        selectedText: renderedSelection.trim(),
        view: "rendered-markdown",
      };
    }
    if (viewMode === "source" && sourceSelection && selectedSourceText) {
      return {
        endLine: sourceSelection.endLine,
        language: languageForPath(selectedFile.path),
        path: selectedFile.path,
        selectedText: selectedSourceText,
        startLine: sourceSelection.startLine,
        view: "source",
      };
    }
    return null;
  }, [renderedSelection, selectedFile, selectedSourceText, sourceSelection, viewMode]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const root = rootRef.current;
      const filesSurfaceVisible = root?.isConnected === true && !root.closest("[hidden]");
      const typingTarget =
        isEditableEventTarget(event.target) || isEditableEventTarget(document.activeElement);
      if (!filesSurfaceVisible || dialogReference || event.defaultPrevented || typingTarget) {
        return;
      }

      if (
        event.key.toLowerCase() === "f" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        focusSearchInput();
        return;
      }

      if (event.key === "Escape" && selectedReference) {
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
        return;
      }

      if (event.key === "Enter" && selectedReference && canCreateTask) {
        event.preventDefault();
        event.stopPropagation();
        openCreateTaskDialog(selectedReference);
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [canCreateTask, dialogReference, selectedReference]);

  useEffect(() => {
    function handleSelectionChange() {
      const root = rootRef.current;
      if (!root || !root.isConnected || root.closest("[hidden]")) {
        return;
      }
      if (viewMode === "rendered-markdown") {
        captureRenderedSelection();
        return;
      }
      captureSourceTextSelection();
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [viewMode]);

  function openEntry(entry: WorkspaceFileEntry) {
    if (entry.kind === "directory") {
      setDirectoryPath(entry.path);
      setSearchDraft("");
      setSelectedFilePath(null);
      setBrowserCollapsed(false);
      return;
    }
    setSelectedFilePath(entry.path);
    if (mobileLayout) {
      setBrowserCollapsed(true);
    }
  }

  function captureRenderedSelection() {
    const preview = previewRef.current;
    const selection = window.getSelection();
    if (!preview || !selection || !isSelectionInside(preview, selection)) {
      setRenderedSelection("");
      return;
    }
    setRenderedSelection(selection.toString().trim());
  }

  function focusSearchInput() {
    setBrowserCollapsed(false);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (searchDraft.length > 0) {
      setSearchDraft("");
      setDebouncedSearch("");
      return;
    }
    event.currentTarget.blur();
  }

  function selectLine(lineNumber: number, event: MouseEvent<HTMLButtonElement>) {
    setSourceSelection((current) => {
      if (event.shiftKey && current) {
        return {
          anchorLine: current.anchorLine,
          endLine: Math.max(current.anchorLine, lineNumber),
          startLine: Math.min(current.anchorLine, lineNumber),
        };
      }
      return { anchorLine: lineNumber, endLine: lineNumber, startLine: lineNumber };
    });
  }

  function captureSourceSelection(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest(".files-source__gutter")) {
      return;
    }
    captureSourceTextSelection();
  }

  function captureSourceTextSelection() {
    const source = sourceRef.current;
    const file = selectedFileRef.current;
    const selection = window.getSelection();
    if (!source || !file || !selection || !isSelectionInside(source, selection)) {
      return;
    }
    const anchorLine = selectionLineNumber(source, selection.anchorNode);
    const focusLine = selectionLineNumber(source, selection.focusNode);
    if (!anchorLine || !focusLine) {
      return;
    }
    const rangeSelection = {
      anchorLine,
      endLine: Math.max(anchorLine, focusLine),
      startLine: Math.min(anchorLine, focusLine),
    };
    setSourceSelection({
      ...rangeSelection,
      selectedText: lineRangeText(file, rangeSelection),
    });
  }

  function openCreateTaskDialog(reference: TaskReference | null) {
    if (!canCreateTask || !reference) {
      return;
    }
    setDialogReference(reference);
  }

  function clearSelection() {
    setRenderedSelection("");
    setSourceSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <section aria-label="Files" className="drawer-panel drawer-panel--files" ref={rootRef}>
      <div
        className={
          browserCollapsed ? "files-layout files-layout--browser-collapsed" : "files-layout"
        }
      >
        <div className="files-browser-shell">
          <div className="files-browser__header">
            <button
              aria-expanded={!browserCollapsed}
              className="files-browser__toggle"
              onClick={() => setBrowserCollapsed((current) => !current)}
              title={browserCollapsed ? "Show workspace files" : "Collapse workspace files"}
              type="button"
            >
              <ChevronIcon aria-hidden="true" />
              <span>{searchActive ? "Search results" : directoryPath || "Workspace"}</span>
            </button>
            {!browserCollapsed ? (
              searchActive && searchQuery.data?.truncated ? (
                <span>Showing first {searchQuery.data.maxResults}</span>
              ) : directoryQuery.data?.truncated ? (
                <span>Showing first {directoryQuery.data.maxEntries}</span>
              ) : null
            ) : null}
          </div>
          {!browserCollapsed ? (
            <>
              <div className="files-toolbar">
                <label className="files-search">
                  <SearchIcon aria-hidden="true" />
                  <span className="sr-only">Search workspace files</span>
                  <input
                    aria-label="Search workspace files"
                    id="workspace-file-search"
                    onChange={(event) => setSearchDraft(event.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search files"
                    ref={searchInputRef}
                    value={searchDraft}
                  />
                </label>
                {directoryPath ? (
                  <button
                    className="btn btn--quiet"
                    onClick={() => setDirectoryPath(parentPath(directoryPath))}
                    type="button"
                  >
                    Parent
                  </button>
                ) : null}
              </div>
              <div className="files-browser" aria-label="Workspace file browser">
                {entriesPending ? <p className="task-empty">Loading files...</p> : null}
                {entriesError ? <p className="files-error">{entriesError.message}</p> : null}
                {!entriesPending && !entriesError && entries.length === 0 ? (
                  <p className="task-empty">
                    {searchActive ? "No matching files." : "This directory is empty."}
                  </p>
                ) : null}
                <div className="files-list">
                  {entries.map((entry) => (
                    <button
                      aria-label={entryLabel(entry)}
                      className={
                        selectedFilePath === entry.path
                          ? "files-list__row active"
                          : "files-list__row"
                      }
                      disabled={entry.kind === "file" && !entry.supportedText}
                      key={`${entry.kind}:${entry.path}`}
                      onClick={() => openEntry(entry)}
                      type="button"
                    >
                      {entry.kind === "directory" ? (
                        <FolderIcon aria-hidden="true" />
                      ) : (
                        <FileIcon aria-hidden="true" />
                      )}
                      <span className="files-list__name">{entry.name}</span>
                      <span className="files-list__meta">
                        {entry.kind === "directory"
                          ? "Directory"
                          : entry.supportedText
                            ? entry.size === null
                              ? "Text"
                              : formatBytes(entry.size)
                            : "Unsupported"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>
        <div className="files-viewer" aria-label="File preview">
          {!selectedFilePath ? <p className="task-empty">Select a text or Markdown file.</p> : null}
          {selectedFilePath && fileQuery.isPending ? (
            <p className="task-empty">Loading file...</p>
          ) : null}
          {fileQuery.isError ? <p className="files-error">{fileQuery.error.message}</p> : null}
          {selectedFile ? (
            <>
              <div className="files-viewer__header">
                <div>
                  <h3>{selectedFile.name}</h3>
                  <p>
                    {selectedFile.path} · {formatBytes(selectedFile.size)}
                  </p>
                </div>
                <div className="files-viewer__controls">
                  {selectedReference ? (
                    <div className="files-selection-controls">
                      <button
                        className="btn btn-primary"
                        disabled={!canCreateTask}
                        onClick={() => openCreateTaskDialog(selectedReference)}
                        title={
                          canCreateTask ? undefined : (taskCreationUnavailableReason ?? undefined)
                        }
                        type="button"
                      >
                        Add task
                      </button>
                      <button
                        aria-label="Clear file selection"
                        className="icon-btn icon-btn--small"
                        onClick={clearSelection}
                        title="Clear selection"
                        type="button"
                      >
                        <CloseIcon aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                  <div className="task-tabs" role="tablist" aria-label="File view mode">
                    {selectedFile.markdown ? (
                      <button
                        aria-selected={viewMode === "rendered-markdown"}
                        className={
                          viewMode === "rendered-markdown" ? "task-tab active" : "task-tab"
                        }
                        onClick={() => setViewMode("rendered-markdown")}
                        role="tab"
                        type="button"
                      >
                        Preview
                      </button>
                    ) : null}
                    <button
                      aria-selected={viewMode === "source"}
                      className={viewMode === "source" ? "task-tab active" : "task-tab"}
                      onClick={() => setViewMode("source")}
                      role="tab"
                      type="button"
                    >
                      Source
                    </button>
                  </div>
                </div>
              </div>
              {viewMode === "rendered-markdown" ? (
                <div
                  className="files-rendered markdown"
                  onKeyUp={captureRenderedSelection}
                  onMouseUp={captureRenderedSelection}
                  onTouchEnd={captureRenderedSelection}
                  ref={previewRef}
                >
                  <MarkdownContent text={selectedFile.text} />
                </div>
              ) : (
                <div
                  className="files-source"
                  aria-label={`Source for ${selectedFile.path}`}
                  onMouseUp={captureSourceSelection}
                  onTouchEnd={() => captureSourceTextSelection()}
                  ref={sourceRef}
                >
                  {selectedFile.text.split(/\r?\n/).map((line, index) => {
                    const lineNumber = index + 1;
                    const selected =
                      sourceSelection &&
                      lineNumber >= sourceSelection.startLine &&
                      lineNumber <= sourceSelection.endLine;
                    return (
                      <div
                        className={selected ? "files-source__line selected" : "files-source__line"}
                        data-line-number={lineNumber}
                        key={lineNumber}
                      >
                        <button
                          aria-label={`Select line ${lineNumber}`}
                          className="files-source__gutter"
                          onClick={(event) => selectLine(lineNumber, event)}
                          type="button"
                        >
                          {lineNumber}
                        </button>
                        <code>{line || " "}</code>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>
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
