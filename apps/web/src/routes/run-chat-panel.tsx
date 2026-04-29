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
import { MarkdownContent } from "../components/markdown.js";
import {
  type RunChatAssistantEmptyState,
  type RunChatAssistantRow,
  type RunChatRetryAttempt,
  type RunChatRow,
  type RunChatSystemRow,
  deriveRunChatRows,
} from "../lib/run-chat.js";
import type { RunTimelineState } from "../lib/run-timeline.js";
import type { RunActionPending } from "./use-runs-dashboard-state.js";

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

function renderAttemptMeta(attempt: RunChatRetryAttempt) {
  const meta = [`Attempt ${attempt.attemptNumber}`];
  if (attempt.live) {
    meta.push("live");
  }
  if (attempt.timedOut) {
    meta.push("timed out");
  }
  if (attempt.exitCode !== null) {
    meta.push(`exit ${attempt.exitCode}`);
  }
  return meta.join(" · ");
}

function RetryAttempts({ attempts }: { attempts: RunChatRetryAttempt[] }) {
  if (attempts.length === 0) {
    return null;
  }

  return (
    <details className="chat-details">
      <summary>
        {attempts.length} prior {attempts.length === 1 ? "attempt" : "attempts"}
      </summary>
      <div className="chat-retry-list">
        {attempts.map((attempt) => (
          <article className="chat-retry" key={attempt.attemptNumber}>
            <div className="chat-retry__meta">{renderAttemptMeta(attempt)}</div>
            {attempt.transcript.trim() ? (
              <MarkdownContent className="chat-markdown" text={attempt.transcript} />
            ) : (
              <p className="task-empty">{assistantEmptyText(attempt.emptyState)}</p>
            )}
          </article>
        ))}
      </div>
    </details>
  );
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
        {row.transcript.trim() ? (
          <MarkdownContent className="chat-markdown" text={row.transcript} />
        ) : (
          <p className="task-empty">{assistantEmptyText(row.emptyState)}</p>
        )}
      </div>
      <div className="chat-secondary">
        <RetryAttempts attempts={row.retryAttempts} />
      </div>
    </article>
  );
}

export function RunChatView({
  actionPending,
  detailSettling,
  onSubmitResume,
  selectedRunId,
  selectedRunQuery,
  timelineState,
}: {
  actionPending?: RunActionPending;
  detailSettling: boolean;
  onSubmitResume: (runId: string, message: string) => Promise<void>;
  selectedRunId?: string;
  selectedRunQuery: UseQueryResult<RunDetail, Error>;
  timelineState: RunTimelineState;
}) {
  const [draft, setDraft] = useState("");
  const [chatError, setChatError] = useState<string>();
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
  const resumePending = actionPending === "resume";
  const trimmedDraft = draft.trim();
  const submitDisabled =
    !selectedRun ||
    trimmedDraft.length === 0 ||
    resumePending ||
    !selectedRun.capabilities.canResume;

  useEffect(() => {
    if (resetRunIdRef.current === selectedRunId) {
      return;
    }
    resetRunIdRef.current = selectedRunId;
    setDraft("");
    setChatError(undefined);
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
      await onSubmitResume(runId, trimmedDraft);
      if (resetRunIdRef.current !== runId) {
        return;
      }
      setDraft("");
      stickToBottomRef.current = true;
    } catch (error) {
      if (resetRunIdRef.current !== runId) {
        return;
      }
      setChatError(error instanceof Error ? error.message : "Resume failed.");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitDraft();
  }

  function handleMessageKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void submitDraft();
  }

  function renderBody() {
    if (!selectedRunId) {
      return (
        <div className="chat-state">
          <h3>Select a run</h3>
          <p>Choose a board card to view its conversation.</p>
        </div>
      );
    }

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
      <div className="chat-view__body">{renderBody()}</div>
      <form className="chat-composer" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="run-chat-message">
          Message
        </label>
        <textarea
          aria-keyshortcuts="Meta+Enter Ctrl+Enter"
          disabled={!selectedRun}
          id="run-chat-message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleMessageKeyDown}
          rows={3}
          value={draft}
        />
        <button className="btn btn--primary" disabled={submitDisabled} type="submit">
          {resumePending ? "Sending..." : "Send"}
        </button>
      </form>
    </section>
  );
}
