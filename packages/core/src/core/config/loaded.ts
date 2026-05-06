import { cloneBackendArgsConfig, cloneBackendConfig } from "../backends/types.js";
import type { RunManifest } from "../run/manifest.js";
import type { EnvironmentReference } from "./environments.js";
import type { AgentLauncherReference } from "./launchers.js";
import {
  type AgentConfig,
  type AssignmentConfig,
  DEFAULT_AGENT_TIMEOUT_SEC,
  DEFAULT_AGENT_UNRESTRICTED,
  type LockableField,
  type TaskDef,
} from "./schema.js";

// Reserved agent name for CLI-synthesized ad-hoc runs. `loadAgentConfig`
// refuses to load any on-disk agent file that uses this name so it
// can't collide with a synthesized one.
export const AD_HOC_AGENT_NAME = "ad-hoc";

export interface LoadedAgent {
  config: AgentConfig;
  instructions: string;
  launcher?: AgentLauncherReference;
  executionEnvironment?: EnvironmentReference;
  // null for ad-hoc agents synthesized from CLI overrides and for
  // agents reconstructed from a resumed manifest (since resume never
  // re-reads the source file under the manifest-canonical design).
  sourcePath: string | null;
}

export interface LoadedAssignment {
  config: AssignmentConfig;
  instructions: string;
  sourcePath: string;
}

export interface LoadedTaskDefinition {
  task: TaskDef;
  sourcePath: string;
}

// Reconstruct a LoadedAgent from a resumed run's manifest. Post the
// manifest-canonical refactor this is the only path that produces a
// LoadedAgent on resume — we never re-read the agent's source file.
// All fields come from frozen manifest state.
export function loadedAgentFromManifest(manifest: RunManifest): LoadedAgent {
  const effort = manifest.effort === null ? undefined : (manifest.effort as AgentConfig["effort"]);
  const config: AgentConfig = {
    schemaVersion: 1,
    name: manifest.agent.name,
    backend: manifest.backend as AgentConfig["backend"],
    model: manifest.model ?? undefined,
    effort,
    backendConfig:
      manifest.backendConfig === undefined
        ? undefined
        : {
            [manifest.backend]: cloneBackendConfig(manifest.backendConfig),
          },
    backendArgs: cloneBackendArgsConfig({
      [manifest.backend as AgentConfig["backend"]]: {
        extraArgs: manifest.resolvedBackendArgs,
      },
    }),
    timeoutSec: manifest.timeoutSec,
    unrestricted: manifest.unrestricted,
    lockedFields: manifest.lockedFields,
  };
  return {
    config,
    instructions: manifest.agent.instructions,
    launcher: undefined,
    executionEnvironment: undefined,
    sourcePath: manifest.agent.sourcePath,
  };
}

// Synthesize a LoadedAgent from CLI overrides when --agent was
// omitted. Name is always `ad-hoc`, role instructions are empty
// (there's no --instructions flag), lockedFields is empty (ad-hoc
// agents aren't lockable since there's no source to lock against).
export interface AdHocAgentInputs {
  backend: AgentConfig["backend"];
  model?: string;
  effort?: AgentConfig["effort"];
  timeoutSec?: number;
  unrestricted?: boolean;
}

export function synthesizeAdHocAgent(inputs: AdHocAgentInputs): LoadedAgent {
  const config: AgentConfig = {
    schemaVersion: 1,
    name: AD_HOC_AGENT_NAME,
    backend: inputs.backend,
    model: inputs.model,
    effort: inputs.effort,
    timeoutSec: inputs.timeoutSec ?? DEFAULT_AGENT_TIMEOUT_SEC,
    unrestricted: inputs.unrestricted ?? DEFAULT_AGENT_UNRESTRICTED,
    lockedFields: [] as LockableField[],
  };
  return {
    config,
    instructions: "",
    launcher: undefined,
    executionEnvironment: undefined,
    sourcePath: null,
  };
}
