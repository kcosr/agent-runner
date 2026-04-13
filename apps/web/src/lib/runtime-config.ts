import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import { createContext, useContext } from "react";

export type { AppRuntimeConfig as RuntimeConfig };

export class RuntimeConfigError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<AppRuntimeConfig> {
  const response = await fetchImpl("/app-config.json", {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new RuntimeConfigError(
      `Runtime config request failed with status ${response.status}`,
      response.status,
    );
  }

  const payload = (await response.json()) as unknown;
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { apiBasePath?: unknown }).apiBasePath !== "string" ||
    typeof (payload as { runEventsPath?: unknown }).runEventsPath !== "string"
  ) {
    throw new RuntimeConfigError("Runtime config payload is invalid");
  }

  return payload as AppRuntimeConfig;
}

export const RuntimeConfigContext = createContext<AppRuntimeConfig | null>(null);

export function useRuntimeConfig(): AppRuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) {
    throw new RuntimeConfigError("Runtime config is not available");
  }
  return config;
}
