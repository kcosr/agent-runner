import type { RunDetail } from "@kcosr/agent-runner-core/contracts/runs.js";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronIcon,
  DownloadIcon,
  FileIcon,
  MessageIcon,
  PencilIcon,
  SendIcon,
  TrashIcon,
} from "../components/icons.js";
import { MarkdownContent } from "../components/markdown.js";
import { isPreviewableAttachment } from "../lib/attachments.js";
import { formatBytes, formatTimestamp } from "../lib/format.js";
import {
  type RunChatAssistantEmptyState,
  type RunChatAssistantRow,
  type RunChatAttachmentArtifact,
  type RunChatRow,
  type RunChatSystemRow,
  type RunChatTurnDivider,
  deriveRunChatRows,
} from "../lib/run-chat.js";
import type { RunTimelineState } from "../lib/run-timeline.js";

const CHAT_SCROLL_EDGE_THRESHOLD_PX = 32;

type DownloadAttachmentHandler = (
  runId: string,
  attachmentId: string,
  name: string,
) => Promise<void>;
type OpenAttachmentPreviewHandler = (attachmentOwnerRunId: string, attachmentId: string) => void;
type RunChatNonAssistantRow = Exclude<RunChatRow, RunChatAssistantRow>;

interface ArtifactActions {
  onDownloadAttachment: DownloadAttachmentHandler;
  onOpenAttachmentPreview: OpenAttachmentPreviewHandler;
  selectedRunId: string;
}

function isScrolledToBottom(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_SCROLL_EDGE_THRESHOLD_PX
  );
}

function isScrolledToTop(element: HTMLElement) {
  return element.scrollTop <= CHAT_SCROLL_EDGE_THRESHOLD_PX;
}

function scrollElementToBottom(element: HTMLElement) {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
}

function scrollElementToTop(element: HTMLElement) {
  element.scrollTop = 0;
}

function formatTurnDividerTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
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

function ChatRow({ row }: { row: RunChatNonAssistantRow }) {
  if (row.kind === "user") {
    return (
      <article className="chat-row chat-row--user">
        <div className="chat-bubble chat-bubble--user">
          <p className="chat-plain-text chat-plain-text--user">{row.text}</p>
        </div>
      </article>
    );
  }

  return <SystemChatRow row={row} />;
}

function ChatTurnDivider({ divider }: { divider: RunChatTurnDivider }) {
  return (
    <div className="chat-turn-divider" title={formatTimestamp(divider.timestamp)}>
      <span className="chat-turn-divider__line" />
      <time className="chat-turn-divider__label" dateTime={divider.timestamp}>
        {formatTurnDividerTimestamp(divider.timestamp)}
      </time>
      <span className="chat-turn-divider__line" />
    </div>
  );
}

function SystemChatRow({ row }: { row: RunChatSystemRow }) {
  const pending = row.status === "pending";
  const label = pending ? "System (PENDING)" : "System";

  return (
    <article className="chat-row chat-row--system">
      <div className="chat-bubble chat-bubble--system">
        <span className="chat-bubble__label">{label}</span>
        <MarkdownContent className="chat-markdown" text={row.text} />
      </div>
    </article>
  );
}

function ChatAttachmentArtifactCard({
  actions,
  artifact,
}: {
  actions: ArtifactActions;
  artifact: RunChatAttachmentArtifact;
}) {
  const previewable = isPreviewableAttachment(artifact);
  const primaryLabel = previewable
    ? `Preview attachment ${artifact.name}`
    : `Download attachment ${artifact.name}`;

  function downloadArtifact() {
    void actions.onDownloadAttachment(actions.selectedRunId, artifact.id, artifact.name);
  }

  function activatePrimaryAction() {
    if (previewable) {
      actions.onOpenAttachmentPreview(actions.selectedRunId, artifact.id);
      return;
    }
    downloadArtifact();
  }

  return (
    <li className="chat-artifact-card">
      <button
        aria-label={primaryLabel}
        className="chat-artifact-card__primary"
        onClick={activatePrimaryAction}
        type="button"
      >
        <span className="chat-artifact-card__icon">
          <FileIcon aria-hidden="true" />
        </span>
        <span className="chat-artifact-card__body">
          <span className="chat-artifact-card__name">{artifact.name}</span>
          <span className="chat-artifact-card__meta">
            <span>{artifact.mimeType}</span>
            <span aria-hidden="true">&middot;</span>
            <span>{formatBytes(artifact.size)}</span>
            <span aria-hidden="true">&middot;</span>
            <span>{formatTimestamp(artifact.addedAt)}</span>
          </span>
        </span>
      </button>
      <button
        aria-label={`Download ${artifact.name}`}
        className="chat-artifact-card__download"
        onClick={downloadArtifact}
        type="button"
      >
        <DownloadIcon aria-hidden="true" />
        <span>Download</span>
      </button>
    </li>
  );
}

function AssistantChatRow({
  actions,
  row,
}: {
  actions: ArtifactActions;
  row: RunChatAssistantRow;
}) {
  return (
    <article className="chat-row chat-row--assistant">
      <div className="chat-output">
        {row.hasTranscript ? (
          <MarkdownContent className="chat-markdown" text={row.transcript} />
        ) : (
          <p className="task-empty">{assistantEmptyText(row.emptyState)}</p>
        )}
        {row.artifacts.length > 0 ? (
          <ul aria-label="Assistant artifacts" className="chat-artifacts">
            {row.artifacts.map((artifact) => (
              <ChatAttachmentArtifactCard actions={actions} artifact={artifact} key={artifact.id} />
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

export function RunChatView({
  detailSettling,
  onDownloadAttachment,
  onOpenAttachmentPreview,
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
  onDownloadAttachment: DownloadAttachmentHandler;
  onOpenAttachmentPreview: OpenAttachmentPreviewHandler;
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
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const resetRunIdRef = useRef(selectedRunId);
  const stickToBottomRef = useRef(true);
  const selectedRun = selectedRunQuery.data;
  const timelineHistory = timelineState.history;
  const timelineReady = timelineHistory !== null;
  const artifactActions: ArtifactActions = {
    onDownloadAttachment,
    onOpenAttachmentPreview,
    selectedRunId,
  };
  const rows = useMemo(
    () => (selectedRun && timelineHistory ? deriveRunChatRows(selectedRun, timelineHistory) : []),
    [selectedRun, timelineHistory],
  );
  const trimmedDraft = draft.trim();
  const queueMode = selectedRun?.isLive === true;
  const submitPending = queueMode ? queuePending : resumePending;
  const composerDisabled = !selectedRun || selectedRun.archivedAt !== null;
  const submitDisabled =
    composerDisabled ||
    trimmedDraft.length === 0 ||
    submitPending ||
    (!queueMode && selectedRun?.capabilities.canResume !== true);
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
    stickToBottomRef.current = true;
    setShowScrollToTop(false);
    setShowScrollToBottom(false);
  }, [selectedRunId]);

  useEffect(() => {
    if (rows.length === 0) {
      setShowScrollToTop(false);
      setShowScrollToBottom(false);
      return;
    }
    const element = listRef.current;
    if (!element) {
      return;
    }
    if (stickToBottomRef.current) {
      scrollElementToBottom(element);
      setShowScrollToTop(!isScrolledToTop(element));
      setShowScrollToBottom(false);
      return;
    }
    setShowScrollToTop(!isScrolledToTop(element));
    setShowScrollToBottom(!isScrolledToBottom(element));
  }, [rows]);

  function handleMessageListScroll() {
    const element = listRef.current;
    if (!element) {
      return;
    }
    const atBottom = isScrolledToBottom(element);
    stickToBottomRef.current = atBottom;
    setShowScrollToTop(!isScrolledToTop(element));
    setShowScrollToBottom(!atBottom);
  }

  function handleScrollToTop() {
    const element = listRef.current;
    if (!element) {
      return;
    }
    scrollElementToTop(element);
    stickToBottomRef.current = isScrolledToBottom(element);
    setShowScrollToTop(false);
    setShowScrollToBottom(!stickToBottomRef.current);
  }

  function handleScrollToBottom() {
    const element = listRef.current;
    if (!element) {
      return;
    }
    scrollElementToBottom(element);
    stickToBottomRef.current = true;
    setShowScrollToTop(!isScrolledToTop(element));
    setShowScrollToBottom(false);
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

  async function editQueuedMessage(message: RunDetail["queuedResumeMessages"][number]) {
    if (!selectedRun || composerDisabled) {
      return;
    }
    setDraft(message.text);
    composerRef.current?.focus();
    await removeQueuedMessage(message.id);
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
          <Fragment key={row.id}>
            {row.turnDivider ? <ChatTurnDivider divider={row.turnDivider} /> : null}
            {row.kind === "assistant" ? (
              <AssistantChatRow actions={artifactActions} row={row} />
            ) : (
              <ChatRow row={row} />
            )}
          </Fragment>
        ))}
      </div>
    );
  }

  function renderQueuedMessages() {
    if (!selectedRun || selectedRun.queuedResumeMessages.length === 0) {
      return null;
    }

    return (
      <section aria-label="Queued messages" className="queued-messages-panel">
        <ul className="queued-messages-list">
          {selectedRun.queuedResumeMessages.map((message) => (
            <li
              className="queued-messages-list__item"
              key={message.id}
              title={`Queued ${formatTimestamp(message.createdAt)}`}
            >
              <span className="queued-messages-list__icon">
                <MessageIcon aria-hidden="true" />
              </span>
              <div className="queued-messages-list__body">
                <MarkdownContent className="chat-markdown" text={message.text} />
              </div>
              <div className="queued-messages-list__actions">
                <button
                  aria-label={`Edit queued message ${message.id}`}
                  className="icon-btn icon-btn--small queued-messages-list__edit"
                  disabled={removingQueuedMessageId === message.id || composerDisabled}
                  onClick={() => void editQueuedMessage(message)}
                  title="Edit queued message"
                  type="button"
                >
                  <PencilIcon aria-hidden="true" />
                </button>
                <button
                  aria-label={`Remove queued message ${message.id}`}
                  className="icon-btn icon-btn--small queued-messages-list__remove"
                  disabled={removingQueuedMessageId === message.id}
                  onClick={() => void removeQueuedMessage(message.id)}
                  title="Remove queued message"
                  type="button"
                >
                  <TrashIcon aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
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
      <div className="chat-view__body">
        {renderBody()}
        <div className="chat-scroll-controls">
          <button
            aria-hidden={showScrollToTop ? "false" : "true"}
            aria-label="Scroll to top"
            className={`chat-scroll-control chat-scroll-control--top${showScrollToTop ? " chat-scroll-control--visible" : ""}`}
            onClick={handleScrollToTop}
            tabIndex={showScrollToTop ? 0 : -1}
            type="button"
          >
            <ChevronIcon aria-hidden="true" />
          </button>
          <button
            aria-hidden={showScrollToBottom ? "false" : "true"}
            aria-label="Scroll to bottom"
            className={`chat-scroll-control chat-scroll-control--bottom${showScrollToBottom ? " chat-scroll-control--visible" : ""}`}
            onClick={handleScrollToBottom}
            tabIndex={showScrollToBottom ? 0 : -1}
            type="button"
          >
            <ChevronIcon aria-hidden="true" />
          </button>
        </div>
      </div>
      <form
        className={`chat-composer${composerActivityVisible ? " chat-composer--active" : ""}`}
        onSubmit={handleSubmit}
      >
        {renderQueuedMessages()}
        <label className="sr-only" htmlFor="run-chat-message">
          Message
        </label>
        <div className="chat-composer__surface">
          <textarea
            aria-keyshortcuts="Meta+Enter Ctrl+Enter Escape"
            disabled={composerDisabled}
            id="run-chat-message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleMessageKeyDown}
            ref={composerRef}
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
