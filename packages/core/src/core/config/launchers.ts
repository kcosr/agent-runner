import type { LauncherDefinitionConfig, LauncherInlineConfig } from "./schema.js";

export const DIRECT_LAUNCHER_NAME = "direct";
export const LAUNCHER_FILE_EXTENSIONS = [".yaml", ".yml"] as const;

export type AgentLauncherReference =
  | {
      kind: "name";
      ref: string;
      name: string;
    }
  | {
      kind: "path";
      ref: string;
      path: string;
    }
  | {
      kind: "inline";
      config: LauncherInlineConfig;
    };

export interface BuiltinDirectLauncherDefinition {
  kind: "direct";
  name: "direct";
  sourcePath: null;
  root: "builtin";
}

export interface LoadedPrefixLauncherDefinition {
  kind: "prefix";
  name: string;
  command: string;
  args: string[];
  sourcePath: string;
  root: "config";
  config: LauncherDefinitionConfig;
}

export type LoadedLauncherDefinition =
  | BuiltinDirectLauncherDefinition
  | LoadedPrefixLauncherDefinition;

export type ResolvedLauncherConfig =
  | { kind: "direct"; name: "direct" }
  | {
      kind: "prefix";
      command: string;
      args: string[];
      name: string | null;
      source: "builtin" | "named" | "inline";
    };

export function cloneResolvedLauncherConfig(
  launcher: ResolvedLauncherConfig,
): ResolvedLauncherConfig {
  return launcher.kind === "direct"
    ? { ...launcher }
    : {
        ...launcher,
        args: [...launcher.args],
      };
}

export function isNamedLauncherOverride(reference: string): boolean {
  return !reference.includes("/") && !reference.startsWith(".");
}
