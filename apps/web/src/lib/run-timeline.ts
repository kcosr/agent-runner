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

export interface ApplyEnvelopeResult {
  history: RunTimelineHistory;
  requiresReload: boolean;
}

const MAX_CONSECUTIVE_RELOADS = 5;

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

export function applyEnvelope(
  history: RunTimelineHistory,
  envelope: RunTimelineEnvelope,
): ApplyEnvelopeResult {
  if (envelope.cursor <= history.lastCursor) {
    return { history, requiresReload: false };
  }
  if (envelope.cursor > history.lastCursor + 1) {
    return { history, requiresReload: true };
  }

  const next = cloneHistory(history);
  next.lastCursor = envelope.cursor;

  switch (envelope.event.type) {
    case "run_initialized":
    case "caller_instructions":
    case "run_started":
      return { history: next, requiresReload: false };
    case "attempt_started":
      next.attempts = next.attempts.map((attempt) =>
        attempt.live ? { ...attempt, live: false } : attempt,
      );
      next.attempts.push({
        attempt: envelope.event.attempt,
        sessionIndex: envelope.event.sessionIndex,
        startedAt: envelope.event.startedAt,
        endedAt: null,
        prompt: envelope.event.prompt,
        transcript: "",
        notices: "",
        exitCode: null,
        timedOut: false,
        live: true,
      });
      return { history: next, requiresReload: false };
    case "agent_message_delta": {
      const activeAttempt = findLiveAttempt(next);
      if (!activeAttempt) {
        return { history, requiresReload: true };
      }
      activeAttempt.transcript += envelope.event.text;
      return { history: next, requiresReload: false };
    }
    case "backend_notice": {
      const activeAttempt = findLiveAttempt(next);
      if (!activeAttempt) {
        return { history, requiresReload: false };
      }
      activeAttempt.notices += envelope.event.text;
      return { history: next, requiresReload: false };
    }
    case "retrying":
    case "run_aborted":
    case "resume_rejected":
    case "run_finished":
      return { history, requiresReload: true };
    default:
      return { history, requiresReload: true };
  }
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
  const reloadCountRef = useRef(0);

  useEffect(() => {
    historyRef.current = state.history;
  }, [state.history]);

  useEffect(() => {
    staleRef.current = state.stale;
  }, [state.stale]);

  useEffect(() => {
    if (!runId) {
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
      setState((current) => ({ ...current, error: undefined, isLoading: true }));
      try {
        const fetched = await api.getRunTimelineHistory(runId);
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
            staleRef.current = true;
            setState((current) => ({ ...current, stale: true }));
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

    historyRef.current = null;
    staleRef.current = false;
    bootstrappedRef.current = false;
    bufferRef.current = [];
    reloadCountRef.current = 0;
    setState({ history: null, isLoading: true, stale: false });

    if (!runIsLive) {
      void loadHistory();
      return () => {
        disposed = true;
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
          staleRef.current = true;
          setState((current) => ({ ...current, stale: true }));
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
      unsubscribe();
    };
  }, [api, config, runId, runIsLive]);

  return state;
}
