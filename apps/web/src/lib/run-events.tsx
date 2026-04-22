import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type { RunSummaryStreamEvent } from "@task-runner/core/contracts/events.js";
import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { queryClient, runQueryKeys } from "./query.js";
import { sortRunsByStartedAtDesc } from "./run-order.js";
import { subscribeToRunSummaryEvents } from "./sse.js";

interface RunEventsState {
  streamStale: boolean;
  recentUpdateSequenceByRunId: Record<string, number>;
  markRunTouched: (runId: string) => void;
}

const RunEventsContext = createContext<RunEventsState>({
  streamStale: false,
  recentUpdateSequenceByRunId: {},
  markRunTouched: () => {},
});

function upsertSummary(
  current: RunSummary[] | undefined,
  incoming: RunSummary,
): RunSummary[] | undefined {
  if (!current) {
    return current;
  }
  const existingIndex = current.findIndex((run) => run.runId === incoming.runId);
  if (existingIndex === -1) {
    return sortRunsByStartedAtDesc([...current, incoming]);
  }
  const next = [...current];
  next[existingIndex] = incoming;
  return next;
}

function updateExistingSummary(
  current: RunSummary[] | undefined,
  incoming: RunSummary,
): RunSummary[] | undefined {
  if (!current) {
    return current;
  }
  const existingIndex = current.findIndex((run) => run.runId === incoming.runId);
  if (existingIndex === -1) {
    return current;
  }
  const next = [...current];
  next[existingIndex] = incoming;
  return next;
}

function applySummaryEvent(
  current: RunSummary[] | undefined,
  event: RunSummaryStreamEvent,
): RunSummary[] | undefined {
  if (event.type === "summary_upsert") {
    return upsertSummary(current, event.summary);
  }
  return current?.filter((run) => run.runId !== event.runId);
}

function hasFamilyFilter(queryKey: readonly unknown[]): boolean {
  const last = queryKey.at(-1);
  if (!last || typeof last !== "object" || Array.isArray(last)) {
    return false;
  }
  return typeof (last as { familyRootRunId?: unknown }).familyRootRunId === "string";
}

export function RunEventsProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: AppRuntimeConfig;
}) {
  const [streamStale, setStreamStale] = useState(false);
  const [recentUpdateSequenceByRunId, setRecentUpdateSequenceByRunId] = useState<
    Record<string, number>
  >({});
  const streamStaleRef = useRef(streamStale);
  const nextRecentUpdateSequenceRef = useRef(0);

  const markRunTouched = useCallback((runId: string) => {
    setRecentUpdateSequenceByRunId((current) => {
      const nextSequence = nextRecentUpdateSequenceRef.current + 1;
      nextRecentUpdateSequenceRef.current = nextSequence;
      return { ...current, [runId]: nextSequence };
    });
  }, []);

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
          markRunTouched(payload.summary.runId);
          queryClient.setQueriesData<RunSummary[] | undefined>(
            { queryKey: runQueryKeys.lists() },
            (current) => updateExistingSummary(current, payload.summary),
          );
          queryClient.setQueryData<RunSummary[] | undefined>(runQueryKeys.list(), (current) =>
            upsertSummary(current, payload.summary),
          );
          const activeFamilyQueries = queryClient
            .getQueryCache()
            .findAll({ queryKey: runQueryKeys.lists(), type: "active" })
            .filter((query) => hasFamilyFilter(query.queryKey));
          for (const query of activeFamilyQueries) {
            void queryClient.refetchQueries(
              { queryKey: query.queryKey, exact: true, type: "active" },
              { throwOnError: false },
            );
          }
          return;
        }
        queryClient.setQueriesData<RunSummary[] | undefined>(
          { queryKey: runQueryKeys.lists() },
          (current) => applySummaryEvent(current, payload),
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
  }, [config, markRunTouched]);

  return (
    <RunEventsContext.Provider value={{ streamStale, recentUpdateSequenceByRunId, markRunTouched }}>
      {children}
    </RunEventsContext.Provider>
  );
}

export function useRunEvents(): RunEventsState {
  return useContext(RunEventsContext);
}
