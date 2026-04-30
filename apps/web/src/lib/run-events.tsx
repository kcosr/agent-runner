import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import { queryClient, runQueryKeys } from "./query.js";
import {
  removeRunFromListCache,
  updateRunListCacheQueries,
  upsertRunSummaryInListCache,
} from "./run-list-cache.js";
import { useDaemonAuthToken } from "./settings.js";
import { subscribeToRunSummaryEvents } from "./sse.js";

interface RunEventsState {
  streamStale: boolean;
}

const RunEventsContext = createContext<RunEventsState>({
  streamStale: false,
});

export function RunEventsProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: AppRuntimeConfig;
}) {
  const { daemonToken } = useDaemonAuthToken();
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
          { queryKey: runQueryKeys.lists(), type: "active" },
          { throwOnError: true },
        ),
        queryClient.refetchQueries(
          { queryKey: [...runQueryKeys.all, "detail"], type: "active" },
          { throwOnError: true },
        ),
      ]);
    }

    const unsubscribe = subscribeToRunSummaryEvents(config, {
      daemonToken,
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
        if (payload.type === "summary_upsert") {
          updateRunListCacheQueries(queryClient, (current, metadata) =>
            upsertRunSummaryInListCache(current, payload.summary, metadata),
          );
          return;
        }
        updateRunListCacheQueries(queryClient, (current) => {
          return removeRunFromListCache(current, payload.runId);
        });
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
  }, [config, daemonToken]);

  return <RunEventsContext.Provider value={{ streamStale }}>{children}</RunEventsContext.Provider>;
}

export function useRunEvents(): RunEventsState {
  return useContext(RunEventsContext);
}
