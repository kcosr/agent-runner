import {
  type AppRuntimeConfig,
  appRuntimeConfigSchema,
} from "@task-runner/core/contracts/app-config.js";
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

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RuntimeConfigError("Runtime config payload is invalid");
  }

  const parsed = appRuntimeConfigSchema.safeParse(payload);
  if (!parsed.success) {
    throw new RuntimeConfigError("Runtime config payload is invalid");
  }

  return parsed.data;
}

export const RuntimeConfigContext = createContext<AppRuntimeConfig | null>(null);

export function useRuntimeConfig(): AppRuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) {
    throw new RuntimeConfigError("Runtime config is not available");
  }
  return config;
}
