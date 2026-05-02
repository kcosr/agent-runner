import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type {
  RunTimelineEnvelope,
  RunTimelineHistory,
} from "@task-runner/core/contracts/events.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "./api-client.js";
import { useDaemonAuthToken } from "./settings.js";
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
      case "timeline_invalidated":
        return { history, requiresReload: true, showStaleWarning: false };
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
  enabled,
  runId,
  runIsLive,
  subscribeToEvents,
}: {
  config: AppRuntimeConfig;
  enabled: boolean;
  runId?: string;
  runIsLive: boolean;
  subscribeToEvents: boolean;
}): RunTimelineState {
  const { daemonToken } = useDaemonAuthToken();
  const api = useMemo(() => createApiClient(config, { daemonToken }), [config, daemonToken]);
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
  const loadInFlightRef = useRef(false);
  const reloadCountRef = useRef(0);
  const previousRunIdRef = useRef<string | undefined>(undefined);
  const previousRunIsLiveRef = useRef<boolean | undefined>(undefined);

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
      loadInFlightRef.current = false;
      historyRef.current = null;
      staleRef.current = false;
      bootstrappedRef.current = false;
      bufferRef.current = [];
      reloadCountRef.current = 0;
      previousRunIdRef.current = undefined;
      previousRunIsLiveRef.current = undefined;
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
      loadInFlightRef.current = true;
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
      } finally {
        if (loadSeq === loadSeqRef.current && loadAbortControllerRef.current === controller) {
          loadAbortControllerRef.current = null;
          loadInFlightRef.current = false;
        }
      }
    };

    // On a run-id change, reset everything. On re-entering this effect for
    // the same run (e.g. runIsLive flipping from true to false when the run
    // ends), keep the already-loaded history so the drawer doesn't flash
    // through an empty "Loading…" state.
    const sameRunId = previousRunIdRef.current === runId;
    const previousRunIsLive = sameRunId ? previousRunIsLiveRef.current : undefined;
    previousRunIdRef.current = runId;
    if (!sameRunId) {
      historyRef.current = null;
      staleRef.current = false;
      bootstrappedRef.current = false;
      bufferRef.current = [];
      reloadCountRef.current = 0;
      previousRunIsLiveRef.current = undefined;
      setState({
        history: null,
        isLoading: enabled,
        stale: false,
      });
    }

    if (!enabled) {
      previousRunIsLiveRef.current = runIsLive;
      setState((current) => ({ ...current, isLoading: false }));
      return () => {
        disposed = true;
        loadAbortControllerRef.current?.abort();
        loadAbortControllerRef.current = null;
        loadInFlightRef.current = false;
      };
    }

    const shouldLoadHistory =
      (!bootstrappedRef.current || staleRef.current || historyRef.current === null) &&
      !loadInFlightRef.current;
    const shouldRefreshForLiveTransition =
      sameRunId &&
      previousRunIsLive === false &&
      runIsLive &&
      !shouldLoadHistory &&
      !loadInFlightRef.current &&
      bootstrappedRef.current &&
      historyRef.current !== null;
    previousRunIsLiveRef.current = runIsLive;

    if (sameRunId) {
      setState((current) => ({
        ...current,
        error: shouldLoadHistory ? undefined : current.error,
        isLoading: shouldLoadHistory,
      }));
    }

    if (shouldRefreshForLiveTransition) {
      // Detail can observe a resumed live attempt before timeline replay/history
      // has projected the new attempt record. Refresh once on same-run live
      // transition so an already-open timeline catches up even if the live
      // attempt event was missed or the existing history is empty.
      void loadHistory();
    }

    if (shouldLoadHistory) {
      void loadHistory();
    }

    if (!subscribeToEvents) {
      return () => {
        disposed = true;
        loadAbortControllerRef.current?.abort();
        loadAbortControllerRef.current = null;
        loadInFlightRef.current = false;
      };
    }

    const unsubscribe = subscribeToRunTimelineEvents(config, runId, {
      daemonToken,
      onOpen: () => {
        if (disposed) {
          return;
        }
        if ((!bootstrappedRef.current || staleRef.current) && !loadInFlightRef.current) {
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
          if ((result.showStaleWarning ?? true) && !staleRef.current) {
            staleRef.current = true;
            setState((current) => ({ ...current, stale: true }));
          }
          requestReload();
          return;
        }

        reloadCountRef.current = 0;
        const previousHistory = historyRef.current;
        if (result.history === previousHistory && !staleRef.current) {
          return;
        }
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
        if (staleRef.current) {
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
      loadInFlightRef.current = false;
      unsubscribe();
    };
  }, [api, config, daemonToken, enabled, runId, runIsLive, subscribeToEvents]);

  if (!runId || state.history === null || state.history.runId === runId) {
    return state;
  }

  return {
    history: null,
    isLoading: enabled,
    stale: false,
  };
}
