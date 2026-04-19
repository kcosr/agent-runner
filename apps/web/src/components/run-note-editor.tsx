import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { MarkdownContent } from "./markdown.js";

export type RunNoteEditorMode = "preview" | "edit";

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
  closeOnCancel = false,
  closeOnSave = false,
  emptyPreviewMessage,
  initialMode,
  note,
  onClose,
  onSave,
  pending,
  textareaLabel,
}: {
  closeOnCancel?: boolean;
  closeOnSave?: boolean;
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
  const noteRef = useRef(note);
  const textareaId = useId();

  useEffect(() => {
    if (noteRef.current === note) {
      return;
    }
    noteRef.current = note;
    setDraft(note ?? "");
    setMode(initialMode);
  }, [initialMode, note]);

  function handleCancel() {
    if (pending) {
      return;
    }
    setDraft(note ?? "");
    if (closeOnCancel) {
      onClose?.();
      return;
    }
    setMode("preview");
  }

  async function handleSave() {
    if (pending) {
      return;
    }
    const nextNote = draft.trim().length === 0 ? null : draft;
    if (nextNote === note) {
      if (closeOnSave) {
        onClose?.();
        return;
      }
      setMode("preview");
      return;
    }

    try {
      await onSave(nextNote);
      if (closeOnSave) {
        onClose?.();
        return;
      }
      setMode("preview");
    } catch {
      // The shared mutation path surfaces errors elsewhere in the UI.
    }
  }

  function handleTextareaKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      handleCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void handleSave();
    }
  }

  return (
    <div className="note-editor">
      <div className="note-editor__toolbar">
        <div aria-label="Note view" className="note-editor__mode-switch" role="toolbar">
          <button
            aria-pressed={mode === "preview"}
            className={mode === "preview" ? "btn btn--quiet active" : "btn btn--quiet"}
            onClick={() => setMode("preview")}
            type="button"
          >
            View
          </button>
          <button
            aria-pressed={mode === "edit"}
            className={mode === "edit" ? "btn btn--quiet active" : "btn btn--quiet"}
            onClick={() => setMode("edit")}
            type="button"
          >
            Edit
          </button>
        </div>
      </div>

      {mode === "preview" ? (
        <div aria-label="Run note preview" className="note-editor__preview">
          {note ? (
            <MarkdownContent className="note-editor__markdown" text={note} />
          ) : (
            <p className="note-editor__empty">{emptyPreviewMessage}</p>
          )}
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
            aria-keyshortcuts="Meta+Enter Ctrl+Enter"
            className="btn btn-primary"
            disabled={pending}
            onClick={() => void handleSave()}
            title="Save note (Cmd/Ctrl+Enter)"
            type="button"
          >
            {pending ? "Saving..." : "Save"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
