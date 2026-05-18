import { z } from "zod";

export interface AppRuntimeConfig {
  webBasePath: string;
  apiBasePath: string;
  // Global board-projection SSE path. Per-run detail/timeline paths are derived from apiBasePath.
  runSummaryEventsPath: string;
}

export const appRuntimeConfigSchema: z.ZodType<AppRuntimeConfig> = z.object({
  webBasePath: z.string(),
  apiBasePath: z.string(),
  runSummaryEventsPath: z.string(),
});
