import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type TaskReference, buildTaskBody } from "../lib/task-reference.js";
import { useNativeModalDialog } from "./native-dialog.js";

export function CreateTaskDialog({
  initialInstruction = "",
  initialTitle,
  onClose,
  onSubmit,
  pending,
  reference,
  submitError,
}: {
  initialInstruction?: string;
  initialTitle: string;
  onClose: () => void;
  onSubmit: (input: { body: string; title: string }) => Promise<void>;
  pending: boolean;
  reference: TaskReference | null;
  submitError?: string;
}) {
  const { dialogProps, ref: dialogRef } = useNativeModalDialog(true, onClose);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [instruction, setInstruction] = useState(initialInstruction);
  const trimmedTitle = title.trim();
  const trimmedInstruction = instruction.trim();
  const body = useMemo(() => buildTaskBody(reference, instruction), [instruction, reference]);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void submit();
    }
  }

  async function submit() {
    if (pending || trimmedTitle.length === 0 || trimmedInstruction.length === 0) {
      return;
    }
    await onSubmit({ body, title: trimmedTitle });
  }

  return (
    <dialog
      aria-labelledby="create-task-dialog-title"
      className="resume-dialog-backdrop"
      {...dialogProps}
      ref={dialogRef}
    >
      <div className="resume-dialog create-task-dialog">
        <div className="resume-dialog__header">
          <h3 className="resume-dialog__title" id="create-task-dialog-title">
            Create task
          </h3>
        </div>
        {submitError ? (
          <div className="notice" data-tone="error">
            <span className="notice__message">{submitError}</span>
          </div>
        ) : null}
        <label className="resume-dialog__field" htmlFor="create-task-title">
          Title
        </label>
        <input
          className="settings-input create-task-dialog__input"
          disabled={pending}
          id="create-task-title"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={handleKeyDown}
          ref={titleRef}
          value={title}
        />
        <label className="resume-dialog__field" htmlFor="create-task-instruction">
          Instruction
        </label>
        <textarea
          className="resume-dialog__textarea"
          disabled={pending}
          id="create-task-instruction"
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what the agent should do with this selection."
          rows={5}
          value={instruction}
        />
        <label className="resume-dialog__field" htmlFor="create-task-body-preview">
          Reference preview
        </label>
        <pre className="create-task-dialog__preview" id="create-task-body-preview">
          {body}
        </pre>
        <div className="resume-dialog__actions">
          <button className="btn" disabled={pending} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={pending || trimmedTitle.length === 0 || trimmedInstruction.length === 0}
            onClick={() => void submit()}
            type="button"
          >
            {pending ? "Creating..." : "Create task"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
