import {
  type AppRuntimeConfig,
  appRuntimeConfigSchema,
} from "@kcosr/agent-runner-core/contracts/app-config.js";
import { createContext, useContext } from "react";

declare global {
  interface Window {
    __AGENT_RUNNER_WEB_BASE_PATH__?: string;
  }
}

export class RuntimeConfigError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

function normalizeConfigBasePath(basePath: string): string {
  if (basePath === "/" || basePath === "") {
    return "";
  }
  return `/${basePath.replace(/^\/+|\/+$/g, "")}`;
}

export function runtimeConfigPath(): string {
  const injectedBasePath =
    typeof window === "undefined" ? undefined : window.__AGENT_RUNNER_WEB_BASE_PATH__;
  const basePath = injectedBasePath ?? import.meta.env.BASE_URL;
  return `${normalizeConfigBasePath(basePath)}/app-config.json`;
}

export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<AppRuntimeConfig> {
  const response = await fetchImpl(runtimeConfigPath(), {
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
