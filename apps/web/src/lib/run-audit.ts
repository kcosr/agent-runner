import type { AppRuntimeConfig } from "@agent-runner/core/contracts/app-config.js";
import type { RunAuditEnvelope, RunAuditHistory } from "@agent-runner/core/contracts/events.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "./api-client.js";
import { type ApplyEnvelopeResult, applyCursoredEnvelope } from "./run-timeline.js";
import { useDaemonAuthToken } from "./settings.js";
import { subscribeToRunAuditEvents } from "./sse.js";

export interface RunAuditState {
  error?: string;
  history: RunAuditHistory | null;
  isLoading: boolean;
  stale: boolean;
  reload: () => void;
}

const MAX_CONSECUTIVE_RELOADS = 5;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function cloneHistory(history: RunAuditHistory): RunAuditHistory {
  return {
    ...history,
    events: history.events.map((event) => ({
      ...event,
      event: {
        ...event.event,
        fields: { ...event.event.fields },
      },
    })),
  };
}

export function applyAuditEnvelope(
  history: RunAuditHistory,
  envelope: RunAuditEnvelope,
): ApplyEnvelopeResult<RunAuditHistory> {
  return applyCursoredEnvelope(history, envelope, cloneHistory, (next, currentEnvelope) => {
    next.events.push(currentEnvelope);
    return { history: next, requiresReload: false };
  });
}

export function useRunAuditState({
  config,
  enabled,
  runId,
}: {
  config: AppRuntimeConfig;
  enabled: boolean;
  runId?: string;
}): RunAuditState {
  const { daemonToken } = useDaemonAuthToken();
  const api = useMemo(() => createApiClient(config, { daemonToken }), [config, daemonToken]);
  const [state, setState] = useState<Omit<RunAuditState, "reload">>({
    history: null,
    isLoading: false,
    stale: false,
  });
  const historyRef = useRef<RunAuditHistory | null>(null);
  const staleRef = useRef(false);
  const bootstrappedRef = useRef(false);
  const bufferRef = useRef<RunAuditEnvelope[]>([]);
  const loadSeqRef = useRef(0);
  const loadAbortControllerRef = useRef<AbortController | null>(null);
  const reloadCountRef = useRef(0);
  const previousRunIdRef = useRef<string | undefined>(undefined);
  const reloadRef = useRef<() => void>(() => {});

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
      reloadCountRef.current = 0;
      previousRunIdRef.current = undefined;
      setState({ history: null, isLoading: false, stale: false });
      reloadRef.current = () => {};
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
        const fetched = await api.getRunAuditHistory(runId, { signal: controller.signal });
        if (disposed || loadSeq !== loadSeqRef.current) {
          return;
        }

        let merged = fetched;
        for (const envelope of [...bufferRef.current].sort(
          (left, right) => left.cursor - right.cursor,
        )) {
          const result = applyAuditEnvelope(merged, envelope);
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
        if (isAbortError(error)) {
          return;
        }
        if (disposed || loadSeq !== loadSeqRef.current) {
          return;
        }
        setState({
          error: error instanceof Error ? error.message : "Audit history failed to load",
          history: historyRef.current,
          isLoading: false,
          stale: true,
        });
        staleRef.current = true;
      }
    };

    const sameRunId = previousRunIdRef.current === runId;
    previousRunIdRef.current = runId;
    if (!sameRunId) {
      historyRef.current = null;
      staleRef.current = false;
      bootstrappedRef.current = false;
      bufferRef.current = [];
      reloadCountRef.current = 0;
      setState({ history: null, isLoading: enabled, stale: false });
    }

    if (!enabled) {
      reloadRef.current = () => {};
      setState((current) => ({ ...current, isLoading: false }));
      return () => {
        disposed = true;
        loadAbortControllerRef.current?.abort();
        loadAbortControllerRef.current = null;
      };
    }

    const shouldLoadHistory =
      !bootstrappedRef.current || staleRef.current || historyRef.current === null;

    reloadRef.current = () => {
      reloadCountRef.current = 0;
      void loadHistory();
    };

    if (sameRunId) {
      setState((current) => ({
        ...current,
        error: shouldLoadHistory ? undefined : current.error,
        isLoading: shouldLoadHistory,
      }));
    }

    const unsubscribe = subscribeToRunAuditEvents(config, runId, {
      daemonToken,
      onOpen: () => {
        if (disposed) {
          return;
        }
        if (staleRef.current) {
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

        const result = applyAuditEnvelope(historyRef.current, envelope);
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

    if (shouldLoadHistory) {
      void loadHistory();
    }

    return () => {
      disposed = true;
      loadAbortControllerRef.current?.abort();
      loadAbortControllerRef.current = null;
      unsubscribe();
    };
  }, [api, config, daemonToken, enabled, runId]);

  return {
    ...state,
    reload: () => reloadRef.current(),
  };
}
