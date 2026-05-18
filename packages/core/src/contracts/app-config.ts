import { z } from "zod";

const WEB_BASE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9-]+$/;

export interface AppRuntimeConfig {
  webBasePath: string;
  apiBasePath: string;
  // Global board-projection SSE path. Per-run detail/timeline paths are derived from apiBasePath.
  runSummaryEventsPath: string;
}

export function normalizeWebBasePath(raw: string | undefined, label = "web base path"): string {
  const value = raw?.trim();
  if (!value || value === "/") {
    return "/";
  }
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error(`${label} must be an absolute path like /agent-runner`);
  }
  const segments = value.replace(/^\/+|\/+$/g, "").split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !WEB_BASE_PATH_SEGMENT_PATTERN.test(segment))
  ) {
    throw new Error(`${label} must contain only alphanumeric or hyphenated path segments`);
  }
  return `/${segments.join("/")}`;
}

export function webPathPrefix(webBasePath: string): string {
  const normalized = normalizeWebBasePath(webBasePath);
  return normalized === "/" ? "" : normalized;
}

export function appRuntimeConfigForWebBasePath(webBasePath: string): AppRuntimeConfig {
  const normalizedWebBasePath = normalizeWebBasePath(webBasePath);
  const prefix = webPathPrefix(normalizedWebBasePath);
  return {
    webBasePath: normalizedWebBasePath,
    apiBasePath: `${prefix}/api`,
    runSummaryEventsPath: `${prefix}/api/events/run-summaries`,
  };
}

export const appRuntimeConfigSchema: z.ZodType<AppRuntimeConfig> = z
  .object({
    webBasePath: z.string(),
    apiBasePath: z.string(),
    runSummaryEventsPath: z.string(),
  })
  .superRefine((config, context) => {
    let expectedConfig: AppRuntimeConfig;
    try {
      expectedConfig = appRuntimeConfigForWebBasePath(config.webBasePath);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "webBasePath must be an absolute normalized path",
        path: ["webBasePath"],
      });
      return;
    }
    if (config.apiBasePath !== expectedConfig.apiBasePath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "apiBasePath must match webBasePath",
        path: ["apiBasePath"],
      });
    }
    if (config.runSummaryEventsPath !== expectedConfig.runSummaryEventsPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runSummaryEventsPath must match webBasePath",
        path: ["runSummaryEventsPath"],
      });
    }
  });
