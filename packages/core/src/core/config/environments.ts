import type { EnvironmentDefinitionConfig } from "./schema.js";

export const ENVIRONMENT_FILE_EXTENSIONS = [".yaml", ".yml"] as const;

export type EnvironmentReference =
  | {
      kind: "name";
      ref: string;
      name: string;
    }
  | {
      kind: "path";
      ref: string;
      path: string;
    };

export interface LoadedEnvironmentDefinition {
  name: string;
  sourcePath: string;
  root: "config";
  config: EnvironmentDefinitionConfig;
}
