import { resolveCodexTransportConfig } from "../../backends/codex.js";
import { LauncherConfigError, loadLauncherConfig } from "../../config/loader.js";
import type { Backend } from "../backends/types.js";
import {
  type AgentLauncherReference,
  DIRECT_LAUNCHER_NAME,
  type ResolvedLauncherConfig,
  isNamedLauncherOverride,
} from "../config/launchers.js";

function resolvePrefixFromNamedReference(reference: string, cwd: string): ResolvedLauncherConfig {
  const loaded = loadLauncherConfig(reference, cwd);
  if (loaded.kind === "direct") {
    return { kind: "direct", name: DIRECT_LAUNCHER_NAME };
  }
  return {
    kind: "prefix",
    command: loaded.command,
    args: [...loaded.args],
    name: loaded.name,
    source: "named",
  };
}

export function launcherAppliesToBackend(
  backend: Backend,
  backendConfig: unknown | undefined,
): boolean {
  if (backend.id === "passive" || backend.launcherMode === "direct") {
    return false;
  }
  if (backend.id !== "codex") {
    return true;
  }
  const transportType = resolveCodexTransportConfig({ backendConfig }).type;
  return transportType !== "ws" && transportType !== "uds";
}

export function resolveFreshLauncherConfig(args: {
  backend: Backend;
  backendConfig: unknown | undefined;
  agentLauncher: AgentLauncherReference | undefined;
  overrideLauncher: string | undefined;
  cwd: string;
}): ResolvedLauncherConfig {
  if (!launcherAppliesToBackend(args.backend, args.backendConfig)) {
    return { kind: "direct", name: DIRECT_LAUNCHER_NAME };
  }

  if (args.overrideLauncher !== undefined) {
    if (!isNamedLauncherOverride(args.overrideLauncher)) {
      throw new LauncherConfigError(
        args.cwd,
        "  - --launcher only accepts named launchers in fresh-run overrides",
      );
    }
    return resolvePrefixFromNamedReference(args.overrideLauncher, args.cwd);
  }

  const authored = args.agentLauncher;
  if (!authored) {
    return { kind: "direct", name: DIRECT_LAUNCHER_NAME };
  }
  switch (authored.kind) {
    case "name":
      return resolvePrefixFromNamedReference(authored.ref, args.cwd);
    case "path":
      return resolvePrefixFromNamedReference(authored.path, args.cwd);
    case "inline":
      return {
        kind: "prefix",
        command: authored.config.command,
        args: [...authored.config.args],
        name: null,
        source: "inline",
      };
    default: {
      const unreachable: never = authored;
      return unreachable;
    }
  }
}
