import type { AppRuntimeConfig } from "@task-runner/core/contracts/app-config.js";
import type {
  RunDetailStreamEvent,
  RunSummaryStreamEvent,
  RunTimelineAuditEvent,
  RunTimelineEnvelope,
} from "@task-runner/core/contracts/events.js";
import {
  runDetailStreamEventSchema,
  runSummaryStreamEventSchema,
  runTimelineAuditEventSchema,
  runTimelineEnvelopeSchema,
} from "@task-runner/core/contracts/run-schemas.js";
import type { z } from "zod";

export interface SummaryEventsSubscriptionOptions {
  onEvent: (payload: RunSummaryStreamEvent) => void;
  onOpen?: () => void;
  onStaleChange?: (stale: boolean) => void;
}

export interface DetailEventsSubscriptionOptions {
  onEvent: (payload: RunDetailStreamEvent) => void;
  onOpen?: () => void;
  onStaleChange?: (stale: boolean) => void;
}

export interface TimelineEventsSubscriptionOptions {
  onEvent: (payload: RunTimelineEnvelope) => void;
  onOpen?: () => void;
  onStaleChange?: (stale: boolean) => void;
}

export interface AuditTimelineEventsSubscriptionOptions {
  onEvent: (payload: RunTimelineAuditEvent) => void;
  onOpen?: () => void;
  onStaleChange?: (stale: boolean) => void;
}

function joinPath(basePath: string, path: string): string {
  return `${basePath.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function subscribeToEventSource<T>(
  url: string,
  schema: z.ZodType<T>,
  options: {
    onEvent: (payload: T) => void;
    onOpen?: () => void;
    onStaleChange?: (stale: boolean) => void;
  },
): () => void {
  const source = new EventSource(url);

  source.onopen = () => {
    options.onOpen?.();
  };

  source.onerror = () => {
    options.onStaleChange?.(true);
  };

  source.onmessage = (message) => {
    try {
      const parsed = schema.safeParse(JSON.parse(message.data));
      if (!parsed.success) {
        options.onStaleChange?.(true);
        return;
      }
      options.onEvent(parsed.data);
    } catch {
      options.onStaleChange?.(true);
    }
  };

  return () => {
    source.close();
  };
}

export function subscribeToRunSummaryEvents(
  config: AppRuntimeConfig,
  options: SummaryEventsSubscriptionOptions,
): () => void {
  return subscribeToEventSource(config.runSummaryEventsPath, runSummaryStreamEventSchema, options);
}

export function subscribeToRunDetailEvents(
  config: AppRuntimeConfig,
  runId: string,
  options: DetailEventsSubscriptionOptions,
): () => void {
  return subscribeToEventSource(
    joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/events/detail`),
    runDetailStreamEventSchema,
    options,
  );
}

export function subscribeToRunTimelineEvents(
  config: AppRuntimeConfig,
  runId: string,
  options: TimelineEventsSubscriptionOptions,
): () => void {
  return subscribeToEventSource(
    joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/events/timeline`),
    runTimelineEnvelopeSchema,
    options,
  );
}

export function subscribeToRunAuditTimelineEvents(
  config: AppRuntimeConfig,
  runId: string,
  options: AuditTimelineEventsSubscriptionOptions,
): () => void {
  return subscribeToEventSource(
    joinPath(config.apiBasePath, `/runs/${encodeURIComponent(runId)}/events/audit`),
    runTimelineAuditEventSchema,
    options,
  );
}
