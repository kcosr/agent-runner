import type { UseQueryResult } from "@tanstack/react-query";
import type { RunDetail } from "@task-runner/core/contracts/runs.js";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { DrawerResizeHandle } from "../components/drawer-resize-handle.js";
import { CloseIcon } from "../components/icons.js";
import { MarkdownContent } from "../components/markdown.js";
import { StatusBadge } from "../components/status-badge.js";
import {
  type RunChatAssistantEmptyState,
  type RunChatAssistantRow,
  type RunChatRetryAttempt,
  type RunChatRow,
  deriveRunChatRows,
} from "../lib/run-chat.js";
import type { RunTimelineState } from "../lib/run-timeline.js";
import { useChatResize } from "../lib/use-chat-resize.js";
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

function runIdentity(run: RunDetail) {
  return run.runGroupId === run.runId ? run.runId : `${run.runGroupId}/${run.runId}`;
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

function AttemptDiagnostics({
  attempt,
  label,
}: {
  attempt: RunChatRetryAttempt;
  label: string;
}) {
  if (!attempt.notices.trim() && !attempt.prompt.trim()) {
    return null;
  }

  return (
    <details className="chat-details">
      <summary>{label}</summary>
      {attempt.notices.trim() ? (
        <div className="chat-diagnostic-block">
          <span className="chat-diagnostic-label">Notices</span>
          <pre>{attempt.notices}</pre>
        </div>
      ) : null}
      {attempt.prompt.trim() ? (
        <div className="chat-diagnostic-block">
          <span className="chat-diagnostic-label">Prompt</span>
          <pre>{attempt.prompt}</pre>
        </div>
      ) : null}
    </details>
  );
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
            <AttemptDiagnostics attempt={attempt} label="Notices and diagnostics" />
          </article>
        ))}
      </div>
    </details>
  );
}

function ChatRow({ row }: { row: RunChatRow }) {
  if (row.kind === "user") {
    return (
      <article className="chat-row chat-row--user">
        <div className="chat-bubble chat-bubble--user">
          <p>{row.text}</p>
        </div>
      </article>
    );
  }

  return <AssistantChatRow row={row} />;
}

function AssistantChatRow({ row }: { row: RunChatAssistantRow }) {
  return (
    <article className="chat-row chat-row--assistant">
      <div className="chat-bubble chat-bubble--assistant">
        {row.transcript.trim() ? (
          <MarkdownContent className="chat-markdown" text={row.transcript} />
        ) : (
          <p className="task-empty">{assistantEmptyText(row.emptyState)}</p>
        )}
      </div>
      <div className="chat-secondary">
        <AttemptDiagnostics attempt={row} label="Notices and diagnostics" />
        <RetryAttempts attempts={row.retryAttempts} />
      </div>
    </article>
  );
}

export function RunChatPanel({
  actionPending,
  detailSettling,
  onClose,
  onSubmitResume,
  selectedRunId,
  selectedRunQuery,
  timelineState,
}: {
  actionPending?: RunActionPending;
  detailSettling: boolean;
  onClose: () => void;
  onSubmitResume: (runId: string, message: string) => Promise<void>;
  selectedRunId?: string;
  selectedRunQuery: UseQueryResult<RunDetail, Error>;
  timelineState: RunTimelineState;
}) {
  const resize = useChatResize();
  const [draft, setDraft] = useState("");
  const [chatError, setChatError] = useState<string>();
  const listRef = useRef<HTMLDivElement | null>(null);
  const resetRunIdRef = useRef(selectedRunId);
  const stickToBottomRef = useRef(true);
  const selectedRun = selectedRunQuery.data;
  const rows = useMemo(
    () => (selectedRun ? deriveRunChatRows(selectedRun, timelineState.history) : []),
    [selectedRun, timelineState.history],
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      return <p className="chat-state chat-state--compact">Loading selected run...</p>;
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

    if (timelineState.isLoading && rows.length === 0) {
      return <p className="chat-state chat-state--compact">Loading conversation history...</p>;
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
    <aside aria-label="Run chat" className="chat-panel" style={resize.drawerStyle}>
      <DrawerResizeHandle label="Resize chat panel" resize={resize} />
      <header className="drawer-head chat-panel__head">
        <div className="drawer-title">
          <span className="run-id-large">{selectedRun ? runIdentity(selectedRun) : "Chat"}</span>
          {selectedRun ? <StatusBadge status={selectedRun.effectiveStatus} /> : null}
        </div>
        <div className="drawer-actions">
          <button aria-label="Close chat" className="icon-btn" onClick={onClose} type="button">
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
      </header>
      {selectedRun?.name ? <div className="chat-run-name">{selectedRun.name}</div> : null}
      {timelineState.stale ? (
        <div className="notice chat-notice" data-tone="warning">
          <span className="notice__message">
            Conversation updates are stale. The panel will refresh when the timeline reconnects.
          </span>
        </div>
      ) : null}
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
      <div className="chat-panel__body">{renderBody()}</div>
      <form className="chat-composer" onSubmit={(event) => void handleSubmit(event)}>
        <label className="sr-only" htmlFor="run-chat-message">
          Message
        </label>
        <textarea
          disabled={!selectedRun || resumePending || selectedRun.capabilities.canResume === false}
          id="run-chat-message"
          onChange={(event) => setDraft(event.target.value)}
          placeholder={selectedRun ? "Message this run" : "Select a run to chat"}
          rows={3}
          value={draft}
        />
        <button className="btn btn--primary" disabled={submitDisabled} type="submit">
          {resumePending ? "Sending..." : "Send"}
        </button>
      </form>
    </aside>
  );
}
