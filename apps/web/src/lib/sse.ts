import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type { RunEventEnvelope } from "@task-runner/core/contracts/events.js";

export interface RunEventsSubscriptionOptions {
  onEvent: (payload: RunEventEnvelope) => void;
  onStaleChange?: (stale: boolean) => void;
}

export function subscribeToRunEvents(
  config: AppRuntimeConfig,
  options: RunEventsSubscriptionOptions,
): () => void {
  const source = new EventSource(config.runEventsPath);

  source.onopen = () => {
    options.onStaleChange?.(false);
  };

  source.onerror = () => {
    options.onStaleChange?.(true);
  };

  source.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data) as RunEventEnvelope;
      options.onStaleChange?.(false);
      options.onEvent(payload);
    } catch {
      options.onStaleChange?.(true);
    }
  };

  return () => {
    source.close();
  };
}
