import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import { useEffect, useState } from "react";
import { queryClient } from "./lib/query.js";
import { RunEventsProvider } from "./lib/run-events.js";
import {
  RuntimeConfigContext,
  RuntimeConfigError,
  loadRuntimeConfig,
} from "./lib/runtime-config.js";
import { DashboardSettingsProvider } from "./lib/settings.js";
import { router } from "./router.js";

type BootState =
  | { status: "loading" }
  | { status: "ready"; config: AppRuntimeConfig }
  | { status: "error"; error: Error };

export function App() {
  const [bootState, setBootState] = useState<BootState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void loadRuntimeConfig()
      .then((config) => {
        if (active) {
          setBootState({ status: "ready", config });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setBootState({
            status: "error",
            error:
              error instanceof Error ? error : new RuntimeConfigError("Failed to load app config"),
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (bootState.status === "loading") {
    return (
      <main className="boot-screen">
        <div className="boot-card">
          <p className="boot-eyebrow">task-runner</p>
          <h1>Loading run dashboard</h1>
          <p>Fetching runtime config from the local serve host.</p>
        </div>
      </main>
    );
  }

  if (bootState.status === "error") {
    return (
      <main className="boot-screen">
        <div className="boot-card boot-card--error">
          <p className="boot-eyebrow">task-runner</p>
          <h1>Run dashboard failed to boot</h1>
          <p>{bootState.error.message}</p>
          <button className="btn" onClick={() => window.location.reload()} type="button">
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <RuntimeConfigContext.Provider value={bootState.config}>
      <QueryClientProvider client={queryClient}>
        <DashboardSettingsProvider>
          <RunEventsProvider config={bootState.config}>
            <RouterProvider router={router} />
          </RunEventsProvider>
        </DashboardSettingsProvider>
      </QueryClientProvider>
    </RuntimeConfigContext.Provider>
  );
}
