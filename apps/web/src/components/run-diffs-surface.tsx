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
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "../lib/api-client.js";
import { formatBytes } from "../lib/format.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { useDaemonAuthToken } from "../lib/settings.js";
import { type TaskReference, defaultTaskTitle } from "../lib/task-reference.js";
import { CreateTaskDialog } from "./create-task-dialog.js";
import { CloseIcon, RefreshIcon, SearchIcon } from "./icons.js";

type DiffComparisonMode = "merge-base" | "direct" | "working-tree";
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
}

const DEFAULT_BASE_REF = "main";
const DEFAULT_HEAD_REF = "HEAD";

function inputForMode(
  mode: DiffComparisonMode,
  refs: { base: string; head: string },
): WorkspaceDiffInput {
  if (mode === "working-tree") {
    return { mode: "working-tree" };
  }
  return {
    mode: "branch",
    base: refs.base,
    head: refs.head,
    comparison: mode,
  };
}

function statusLabel(status: WorkspaceDiffFileStatus): string {
  if (status === "binary") {
    return "Preview unavailable";
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function treeGitStatus(status: WorkspaceDiffFileStatus): GitStatusEntry["status"] {
  if (status === "copied" || status === "binary") {
    return "modified";
  }
  return status;
}

function displayStats(file: WorkspaceDiffFile): string {
  if (file.binary) {
    return "Binary";
  }
  return `+${file.additions ?? 0} / -${file.deletions ?? 0}`;
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

export function RunDiffsSurface({ canCreateTask, onTaskCreated, runId }: RunDiffsSurfaceProps) {
  const config = useRuntimeConfig();
  const { daemonToken } = useDaemonAuthToken();
  const api = useMemo(() => createApiClient(config, { daemonToken }), [config, daemonToken]);
  const [comparisonMode, setComparisonMode] = useState<DiffComparisonMode>("merge-base");
  const [branchRefs, setBranchRefs] = useState({ base: DEFAULT_BASE_REF, head: DEFAULT_HEAD_REF });
  const [baseDraft, setBaseDraft] = useState(DEFAULT_BASE_REF);
  const [headDraft, setHeadDraft] = useState(DEFAULT_HEAD_REF);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DiffViewMode>("unified");
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [dialogReference, setDialogReference] = useState<TaskReference | null>(null);
  const codeViewRef = useRef<CodeViewHandle<undefined> | null>(null);
  const activeInput = useMemo(
    () => inputForMode(comparisonMode, branchRefs),
    [branchRefs, comparisonMode],
  );

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
    const selected = selectedTreePaths.find((path) => filePathSet.has(path));
    if (selected !== undefined) {
      setSelectedPath(selected);
      setSelectedLines(null);
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

  function selectComparisonMode(mode: DiffComparisonMode) {
    setComparisonMode(mode);
    setSelectedLines(null);
  }

  function applyBranchRefs(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const base = baseDraft.trim();
    const head = headDraft.trim();
    if (base.length === 0 || head.length === 0) {
      return;
    }
    setBranchRefs({ base, head });
    if (comparisonMode === "working-tree") {
      setComparisonMode("merge-base");
    }
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

  const loading = diffQuery.isPending;
  const empty = diff && diff.files.length === 0 && diff.patch.length === 0;

  return (
    <section aria-label="Diffs" className="drawer-panel drawer-panel--diffs">
      <div className="diffs-toolbar">
        <div className="task-tabs diffs-mode-tabs" role="tablist" aria-label="Diff comparison">
          <button
            aria-selected={comparisonMode === "merge-base"}
            className={comparisonMode === "merge-base" ? "task-tab active" : "task-tab"}
            onClick={() => selectComparisonMode("merge-base")}
            role="tab"
            type="button"
          >
            {branchRefs.base}...{branchRefs.head}
          </button>
          <button
            aria-selected={comparisonMode === "direct"}
            className={comparisonMode === "direct" ? "task-tab active" : "task-tab"}
            onClick={() => selectComparisonMode("direct")}
            role="tab"
            type="button"
          >
            {branchRefs.base}..{branchRefs.head}
          </button>
          <button
            aria-selected={comparisonMode === "working-tree"}
            className={comparisonMode === "working-tree" ? "task-tab active" : "task-tab"}
            onClick={() => selectComparisonMode("working-tree")}
            role="tab"
            type="button"
          >
            Working tree
          </button>
        </div>
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
      </div>

      <form className="diffs-ref-form" onSubmit={applyBranchRefs}>
        <label>
          <span>Base</span>
          <input
            disabled={comparisonMode === "working-tree"}
            onChange={(event) => setBaseDraft(event.target.value)}
            value={baseDraft}
          />
        </label>
        <label>
          <span>Head</span>
          <input
            disabled={comparisonMode === "working-tree"}
            onChange={(event) => setHeadDraft(event.target.value)}
            value={headDraft}
          />
        </label>
        <button
          className="btn"
          disabled={baseDraft.trim().length === 0 || headDraft.trim().length === 0}
          type="submit"
        >
          Apply
        </button>
      </form>

      <div className="diffs-summary" aria-live="polite">
        <strong>
          {diff?.displayRange ?? (comparisonMode === "working-tree" ? "Working tree" : "Diff")}
        </strong>
        {diff ? (
          <span>
            {diff.stats.files} files · +{diff.stats.additions} / -{diff.stats.deletions}
          </span>
        ) : null}
      </div>

      {diff?.truncated ? (
        <p className="diffs-notice">Patch output was truncated at {formatBytes(diff.maxBytes)}.</p>
      ) : null}
      {diffQuery.isError ? <p className="files-error">{diffQuery.error.message}</p> : null}
      {loading ? <p className="task-empty">Loading diff...</p> : null}
      {empty ? <p className="task-empty">No changes in this comparison.</p> : null}

      <div className="diffs-layout">
        <aside className="diffs-sidebar" aria-label="Changed files">
          <label className="files-search">
            <SearchIcon aria-hidden="true" />
            <input
              aria-label="Search changed files"
              onChange={(event) => treeSearch.setValue(event.target.value || null)}
              onFocus={() => treeSearch.open(treeSearch.value)}
              placeholder="Search changed files"
              value={treeSearch.value}
            />
          </label>
          {files.length > 0 ? (
            <FileTree className="diffs-file-tree" model={tree.model} />
          ) : (
            <p className="task-empty">No changed files.</p>
          )}
          <div className="diffs-file-list" aria-label="Changed file details">
            {files.map((file) => (
              <button
                className={selectedPath === file.path ? "diffs-file-row active" : "diffs-file-row"}
                key={file.path}
                onClick={() => setSelectedPath(file.path)}
                type="button"
              >
                <span className="diffs-file-row__path">{file.path}</span>
                <span className="diffs-file-row__meta">
                  {statusLabel(file.status)} · {displayStats(file)}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <div className="diffs-viewer" aria-label="Diff viewer">
          <div className="diffs-viewer__header">
            <div>
              <h3>{selectedFile?.path ?? "Patch"}</h3>
              <p>
                {selectedFile
                  ? `${statusLabel(selectedFile.status)} · ${displayStats(selectedFile)}`
                  : "Select a changed file."}
              </p>
            </div>
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
          {selectedFile?.binary ? (
            <p className="task-empty">This file is binary or too large to preview.</p>
          ) : null}
          {!selectedFile?.binary && selectedPath && !selectedCodeViewItemId ? (
            <p className="task-empty">No text patch is available for this file.</p>
          ) : null}
          {codeViewItems.length > 0 ? (
            <CodeView
              className="diffs-code-view"
              items={codeViewItems}
              onSelectedLinesChange={updateSelectedLines}
              options={{
                controlledSelection: true,
                diffStyle: viewMode,
                enableLineSelection: true,
                hunkSeparators: "line-info-basic",
                overflow: "wrap",
                stickyHeaders: true,
              }}
              ref={codeViewRef}
              selectedLines={selectedLines}
            />
          ) : !loading && !diffQuery.isError && !empty ? (
            <p className="task-empty">No text patch content to preview.</p>
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
