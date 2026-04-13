import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { queryClient, runQueryKeys } from "./query.js";
import { subscribeToRunEvents } from "./sse.js";

interface RunEventsState {
  streamStale: boolean;
}

const RunEventsContext = createContext<RunEventsState>({ streamStale: false });

export function RunEventsProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: AppRuntimeConfig;
}) {
  const [streamStale, setStreamStale] = useState(false);

  useEffect(() => {
    return subscribeToRunEvents(config, {
      onEvent: (payload) => {
        void queryClient.invalidateQueries({ queryKey: runQueryKeys.list() });
        void queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(payload.runId) });
      },
      onStaleChange: (stale) => {
        setStreamStale(stale);
        if (stale) {
          void queryClient.invalidateQueries({ queryKey: runQueryKeys.list() });
          void queryClient.invalidateQueries({ queryKey: [...runQueryKeys.all, "detail"] });
        }
      },
    });
  }, [config]);

  return <RunEventsContext.Provider value={{ streamStale }}>{children}</RunEventsContext.Provider>;
}

export function useRunEvents(): RunEventsState {
  return useContext(RunEventsContext);
}
