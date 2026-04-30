import type { UseQueryResult } from "@tanstack/react-query";
import type { RunDetail } from "@task-runner/core/contracts/runs.js";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CloseIcon, SendIcon } from "../components/icons.js";
import { MarkdownContent } from "../components/markdown.js";
import { formatTimestamp } from "../lib/format.js";
import {
  type RunChatAssistantEmptyState,
  type RunChatAssistantRow,
  type RunChatRow,
  type RunChatSystemRow,
  deriveRunChatRows,
} from "../lib/run-chat.js";
import type { RunTimelineState } from "../lib/run-timeline.js";

const CHAT_BOTTOM_THRESHOLD_PX = 32;

function isScrolledToBottom(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_BOTTOM_THRESHOLD_PX
  );
}

function scrollElementToBottom(element: HTMLElement) {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
}

function assistantEmptyText(emptyState: RunChatAssistantEmptyState | undefined) {
  switch (emptyState) {
    case "waiting_live_response":
      return "Waiting for live response...";
    case "no_response_recorded":
      return "No response recorded.";
    case undefined:
      return "";
  }
}

function ChatConversationSkeleton() {
  return (
    <div aria-label="Loading conversation" className="chat-message-list chat-message-list--loading">
      <div className="chat-skeleton-bubble chat-skeleton-bubble--user">
        <div className="skeleton-line skeleton-line--medium" />
        <div className="skeleton-line skeleton-line--short" />
      </div>
      <div className="chat-skeleton-bubble chat-skeleton-bubble--assistant">
        <div className="skeleton-line skeleton-line--short" />
        <div className="skeleton-line skeleton-line--medium" />
        <div className="skeleton-line" />
      </div>
    </div>
  );
}

function ChatRow({ row }: { row: RunChatRow }) {
  if (row.kind === "user") {
    return (
      <article className="chat-row chat-row--user">
        <div className="chat-bubble chat-bubble--user">
          <MarkdownContent className="chat-markdown chat-markdown--user" text={row.text} />
        </div>
      </article>
    );
  }

  if (row.kind === "system") {
    return <SystemChatRow row={row} />;
  }

  return <AssistantChatRow row={row} />;
}

function SystemChatRow({ row }: { row: RunChatSystemRow }) {
  return (
    <article className="chat-row chat-row--system">
      <div className="chat-bubble chat-bubble--system">
        <span className="chat-bubble__label">System</span>
        <MarkdownContent className="chat-markdown" text={row.text} />
      </div>
    </article>
  );
}

function AssistantChatRow({ row }: { row: RunChatAssistantRow }) {
  return (
    <article className="chat-row chat-row--assistant">
      <div className="chat-output">
        {row.hasTranscript ? (
          <MarkdownContent className="chat-markdown" text={row.transcript} />
        ) : (
          <p className="task-empty">{assistantEmptyText(row.emptyState)}</p>
        )}
      </div>
    </article>
  );
}

export function RunChatView({
  detailSettling,
  onQueueMessage,
  onRemoveQueuedMessage,
  onSubmitResume,
  queuePending,
  removingQueuedMessageId,
  resumePending,
  selectedRunId,
  selectedRunQuery,
  timelineState,
}: {
  detailSettling: boolean;
  onQueueMessage: (runId: string, message: string) => Promise<void>;
  onRemoveQueuedMessage: (runId: string, messageId: string) => Promise<void>;
  onSubmitResume: (runId: string, message: string) => Promise<void>;
  queuePending: boolean;
  removingQueuedMessageId?: string;
  resumePending: boolean;
  selectedRunId: string;
  selectedRunQuery: UseQueryResult<RunDetail, Error>;
  timelineState: RunTimelineState;
}) {
  const [draft, setDraft] = useState("");
  const [chatError, setChatError] = useState<string>();
  const [queueExpanded, setQueueExpanded] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const resetRunIdRef = useRef(selectedRunId);
  const stickToBottomRef = useRef(true);
  const selectedRun = selectedRunQuery.data;
  const timelineHistory = timelineState.history;
  const timelineReady = timelineHistory !== null;
  const rows = useMemo(
    () => (selectedRun && timelineHistory ? deriveRunChatRows(selectedRun, timelineHistory) : []),
    [selectedRun, timelineHistory],
  );
  const trimmedDraft = draft.trim();
  const queueMode = selectedRun?.isLive === true;
  const submitPending = queueMode ? queuePending : resumePending;
  const submitDisabled =
    !selectedRun ||
    trimmedDraft.length === 0 ||
    submitPending ||
    (!queueMode && !selectedRun.capabilities.canResume);
  const composerActivityVisible = selectedRun?.isLive === true;
  const submitLabel = queueMode ? "Queue" : "Send";
  const submitPendingLabel = queueMode ? "Queueing..." : "Sending...";

  useEffect(() => {
    if (resetRunIdRef.current === selectedRunId) {
      return;
    }
    resetRunIdRef.current = selectedRunId;
    setDraft("");
    setChatError(undefined);
    setQueueExpanded(true);
    stickToBottomRef.current = true;
  }, [selectedRunId]);

  useEffect(() => {
    if (rows.length === 0) {
      return;
    }
    const element = listRef.current;
    if (!element || !stickToBottomRef.current) {
      return;
    }
    scrollElementToBottom(element);
  }, [rows]);

  function handleMessageListScroll() {
    const element = listRef.current;
    if (!element) {
      return;
    }
    stickToBottomRef.current = isScrolledToBottom(element);
  }

  async function submitDraft() {
    if (!selectedRun || submitDisabled) {
      return;
    }

    const runId = selectedRun.runId;
    try {
      setChatError(undefined);
      if (queueMode) {
        await onQueueMessage(runId, trimmedDraft);
      } else {
        await onSubmitResume(runId, trimmedDraft);
      }
      if (resetRunIdRef.current !== runId) {
        return;
      }
      setDraft("");
      stickToBottomRef.current = true;
    } catch (error) {
      if (resetRunIdRef.current !== runId) {
        return;
      }
      setChatError(
        error instanceof Error ? error.message : queueMode ? "Queue failed." : "Resume failed.",
      );
    }
  }

  async function removeQueuedMessage(messageId: string) {
    if (!selectedRun) {
      return;
    }

    const runId = selectedRun.runId;
    try {
      setChatError(undefined);
      await onRemoveQueuedMessage(runId, messageId);
    } catch (error) {
      if (resetRunIdRef.current !== runId) {
        return;
      }
      setChatError(error instanceof Error ? error.message : "Remove queued message failed.");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitDraft();
  }

  function handleMessageKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.blur();
      return;
    }

    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void submitDraft();
  }

  function renderBody() {
    if (detailSettling || selectedRunQuery.isPending) {
      return <ChatConversationSkeleton />;
    }

    if (selectedRunQuery.isError) {
      return (
        <div className="chat-state">
          <h3>Chat failed to load</h3>
          <p>{selectedRunQuery.error.message}</p>
          <button className="btn" onClick={() => void selectedRunQuery.refetch()} type="button">
            Retry chat load
          </button>
        </div>
      );
    }

    if (!timelineReady || (timelineState.isLoading && rows.length === 0)) {
      return <ChatConversationSkeleton />;
    }

    if (rows.length === 0) {
      return (
        <div className="chat-state">
          <h3>No conversation yet</h3>
          <p>This run has no user messages or attempts.</p>
        </div>
      );
    }

    return (
      <div className="chat-message-list" onScroll={handleMessageListScroll} ref={listRef}>
        {rows.map((row) => (
          <ChatRow key={row.id} row={row} />
        ))}
      </div>
    );
  }

  function renderQueuedMessages() {
    if (!selectedRun || selectedRun.queuedResumeMessages.length === 0) {
      return null;
    }

    const count = selectedRun.queuedResumeMessages.length;
    const label = `${count} queued`;
    return (
      <section aria-label="Queued messages" className="queued-messages-panel">
        <button
          aria-expanded={queueExpanded}
          aria-label={`${count} queued message${count === 1 ? "" : "s"}`}
          className="queued-messages-panel__toggle"
          onClick={() => setQueueExpanded((current) => !current)}
          type="button"
        >
          <span>{label}</span>
          <span aria-hidden="true" className="queued-messages-panel__chevron">
            {queueExpanded ? "Hide" : "Show"}
          </span>
        </button>
        {queueExpanded ? (
          <ul className="queued-messages-list">
            {selectedRun.queuedResumeMessages.map((message) => (
              <li className="queued-messages-list__item" key={message.id}>
                <div className="queued-messages-list__body">
                  <span className="queued-messages-list__meta">
                    {formatTimestamp(message.createdAt)}
                  </span>
                  <MarkdownContent className="chat-markdown" text={message.text} />
                </div>
                <button
                  aria-label={`Remove queued message ${message.id}`}
                  className="icon-btn icon-btn--small queued-messages-list__remove"
                  disabled={removingQueuedMessageId === message.id}
                  onClick={() => void removeQueuedMessage(message.id)}
                  title="Remove queued message"
                  type="button"
                >
                  <CloseIcon aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-label="Run chat" className="chat-view">
      {timelineState.error ? (
        <div className="notice chat-notice" data-tone="error">
          <span className="notice__message">{timelineState.error}</span>
        </div>
      ) : null}
      {chatError ? (
        <div className="notice chat-notice" data-tone="error">
          <span className="notice__message">{chatError}</span>
        </div>
      ) : null}
      {renderQueuedMessages()}
      <div className="chat-view__body">{renderBody()}</div>
      <form
        className={`chat-composer${composerActivityVisible ? " chat-composer--active" : ""}`}
        onSubmit={handleSubmit}
      >
        <label className="sr-only" htmlFor="run-chat-message">
          Message
        </label>
        <div className="chat-composer__surface">
          <textarea
            aria-keyshortcuts="Meta+Enter Ctrl+Enter Escape"
            disabled={!selectedRun}
            id="run-chat-message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleMessageKeyDown}
            rows={3}
            value={draft}
          />
          <button
            aria-label={submitLabel}
            className="chat-composer__send"
            disabled={submitDisabled}
            title={submitPending ? submitPendingLabel : submitLabel}
            type="submit"
          >
            <SendIcon aria-hidden="true" />
          </button>
        </div>
      </form>
    </section>
  );
}
