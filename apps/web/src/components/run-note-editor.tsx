import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { MarkdownContent } from "./markdown.js";
import { useNativeModalDialog } from "./native-dialog.js";

type RunNoteEditorMode = "preview" | "edit";

const HOVERLESS_MEDIA_QUERY = "(hover: none)";
const COARSE_POINTER_MEDIA_QUERY = "(pointer: coarse)";

function prefersPreviewFirst() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return (
    window.matchMedia(HOVERLESS_MEDIA_QUERY).matches ||
    window.matchMedia(COARSE_POINTER_MEDIA_QUERY).matches
  );
}

export function usePreferredRunNoteEditorMode(): RunNoteEditorMode {
  const [mode, setMode] = useState<RunNoteEditorMode>(() =>
    prefersPreviewFirst() ? "preview" : "edit",
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const hoverlessMediaQuery = window.matchMedia(HOVERLESS_MEDIA_QUERY);
    const coarsePointerMediaQuery = window.matchMedia(COARSE_POINTER_MEDIA_QUERY);
    const update = () => {
      setMode(hoverlessMediaQuery.matches || coarsePointerMediaQuery.matches ? "preview" : "edit");
    };
    update();

    if (
      typeof hoverlessMediaQuery.addEventListener === "function" &&
      typeof coarsePointerMediaQuery.addEventListener === "function"
    ) {
      hoverlessMediaQuery.addEventListener("change", update);
      coarsePointerMediaQuery.addEventListener("change", update);
      return () => {
        hoverlessMediaQuery.removeEventListener("change", update);
        coarsePointerMediaQuery.removeEventListener("change", update);
      };
    }

    hoverlessMediaQuery.addListener(update);
    coarsePointerMediaQuery.addListener(update);
    return () => {
      hoverlessMediaQuery.removeListener(update);
      coarsePointerMediaQuery.removeListener(update);
    };
  }, []);

  return mode;
}

export function RunNoteEditor({
  autoFocusEditor = false,
  closeOnCancel = false,
  closeOnSave = false,
  editRequestVersion,
  emptyPreviewMessage,
  initialMode,
  note,
  onClose,
  onSave,
  pending,
  textareaLabel,
}: {
  autoFocusEditor?: boolean;
  closeOnCancel?: boolean;
  closeOnSave?: boolean;
  editRequestVersion?: number;
  emptyPreviewMessage: string;
  initialMode: RunNoteEditorMode;
  note: string | null;
  onClose?: () => void;
  onSave: (note: string | null) => Promise<void>;
  pending: boolean;
  textareaLabel: string;
}) {
  const [draft, setDraft] = useState(note ?? "");
  const [mode, setMode] = useState<RunNoteEditorMode>(initialMode);
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);
  const noteRef = useRef(note);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastEditRequestVersionRef = useRef(editRequestVersion);
  const focusTimeoutRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollTimeoutRef = useRef<number | null>(null);
  const textareaId = useId();
  const confirmTitleId = useId();
  const dirty = draft !== (note ?? "");
  const { dialogProps: confirmDialogProps, ref: confirmDialogRef } = useNativeModalDialog(
    confirmExitOpen,
    () => setConfirmExitOpen(false),
  );

  useEffect(() => {
    if (noteRef.current === note) {
      return;
    }
    noteRef.current = note;
    setDraft(note ?? "");
    setMode(initialMode);
  }, [initialMode, note]);

  useEffect(() => {
    if (
      editRequestVersion === undefined ||
      editRequestVersion === lastEditRequestVersionRef.current
    ) {
      return;
    }
    lastEditRequestVersionRef.current = editRequestVersion;
    setMode("edit");
    scheduleFocusTextareaEnd();
  }, [editRequestVersion]);

  useEffect(
    () => () => {
      cancelScheduledFocus();
      cancelScheduledScroll();
    },
    [],
  );

  useEffect(() => {
    if (!autoFocusEditor || mode !== "edit" || pending) {
      return;
    }
    focusTextareaEnd();
  }, [autoFocusEditor, mode, pending]);

  function cancelScheduledFocus() {
    if (focusTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(focusTimeoutRef.current);
    focusTimeoutRef.current = null;
  }

  function cancelScheduledScroll() {
    if (scrollFrameRef.current !== null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    if (scrollTimeoutRef.current !== null) {
      window.clearTimeout(scrollTimeoutRef.current);
    }
    scrollFrameRef.current = null;
    scrollTimeoutRef.current = null;
  }

  function scheduleFocusTextareaEnd() {
    cancelScheduledFocus();
    focusTimeoutRef.current = window.setTimeout(() => {
      focusTimeoutRef.current = null;
      focusTextareaEnd();
    }, 0);
  }

  function scheduleScrollTextareaToBottom(textarea: HTMLTextAreaElement) {
    cancelScheduledScroll();
    const scrollToBottom = () => {
      if (textareaRef.current !== textarea) {
        return;
      }
      textarea.scrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
    };
    scrollToBottom();
    if (typeof window.requestAnimationFrame === "function") {
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        scrollToBottom();
      });
      return;
    }
    scrollTimeoutRef.current = window.setTimeout(() => {
      scrollTimeoutRef.current = null;
      scrollToBottom();
    }, 0);
  }

  function focusTextareaEnd() {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus({ preventScroll: true });
    const selectionStart = textarea.value.length;
    textarea.setSelectionRange(selectionStart, selectionStart);
    scheduleScrollTextareaToBottom(textarea);
  }

  function finishCancel() {
    setDraft(note ?? "");
    setConfirmExitOpen(false);
    if (closeOnCancel) {
      onClose?.();
      return;
    }
    setMode("preview");
  }

  function handleCancel() {
    if (pending) {
      return;
    }
    if (dirty) {
      setConfirmExitOpen(true);
      return;
    }
    finishCancel();
  }

  async function saveDraft(): Promise<boolean> {
    if (pending) {
      return false;
    }
    const nextNote = draft.trim().length === 0 ? null : draft;
    if (nextNote === note) {
      return true;
    }

    try {
      await onSave(nextNote);
      return true;
    } catch {
      // The shared mutation path surfaces errors elsewhere in the UI.
      return false;
    }
  }

  async function handleSave() {
    const saved = await saveDraft();
    if (!saved) {
      return;
    }
    setConfirmExitOpen(false);
    if (closeOnSave) {
      onClose?.();
      return;
    }
    setMode("preview");
  }

  function handleTextareaKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      handleCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.altKey)) {
      event.preventDefault();
      event.stopPropagation();
      void handleSave();
    }
  }

  return (
    <div className="note-editor">
      {mode === "preview" ? (
        <div aria-label="Run note preview" className="note-editor__preview">
          <button
            className="btn btn--quiet note-editor__edit-button"
            onClick={() => setMode("edit")}
            type="button"
          >
            Edit
          </button>
          <div className="note-editor__preview-content">
            {note ? (
              <MarkdownContent className="note-editor__markdown" text={note} />
            ) : (
              <p className="note-editor__empty">{emptyPreviewMessage}</p>
            )}
          </div>
        </div>
      ) : (
        <label className="note-editor__field" htmlFor={textareaId}>
          <span className="sr-only">{textareaLabel}</span>
          <textarea
            aria-label={textareaLabel}
            className="note-editor__textarea"
            disabled={pending}
            id={textareaId}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder="Write markdown notes for this run."
            ref={textareaRef}
            value={draft}
          />
        </label>
      )}

      {mode === "edit" ? (
        <div className="note-editor__actions">
          <button className="btn" disabled={pending} onClick={handleCancel} type="button">
            Cancel
          </button>
          <button
            aria-keyshortcuts="Alt+Enter Meta+Enter Ctrl+Enter"
            className="btn btn-primary"
            disabled={pending}
            onClick={() => void handleSave()}
            title="Save note (Alt/Cmd/Ctrl+Enter)"
            type="button"
          >
            {pending ? "Saving..." : "Save"}
          </button>
        </div>
      ) : null}

      {confirmExitOpen ? (
        <dialog
          aria-labelledby={confirmTitleId}
          className="note-dialog-backdrop"
          {...confirmDialogProps}
          ref={confirmDialogRef}
        >
          <div className="note-dialog note-dialog--confirm" role="document">
            <div className="note-dialog__header">
              <div>
                <h3 className="note-dialog__title" id={confirmTitleId}>
                  Save note changes?
                </h3>
                <p className="note-dialog__copy">
                  Your note has unsaved changes. Save them before leaving edit mode?
                </p>
              </div>
            </div>
            <div className="note-editor__actions">
              <button
                className="btn btn--quiet"
                disabled={pending}
                onClick={() => {
                  setConfirmExitOpen(false);
                  scheduleFocusTextareaEnd();
                }}
                type="button"
              >
                Cancel
              </button>
              <button className="btn" disabled={pending} onClick={finishCancel} type="button">
                Discard
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() => void handleSave()}
                type="button"
              >
                {pending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
