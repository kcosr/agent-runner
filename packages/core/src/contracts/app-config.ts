import { z } from "zod";

export interface AppRuntimeConfig {
  apiBasePath: string;
  runEventsPath: string;
}

export const appRuntimeConfigSchema: z.ZodType<AppRuntimeConfig> = z.object({
  apiBasePath: z.string(),
  runEventsPath: z.string(),
});
