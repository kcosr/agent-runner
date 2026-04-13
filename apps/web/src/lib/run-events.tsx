import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type { RunEventEnvelope } from "@task-runner/core/contracts/events.js";
import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import { queryClient, runQueryKeys } from "./query.js";
import { subscribeToRunEvents } from "./sse.js";

interface RunEventsState {
  streamStale: boolean;
}

const RunEventsContext = createContext<RunEventsState>({ streamStale: false });

const REFRESH_DELAY_MS = 150;
const REFRESH_EVENT_TYPES = new Set<RunEventEnvelope["event"]["type"]>([
  "run_initialized",
  "run_started",
  "attempt_started",
  "retrying",
  "run_aborted",
  "resume_rejected",
  "run_finished",
]);

export function RunEventsProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: AppRuntimeConfig;
}) {
  const [streamStale, setStreamStale] = useState(false);
  const streamStaleRef = useRef(streamStale);

  useEffect(() => {
    streamStaleRef.current = streamStale;
  }, [streamStale]);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshAllDetails = false;
    const refreshRunIds = new Set<string>();

    function scheduleRefresh(options: { runId?: string; allDetails?: boolean }) {
      if (options.allDetails) {
        refreshAllDetails = true;
        refreshRunIds.clear();
      } else if (!refreshAllDetails && options.runId) {
        refreshRunIds.add(options.runId);
      }
      if (refreshTimer !== null) {
        return;
      }
      refreshTimer = setTimeout(() => {
        const runIds = Array.from(refreshRunIds);
        const shouldRefreshAllDetails = refreshAllDetails;
        refreshTimer = null;
        refreshAllDetails = false;
        refreshRunIds.clear();
        if (disposed) {
          return;
        }
        void queryClient.invalidateQueries({ queryKey: runQueryKeys.list() });
        if (shouldRefreshAllDetails) {
          void queryClient.invalidateQueries({ queryKey: [...runQueryKeys.all, "detail"] });
          return;
        }
        for (const runId of runIds) {
          void queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) });
        }
      }, REFRESH_DELAY_MS);
    }

    async function refreshActiveQueries() {
      await Promise.all([
        queryClient.refetchQueries(
          { queryKey: runQueryKeys.list(), type: "active" },
          { throwOnError: true },
        ),
        queryClient.refetchQueries(
          { queryKey: [...runQueryKeys.all, "detail"], type: "active" },
          { throwOnError: true },
        ),
      ]);
    }

    const unsubscribe = subscribeToRunEvents(config, {
      onOpen: () => {
        if (!streamStaleRef.current) {
          return;
        }
        void refreshActiveQueries()
          .then(() => {
            if (disposed) {
              return;
            }
            streamStaleRef.current = false;
            setStreamStale(false);
          })
          .catch(() => {
            // Keep the stale banner visible until a reconnect can revalidate successfully.
          });
      },
      onEvent: (payload) => {
        if (streamStaleRef.current) {
          streamStaleRef.current = false;
          setStreamStale(false);
        }
        if (REFRESH_EVENT_TYPES.has(payload.event.type)) {
          scheduleRefresh({ runId: payload.runId });
        }
      },
      onStaleChange: (stale) => {
        if (!stale) {
          return;
        }
        streamStaleRef.current = true;
        setStreamStale(true);
        scheduleRefresh({ allDetails: true });
      },
    });

    return () => {
      disposed = true;
      unsubscribe();
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
      }
    };
  }, [config]);

  return <RunEventsContext.Provider value={{ streamStale }}>{children}</RunEventsContext.Provider>;
}

export function useRunEvents(): RunEventsState {
  return useContext(RunEventsContext);
}
