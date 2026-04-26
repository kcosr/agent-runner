import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type {
  RunTimelineEnvelope,
  RunTimelineHistory,
} from "@task-runner/core/contracts/events.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "./api-client.js";
import { subscribeToRunTimelineEvents } from "./sse.js";

export interface RunTimelineState {
  error?: string;
  history: RunTimelineHistory | null;
  isLoading: boolean;
  stale: boolean;
}

export interface ApplyEnvelopeResult<THistory> {
  history: THistory;
  requiresReload: boolean;
  showStaleWarning?: boolean;
}

interface CursoredEnvelope {
  cursor: number;
}

const MAX_CONSECUTIVE_RELOADS = 5;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function cloneHistory(history: RunTimelineHistory): RunTimelineHistory {
  return {
    ...history,
    attempts: history.attempts.map((attempt) => ({ ...attempt })),
  };
}

function findLiveAttempt(history: RunTimelineHistory) {
  for (let index = history.attempts.length - 1; index >= 0; index--) {
    const attempt = history.attempts[index];
    if (attempt?.live) {
      return attempt;
    }
  }
  return null;
}

export function applyCursoredEnvelope<
  THistory extends { lastCursor: number },
  TEnvelope extends CursoredEnvelope,
>(
  history: THistory,
  envelope: TEnvelope,
  cloneHistory: (history: THistory) => THistory,
  apply: (history: THistory, envelope: TEnvelope) => ApplyEnvelopeResult<THistory>,
): ApplyEnvelopeResult<THistory> {
  if (envelope.cursor <= history.lastCursor) {
    return { history, requiresReload: false, showStaleWarning: false };
  }
  if (envelope.cursor > history.lastCursor + 1) {
    return { history, requiresReload: true, showStaleWarning: true };
  }
  const next = cloneHistory(history);
  next.lastCursor = envelope.cursor;
  return apply(next, envelope);
}

export function applyEnvelope(
  history: RunTimelineHistory,
  envelope: RunTimelineEnvelope,
): ApplyEnvelopeResult<RunTimelineHistory> {
  return applyCursoredEnvelope(history, envelope, cloneHistory, (next) => {
    switch (envelope.event.type) {
      case "run_initialized":
      case "caller_instructions":
      case "run_started":
        return { history: next, requiresReload: false, showStaleWarning: false };
      case "attempt_started":
        next.attempts = next.attempts.map((attempt) =>
          attempt.live ? { ...attempt, live: false } : attempt,
        );
        next.attempts.push({
          attemptNumber: envelope.event.attemptNumber,
          sessionIndex: envelope.event.sessionIndex,
          attemptIndexInSession: envelope.event.attemptIndexInSession,
          startedAt: envelope.event.startedAt,
          endedAt: null,
          prompt: envelope.event.prompt,
          transcript: "",
          notices: "",
          exitCode: null,
          timedOut: false,
          live: true,
        });
        return { history: next, requiresReload: false, showStaleWarning: false };
      case "agent_message_delta": {
        const activeAttempt = findLiveAttempt(next);
        if (!activeAttempt) {
          return { history, requiresReload: true, showStaleWarning: true };
        }
        activeAttempt.transcript += envelope.event.text;
        return { history: next, requiresReload: false, showStaleWarning: false };
      }
      case "backend_notice": {
        const activeAttempt = findLiveAttempt(next);
        if (!activeAttempt) {
          return { history, requiresReload: false, showStaleWarning: false };
        }
        activeAttempt.notices += envelope.event.text;
        return { history: next, requiresReload: false, showStaleWarning: false };
      }
      case "retrying":
      case "run_aborted":
      case "resume_rejected":
      case "run_finished":
        return { history, requiresReload: true, showStaleWarning: false };
      default:
        return { history, requiresReload: true, showStaleWarning: true };
    }
  });
}

export function useRunTimelineState({
  config,
  runId,
  runIsLive,
}: {
  config: AppRuntimeConfig;
  runId?: string;
  runIsLive: boolean;
}): RunTimelineState {
  const api = useMemo(() => createApiClient(config), [config]);
  const [state, setState] = useState<RunTimelineState>({
    history: null,
    isLoading: false,
    stale: false,
  });
  const historyRef = useRef<RunTimelineHistory | null>(null);
  const staleRef = useRef(false);
  const bootstrappedRef = useRef(false);
  const bufferRef = useRef<RunTimelineEnvelope[]>([]);
  const loadSeqRef = useRef(0);
  const loadAbortControllerRef = useRef<AbortController | null>(null);
  const reloadCountRef = useRef(0);
  const previousRunIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    historyRef.current = state.history;
  }, [state.history]);

  useEffect(() => {
    staleRef.current = state.stale;
  }, [state.stale]);

  useEffect(() => {
    if (!runId) {
      loadAbortControllerRef.current?.abort();
      loadAbortControllerRef.current = null;
      historyRef.current = null;
      staleRef.current = false;
      bootstrappedRef.current = false;
      bufferRef.current = [];
      setState({ history: null, isLoading: false, stale: false });
      return;
    }

    let disposed = false;
    const requestReload = () => {
      if (disposed) {
        return;
      }
      reloadCountRef.current += 1;
      if (reloadCountRef.current > MAX_CONSECUTIVE_RELOADS) {
        staleRef.current = true;
        setState((current) => ({
          ...current,
          isLoading: false,
          stale: true,
        }));
        return;
      }
      void loadHistory();
    };

    const loadHistory = async () => {
      const loadSeq = ++loadSeqRef.current;
      loadAbortControllerRef.current?.abort();
      const controller = new AbortController();
      loadAbortControllerRef.current = controller;
      setState((current) => ({ ...current, error: undefined, isLoading: true }));
      try {
        const fetched = await api.getRunTimelineHistory(runId, { signal: controller.signal });
        if (disposed || loadSeq !== loadSeqRef.current) {
          return;
        }

        let merged = fetched;
        for (const envelope of [...bufferRef.current].sort(
          (left, right) => left.cursor - right.cursor,
        )) {
          const result = applyEnvelope(merged, envelope);
          if (result.requiresReload) {
            bufferRef.current = [];
            if (result.showStaleWarning ?? true) {
              staleRef.current = true;
              setState((current) => ({ ...current, stale: true }));
            }
            requestReload();
            return;
          }
          merged = result.history;
        }

        bufferRef.current = bufferRef.current.filter(
          (envelope) => envelope.cursor > merged.lastCursor,
        );
        bootstrappedRef.current = true;
        reloadCountRef.current = 0;
        historyRef.current = merged;
        staleRef.current = false;
        setState({
          history: merged,
          isLoading: false,
          stale: false,
        });
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        if (disposed || loadSeq !== loadSeqRef.current) {
          return;
        }
        setState({
          error: error instanceof Error ? error.message : "Timeline failed to load",
          history: historyRef.current,
          isLoading: false,
          stale: true,
        });
        staleRef.current = true;
      }
    };

    // On a run-id change, reset everything. On re-entering this effect for
    // the same run (e.g. runIsLive flipping from true to false when the run
    // ends), keep the already-loaded history so the drawer doesn't flash
    // through an empty "Loading…" state.
    const sameRunId = previousRunIdRef.current === runId;
    previousRunIdRef.current = runId;
    if (!sameRunId) {
      historyRef.current = null;
      staleRef.current = false;
      bootstrappedRef.current = false;
      bufferRef.current = [];
      reloadCountRef.current = 0;
      setState({ history: null, isLoading: true, stale: false });
    } else {
      setState((current) => ({ ...current, isLoading: true, error: undefined }));
    }

    if (!runIsLive) {
      void loadHistory();
      return () => {
        disposed = true;
        loadAbortControllerRef.current?.abort();
        loadAbortControllerRef.current = null;
      };
    }

    const unsubscribe = subscribeToRunTimelineEvents(config, runId, {
      onOpen: () => {
        if (disposed) {
          return;
        }
        if (!bootstrappedRef.current || staleRef.current) {
          void loadHistory();
        }
      },
      onEvent: (envelope) => {
        if (disposed) {
          return;
        }
        if (!bootstrappedRef.current || !historyRef.current) {
          bufferRef.current.push(envelope);
          return;
        }

        const result = applyEnvelope(historyRef.current, envelope);
        if (result.requiresReload) {
          bufferRef.current = [];
          if (result.showStaleWarning ?? true) {
            staleRef.current = true;
            setState((current) => ({ ...current, stale: true }));
          }
          requestReload();
          return;
        }

        reloadCountRef.current = 0;
        historyRef.current = result.history;
        staleRef.current = false;
        setState({
          history: result.history,
          isLoading: false,
          stale: false,
        });
      },
      onStaleChange: (stale) => {
        if (disposed || !stale) {
          return;
        }
        staleRef.current = true;
        setState((current) => ({ ...current, stale: true }));
      },
    });

    return () => {
      disposed = true;
      loadAbortControllerRef.current?.abort();
      loadAbortControllerRef.current = null;
      unsubscribe();
    };
  }, [api, config, runId, runIsLive]);

  return state;
}
