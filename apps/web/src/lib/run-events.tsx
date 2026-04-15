import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import { queryClient, runQueryKeys } from "./query.js";
import { subscribeToRunSummaryEvents } from "./sse.js";

interface RunEventsState {
  streamStale: boolean;
}

const RunEventsContext = createContext<RunEventsState>({ streamStale: false });

function upsertSummary(
  current: RunSummary[] | undefined,
  incoming: RunSummary,
): RunSummary[] | undefined {
  if (!current) {
    return current;
  }
  const existingIndex = current.findIndex((run) => run.runId === incoming.runId);
  if (existingIndex === -1) {
    return [...current, incoming].sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    );
  }
  const next = [...current];
  next[existingIndex] = incoming;
  return next;
}

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

    const unsubscribe = subscribeToRunSummaryEvents(config, {
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
        queryClient.setQueryData<RunSummary[] | undefined>(runQueryKeys.list(), (current) =>
          upsertSummary(current, payload.summary),
        );
      },
      onStaleChange: (stale) => {
        if (!stale) {
          return;
        }
        streamStaleRef.current = true;
        setStreamStale(true);
      },
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [config]);

  return <RunEventsContext.Provider value={{ streamStale }}>{children}</RunEventsContext.Provider>;
}

export function useRunEvents(): RunEventsState {
  return useContext(RunEventsContext);
}
