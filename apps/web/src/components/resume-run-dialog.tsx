import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef } from "react";
import type { RunActionPending } from "../routes/use-runs-dashboard-state.js";
import { ChevronIcon } from "./icons.js";
import { useNativeModalDialog } from "./native-dialog.js";

export function ResumeRunDialog({
  actionError,
  actionPending,
  onClose,
  onMessageDraftChange,
  onMessageExpandedChange,
  onSubmit,
  resumeRequiresMessage,
  resumeMessageDraft,
  resumeMessageExpanded,
}: {
  actionError?: string;
  actionPending?: RunActionPending;
  onClose: () => void;
  onMessageDraftChange: (value: string) => void;
  onMessageExpandedChange: (expanded: boolean) => void;
  onSubmit: () => Promise<void>;
  resumeRequiresMessage: boolean;
  resumeMessageDraft: string;
  resumeMessageExpanded: boolean;
}) {
  const dialogRef = useNativeModalDialog(true);
  const resumeDisclosureButtonRef = useRef<HTMLButtonElement | null>(null);
  const resumeMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const resumePending = actionPending === "resume";
  const trimmedResumeMessage = resumeMessageDraft.trim();
  const showResumeMessageField = resumeRequiresMessage || resumeMessageExpanded;

  useEffect(() => {
    if (showResumeMessageField) {
      resumeMessageRef.current?.focus();
      return;
    }
    resumeDisclosureButtonRef.current?.focus();
  }, [showResumeMessageField]);

  function handleResumeMessageKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void onSubmit();
    }
  }

  return (
    <dialog
      aria-labelledby="resume-run-dialog-title"
      className="resume-dialog-backdrop"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onClose();
        }
      }}
      ref={dialogRef}
    >
      <div className="resume-dialog">
        <div className="resume-dialog__header">
          <h3 className="resume-dialog__title" id="resume-run-dialog-title">
            Resume run
          </h3>
          <p className="resume-dialog__copy">
            {resumeRequiresMessage
              ? "Send a follow-up message describing what the run should do next."
              : "Resume immediately or include an optional follow-up message."}
          </p>
        </div>
        {actionError ? (
          <div className="notice" data-tone="error">
            <span className="notice__message">{actionError}</span>
          </div>
        ) : null}
        {!resumeRequiresMessage ? (
          <div className="resume-dialog__disclosure">
            <button
              aria-controls="resume-run-message-panel"
              aria-expanded={resumeMessageExpanded}
              className="resume-dialog__disclosure-toggle"
              disabled={resumePending}
              onClick={() => onMessageExpandedChange(!resumeMessageExpanded)}
              ref={resumeDisclosureButtonRef}
              type="button"
            >
              <span>Optional message</span>
              <ChevronIcon
                aria-hidden="true"
                className={
                  resumeMessageExpanded
                    ? "resume-dialog__disclosure-icon expanded"
                    : "resume-dialog__disclosure-icon"
                }
              />
            </button>
          </div>
        ) : null}
        {showResumeMessageField ? (
          <div id="resume-run-message-panel">
            <label className="resume-dialog__field" htmlFor="resume-run-message">
              {resumeRequiresMessage ? "Message" : "Optional message"}
            </label>
            <textarea
              className="resume-dialog__textarea"
              disabled={resumePending}
              id="resume-run-message"
              onChange={(event) => onMessageDraftChange(event.target.value)}
              onKeyDown={handleResumeMessageKeyDown}
              placeholder="Describe the follow-up work for this resume..."
              ref={resumeMessageRef}
              rows={6}
              value={resumeMessageDraft}
            />
          </div>
        ) : null}
        <div className="resume-dialog__actions">
          <button className="btn" disabled={resumePending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={resumePending || (resumeRequiresMessage && trimmedResumeMessage.length === 0)}
            onClick={() => void onSubmit()}
            type="button"
          >
            {resumePending ? "Resuming..." : "Send"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
