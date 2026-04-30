import { knownBackends } from "../../backends/registry.js";
import type {
  RunInputField,
  RunInputFieldKind,
  RunInputFieldSource,
  RunInputSurface,
} from "../../contracts/run-input-surface.js";
import type { LoadedAgent, LoadedAssignment } from "../config/loaded.js";
import {
  DEFAULT_AGENT_TIMEOUT_SEC,
  DEFAULT_AGENT_UNRESTRICTED,
  DEFAULT_MAX_RETRIES,
  EFFORT_LEVELS,
  LOCKABLE_FIELDS,
  type LockableField,
  type VarDef,
} from "../config/schema.js";

type StaticRunSettingKey =
  | "cwd"
  | "backend"
  | "launcher"
  | "model"
  | "effort"
  | "message"
  | "name"
  | "timeoutSec"
  | "unrestricted"
  | "maxRetries";

interface StaticFieldMetadata {
  key: StaticRunSettingKey;
  label: string;
  description: string;
  inputKind: RunInputFieldKind;
  enumValues?: string[];
}

const RUN_SETTING_METADATA: readonly StaticFieldMetadata[] = [
  {
    key: "cwd",
    label: "Working Directory",
    description: "Working directory for the run.",
    inputKind: "string",
  },
  {
    key: "backend",
    label: "Backend",
    description: "Agent backend used for run execution.",
    inputKind: "enum",
  },
  {
    key: "launcher",
    label: "Launcher",
    description: "Subprocess launcher override for supported backends.",
    inputKind: "launcher",
  },
  {
    key: "model",
    label: "Model",
    description: "Backend model override.",
    inputKind: "model",
  },
  {
    key: "effort",
    label: "Effort",
    description: "Reasoning effort override.",
    inputKind: "effort",
    enumValues: [...EFFORT_LEVELS],
  },
  {
    key: "message",
    label: "Message",
    description: "Default worker ask supplied to the run.",
    inputKind: "textarea",
  },
  {
    key: "name",
    label: "Name",
    description: "Optional run name.",
    inputKind: "string",
  },
  {
    key: "timeoutSec",
    label: "Timeout",
    description: "Maximum backend runtime in seconds.",
    inputKind: "number",
  },
  {
    key: "unrestricted",
    label: "Unrestricted",
    description: "Whether the backend runs with unrestricted shell access.",
    inputKind: "boolean",
  },
  {
    key: "maxRetries",
    label: "Max Retries",
    description: "Maximum retries after the initial attempt.",
    inputKind: "number",
  },
] as const;

function resolveLockedFields(
  loaded: LoadedAgent,
  loadedAssignment: LoadedAssignment | undefined,
): Set<LockableField> {
  return new Set<LockableField>([
    ...loaded.config.lockedFields,
    ...(loadedAssignment?.config.lockedFields ?? []),
  ]);
}

function isLockableField(key: string): key is LockableField {
  return LOCKABLE_FIELDS.includes(key as LockableField);
}

function buildField(
  metadata: StaticFieldMetadata,
  resolved: Pick<RunInputField, "valueStatus" | "value" | "source">,
  editable: boolean,
  locked: boolean,
): RunInputField {
  return {
    key: metadata.key,
    label: metadata.label,
    description: metadata.description,
    section: metadata.key === "cwd" || metadata.key === "name" ? "context" : "execution",
    inputKind: metadata.inputKind,
    valueStatus: resolved.valueStatus,
    value: resolved.value,
    editable,
    locked,
    hiddenWhenUnset: !editable && resolved.valueStatus !== "concrete",
    source: resolved.source,
    enumValues: metadata.enumValues,
  };
}

function authoredLauncherValue(loaded: LoadedAgent): unknown {
  if (!loaded.launcher) {
    return undefined;
  }
  switch (loaded.launcher.kind) {
    case "name":
      return loaded.launcher.name;
    case "path":
      return loaded.launcher.path;
    case "inline":
      return {
        command: loaded.launcher.config.command,
        args: [...loaded.launcher.config.args],
      };
    default: {
      const unreachable: never = loaded.launcher;
      return unreachable;
    }
  }
}

function humanizeKey(key: string): string {
  return key
    .split(/[_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inputKindForVar(def: VarDef): RunInputFieldKind {
  switch (def.type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "enum":
      return "enum";
    default:
      return "string";
  }
}

function valueField<T>(
  value: T,
  source: RunInputFieldSource,
): Pick<RunInputField, "valueStatus" | "value" | "source"> {
  return {
    valueStatus: "concrete",
    value,
    source,
  };
}

function unsetField(): Pick<RunInputField, "valueStatus" | "value" | "source"> {
  return {
    valueStatus: "unset",
    value: null,
    source: "available_override",
  };
}

function delegatedField(): Pick<RunInputField, "valueStatus" | "value" | "source"> {
  return {
    valueStatus: "delegated",
    value: null,
    source: "available_override",
  };
}

export function resolveFreshRunMaxRetries(
  overrideMaxRetries: number | undefined,
  assignment: LoadedAssignment | undefined,
): number {
  return overrideMaxRetries ?? assignment?.config.maxRetries ?? DEFAULT_MAX_RETRIES;
}

export function resolveStaticInputSurface(
  loaded: LoadedAgent,
  loadedAssignment?: LoadedAssignment,
): RunInputSurface {
  const lockedFields = resolveLockedFields(loaded, loadedAssignment);
  const runSettings = RUN_SETTING_METADATA.map((metadata) => {
    const locked = isLockableField(metadata.key) ? lockedFields.has(metadata.key) : false;
    const editable = !locked;

    switch (metadata.key) {
      case "cwd":
        return buildField(
          metadata,
          loadedAssignment?.config.cwd !== undefined
            ? valueField(loadedAssignment.config.cwd, "assignment")
            : unsetField(),
          editable,
          locked,
        );
      case "backend":
        return buildField(
          { ...metadata, enumValues: knownBackends() },
          valueField(loaded.config.backend, "agent"),
          editable,
          locked,
        );
      case "launcher":
        return buildField(
          metadata,
          loaded.launcher !== undefined
            ? valueField(authoredLauncherValue(loaded), "agent")
            : unsetField(),
          true,
          false,
        );
      case "model":
        return buildField(
          metadata,
          loaded.config.model !== undefined
            ? valueField(loaded.config.model, "agent")
            : delegatedField(),
          editable,
          locked,
        );
      case "effort":
        return buildField(
          metadata,
          loaded.config.effort !== undefined
            ? valueField(loaded.config.effort, "agent")
            : delegatedField(),
          editable,
          locked,
        );
      case "message":
        return buildField(
          metadata,
          loadedAssignment?.config.message !== undefined
            ? valueField(loadedAssignment.config.message, "assignment")
            : unsetField(),
          editable,
          locked,
        );
      case "name":
        return buildField(metadata, unsetField(), true, false);
      case "timeoutSec":
        return buildField(
          metadata,
          valueField(
            loaded.config.timeoutSec,
            loaded.config.timeoutSec === DEFAULT_AGENT_TIMEOUT_SEC ? "schema_default" : "agent",
          ),
          editable,
          locked,
        );
      case "unrestricted":
        return buildField(
          metadata,
          valueField(
            loaded.config.unrestricted,
            loaded.config.unrestricted === DEFAULT_AGENT_UNRESTRICTED ? "schema_default" : "agent",
          ),
          editable,
          locked,
        );
      case "maxRetries":
        return buildField(
          metadata,
          valueField(
            resolveFreshRunMaxRetries(undefined, loadedAssignment),
            loadedAssignment && loadedAssignment.config.maxRetries !== DEFAULT_MAX_RETRIES
              ? "assignment"
              : "run_loop_default",
          ),
          editable,
          locked,
        );
      default: {
        const unreachable: never = metadata.key;
        return unreachable;
      }
    }
  });

  const assignmentInputs = Object.entries(loadedAssignment?.config.vars ?? {})
    .filter(([, def]) => def.sources.includes("web"))
    .map(([key, def]) => {
      const hasDefault = def.default !== undefined;
      return {
        key,
        label: humanizeKey(key),
        description: def.description ?? "",
        section: "task" as const,
        inputKind: inputKindForVar(def),
        valueStatus: hasDefault ? ("concrete" as const) : ("unset" as const),
        value: hasDefault ? def.default : null,
        editable: true,
        locked: false,
        hiddenWhenUnset: false,
        source: hasDefault ? ("var_default" as const) : ("available_override" as const),
        required: def.required && def.requiredAt === "initial" ? true : undefined,
        enumValues: def.type === "enum" ? [...(def.values ?? [])] : undefined,
      };
    });

  return {
    runSettings,
    assignmentInputs,
  };
}
