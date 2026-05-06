import { z } from "zod";
import {
  type BackendArgsConfig,
  type BackendName,
  isJsonishPersistable,
} from "../backends/types.js";

export const HOOK_PHASES = [
  "prepare",
  "beforeAttempt",
  "afterAttempt",
  "afterExit",
  "taskTransition",
] as const;

export type HookPhase = (typeof HOOK_PHASES)[number];

const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;
const TASK_TRANSITION_SOURCES = ["run-loop", "task-set", "task-append-notes", "task-add"] as const;

function validateHookSourceSelector(
  entry: { builtin?: string; name?: string; path?: string },
  ctx: z.RefinementCtx,
): void {
  const defined = [entry.builtin, entry.name, entry.path].filter((value) => value !== undefined);
  if (defined.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "hook entry must define exactly one of `builtin`, `name`, or `path`",
    });
  }
}

export const VAR_SOURCES = ["cli", "web", "env", "parent"] as const;
export type VarSource = (typeof VAR_SOURCES)[number];
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_AGENT_TIMEOUT_SEC = 3600;
export const DEFAULT_AGENT_UNRESTRICTED = true;
export const DEFAULT_MAX_RETRIES = 3;

function isValidVarDefault(value: unknown, def: { type: string; values?: string[] }): boolean {
  switch (def.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return (
        typeof value === "number" ||
        (typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Number(value)))
      );
    case "boolean":
      return (
        typeof value === "boolean" ||
        value === "true" ||
        value === "false" ||
        value === "1" ||
        value === "0"
      );
    case "enum":
      return typeof value === "string" && (def.values?.includes(value) ?? false);
    default:
      return false;
  }
}

export const varDefSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "enum"]).default("string"),
    required: z.boolean().default(false),
    requiredAt: z.enum(["initial", "prepare"]).default("initial"),
    sources: z.array(z.enum(VAR_SOURCES)).nonempty().default(["cli", "web"]),
    envName: z.string().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
    values: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.sources).size !== v.sources.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: "var sources must not contain duplicates",
      });
    }
    if (v.type === "enum" && (v.values === undefined || v.values.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["values"],
        message: "enum vars must declare a non-empty `values` array",
      });
    }
    if (v.default !== undefined && !isValidVarDefault(v.default, v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: `default is incompatible with var type "${v.type}"`,
      });
    }
  });

const hookEntrySelectorShape = {
  builtin: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  with: z.unknown().optional(),
} as const;

const hookEntrySelectorSchema = z
  .object(hookEntrySelectorShape)
  .superRefine(validateHookSourceSelector);

const nonEmptyStringArraySchema = z.array(z.string().trim().min(1)).nonempty();

const attemptWhenValueSchema = z.union([
  z.number().int().nonnegative(),
  z.array(z.number().int().nonnegative()).nonempty(),
]);

const attemptHookWhenSchema = z
  .object({
    sessionIndex: attemptWhenValueSchema.optional(),
    attemptIndexInSession: attemptWhenValueSchema.optional(),
  })
  .strict();

const taskTransitionHookWhenSchema = z
  .object({
    taskId: z.string().trim().min(1).optional(),
    taskIds: nonEmptyStringArraySchema.optional(),
    toStatus: z.array(z.enum(TASK_STATUSES)).nonempty().optional(),
    fromStatus: z.array(z.enum(TASK_STATUSES)).nonempty().optional(),
    source: z.array(z.enum(TASK_TRANSITION_SOURCES)).nonempty().optional(),
  })
  .strict()
  .superRefine((when, ctx) => {
    if (when.taskId !== undefined && when.taskIds !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "task-transition when cannot define both `taskId` and `taskIds`",
      });
    }
    if (when.taskIds !== undefined && new Set(when.taskIds).size !== when.taskIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["taskIds"],
        message: "task-transition when.taskIds must not contain duplicates",
      });
    }
  });

const baseHookEntrySchema = <TWhen extends z.ZodTypeAny>(whenSchema: TWhen) =>
  z
    .object({
      ...hookEntrySelectorShape,
      when: whenSchema.nullable().optional(),
    })
    .superRefine(validateHookSourceSelector);

const attemptHookEntrySchema = baseHookEntrySchema(attemptHookWhenSchema);
const taskTransitionHookEntrySchema = baseHookEntrySchema(taskTransitionHookWhenSchema);

const taskIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:/-]+$/, "task id must match [A-Za-z0-9._:/-]+")
  .max(128);

const taskMetadataSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n]/.test(value), "task title must be a single line"),
  hooks: z.array(taskTransitionHookEntrySchema).default([]),
});

export const taskDefSchema = taskMetadataSchema.extend({
  id: taskIdSchema,
  body: z.string().optional().default(""),
});

export const taskDefinitionConfigSchema = taskMetadataSchema.extend({
  schemaVersion: z.literal(1),
  id: taskIdSchema.optional(),
});

export const authoredAssignmentTaskEntrySchema = z.union([z.string().trim().min(1), taskDefSchema]);

export const assignmentHooksSchema = z
  .object({
    prepare: z.array(baseHookEntrySchema(z.record(z.string(), z.unknown()))).default([]),
    beforeAttempt: z.array(attemptHookEntrySchema).default([]),
    afterAttempt: z.array(attemptHookEntrySchema).default([]),
    afterExit: z.array(attemptHookEntrySchema).default([]),
    taskTransition: z.array(taskTransitionHookEntrySchema).default([]),
  })
  .default({
    prepare: [],
    beforeAttempt: [],
    afterAttempt: [],
    afterExit: [],
    taskTransition: [],
  });

export const LOCKABLE_FIELDS = [
  "cwd",
  "backend",
  "model",
  "effort",
  "instructions",
  "message",
  "timeoutSec",
  "unrestricted",
  "maxRetries",
  "tasks",
  "schedule",
] as const;

export type LockableField = (typeof LOCKABLE_FIELDS)[number];

export const scheduleConfigSchema = z
  .object({
    at: z.string().trim().min(1).optional(),
    delay: z.string().trim().min(1).optional(),
    cron: z.string().trim().min(1).optional(),
    timezone: z.string().trim().min(1).optional(),
    mode: z.enum(["reuse", "reset", "clone"]).optional(),
    continueOnFailure: z.boolean().optional(),
  })
  .strict()
  .superRefine((schedule, ctx) => {
    const sourceCount = [schedule.at, schedule.delay, schedule.cron].filter(
      (value) => value !== undefined,
    ).length;
    if (sourceCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "schedule must define exactly one of `at`, `delay`, or `cron`",
      });
    }
    if (schedule.cron === undefined) {
      if (schedule.timezone !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timezone"],
          message: "schedule.timezone is valid only with `cron`",
        });
      }
      if (schedule.mode !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mode"],
          message: "schedule.mode is valid only with `cron`",
        });
      }
      if (schedule.continueOnFailure !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["continueOnFailure"],
          message: "schedule.continueOnFailure is valid only with `cron`",
        });
      }
    }
  });

export const backendConfigSchema: z.ZodType<Partial<Record<BackendName, unknown>>> = z
  .record(z.string().trim().min(1), z.unknown())
  .superRefine((value, ctx) => {
    for (const [backendName, backendConfig] of Object.entries(value)) {
      if (!isJsonishPersistable(backendConfig)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [backendName],
          message: "backendConfig values must be JSON-persistable data",
        });
      }
    }
  });

const backendArgsTokenSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "extraArgs entries must be non-empty strings");

const backendArgsEntrySchema = z
  .object({
    extraArgs: z.array(backendArgsTokenSchema),
  })
  .strict();

export const backendArgsConfigSchema: z.ZodType<BackendArgsConfig> = z.record(
  z.string().trim().min(1),
  backendArgsEntrySchema,
);

export const launcherInlineConfigSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict();

export const launcherDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict();

export const agentLauncherSchema = z.union([z.string().trim().min(1), launcherInlineConfigSchema]);

const environmentPathTemplateSchema = z.string().trim().min(1);

const environmentMountSchema = z
  .object({
    hostPath: environmentPathTemplateSchema,
    containerPath: environmentPathTemplateSchema,
    mode: z.enum(["ro", "rw"]),
  })
  .strict();

const environmentSessionMountPresetSchema = z.enum(["claude", "codex", "cursor", "opencode", "pi"]);

const environmentSessionMountsSchema = z
  .union([z.literal("backend"), z.array(environmentSessionMountPresetSchema)])
  .default([]);

const environmentWorkspaceSchema = z
  .object({
    scope: z.enum(["run", "group"]).default("run"),
    hostRoot: environmentPathTemplateSchema.optional(),
    hostPath: environmentPathTemplateSchema.optional(),
    containerPath: environmentPathTemplateSchema,
    mode: z.enum(["ro", "rw"]).default("rw"),
    create: z.boolean().default(true),
    lifecycle: z
      .object({
        onCreate: z
          .array(
            z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("command"),
                  command: z.string().trim().min(1),
                  args: z.array(z.string()).default([]),
                  env: z.record(z.string().trim().min(1), z.string()).default({}),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("git-clone"),
                  source: environmentPathTemplateSchema,
                  baseRef: z.string().trim().min(1),
                  branch: z.string().trim().min(1),
                })
                .strict(),
            ]),
          )
          .default([]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (workspace) => workspace.hostRoot === undefined || workspace.hostPath === undefined,
    "workspace cannot define both hostRoot and hostPath",
  );

const containerEngineSchema = z.enum(["docker", "podman"]);

const containerNetworkSchema = z.union([
  z.enum(["default", "none", "host", "bridge"]),
  z.string().trim().min(1),
]);

const containerSecuritySchema = z
  .object({
    userns: z.enum(["keep-id", "host"]).optional(),
    selinuxLabel: z.enum(["disable", "shared", "private"]).optional(),
    readOnlyRootFilesystem: z.boolean().optional(),
    capDrop: z.array(z.string().trim().min(1)).default([]),
    capAdd: z.array(z.string().trim().min(1)).default([]),
  })
  .strict()
  .default({
    capDrop: [],
    capAdd: [],
  });

const containerEnvSchema = z.record(z.string().trim().min(1), z.string());

const baseContainerEnvironmentSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).optional(),
  kind: z.literal("container"),
  engine: containerEngineSchema.default("docker"),
  cwd: environmentPathTemplateSchema,
  env: containerEnvSchema.default({}),
  extraExecArgs: z.array(z.string().trim().min(1)).default([]),
});

const existingContainerEnvironmentSchema = baseContainerEnvironmentSchema
  .extend({
    mode: z.literal("existing"),
    container: z.string().trim().min(1),
    expectedMounts: z.array(environmentMountSchema).default([]),
  })
  .strict();

const managedContainerEnvironmentSchema = baseContainerEnvironmentSchema
  .extend({
    mode: z.literal("managed"),
    image: z.string().trim().min(1),
    lifetime: z.enum(["run", "group"]).default("run"),
    containerName: z.string().trim().min(1).optional(),
    workspace: environmentWorkspaceSchema.optional(),
    sessionMounts: environmentSessionMountsSchema,
    mounts: z.array(environmentMountSchema).default([]),
    network: containerNetworkSchema.default("default"),
    security: containerSecuritySchema,
    extraRunArgs: z.array(z.string().trim().min(1)).default([]),
    cleanup: z
      .object({
        policy: z.enum(["terminal", "manual"]).default("terminal"),
      })
      .strict()
      .default({ policy: "terminal" }),
  })
  .strict();

export const environmentDefinitionSchema = z.discriminatedUnion("mode", [
  existingContainerEnvironmentSchema,
  managedContainerEnvironmentSchema,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Agent schema — identity, backend config, role instructions, locks.
// No vars, no tasks, no message. Those live on assignments.
// ─────────────────────────────────────────────────────────────────────────────

export const agentConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    backend: z.string().trim().min(1),
    model: z.string().optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
    launcher: agentLauncherSchema.optional(),
    executionEnvironment: z.string().trim().min(1).optional(),
    backendConfig: backendConfigSchema.optional(),
    backendArgs: backendArgsConfigSchema.optional(),
    timeoutSec: z.number().int().positive().default(DEFAULT_AGENT_TIMEOUT_SEC),
    unrestricted: z.boolean().default(DEFAULT_AGENT_UNRESTRICTED),
    lockedFields: z.array(z.enum(LOCKABLE_FIELDS)).default([]),
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentLauncherConfig = z.infer<typeof agentLauncherSchema>;
export type EnvironmentDefinitionConfig = z.infer<typeof environmentDefinitionSchema>;
export type LauncherDefinitionConfig = z.infer<typeof launcherDefinitionSchema>;
export type LauncherInlineConfig = z.infer<typeof launcherInlineConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Assignment schema — the work. Vars, tasks, optional message default,
// optional work-instructions body, optional locks.
// No backend/model/effort/etc. Those live on agents.
// ─────────────────────────────────────────────────────────────────────────────

const assignmentConfigBaseSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  cwd: z.string().trim().min(1).optional(),
  message: z.string().optional(),
  schedule: scheduleConfigSchema.optional(),
  maxRetries: z.number().int().min(0).max(20).default(DEFAULT_MAX_RETRIES),
  // Documentation surface for the human / script invoking
  // task-runner, NOT part of the prompt sent to the backend.
  // Printed to stderr on fresh `run` and `init` (never on
  // --resume-run). Interpolated against runtime vars and the
  // runner-injected vars ({{run_id}}, {{assignment_name}},
  // {{config_dir}}, {{state_dir}},
  // {{task_runner_cmd}}, etc.).
  // Frozen into `manifest.callerInstructions` at first write so
  // `status --output-format json --field callerInstructions` can
  // always re-fetch it.
  callerInstructions: z.string().optional(),
  vars: z.record(z.string(), varDefSchema).default({}),
  hooks: assignmentHooksSchema,
  lockedFields: z.array(z.enum(LOCKABLE_FIELDS)).default([]),
});

export const authoredAssignmentConfigSchema = assignmentConfigBaseSchema
  .extend({
    tasks: z.array(authoredAssignmentTaskEntrySchema).max(100).default([]),
  })
  .refine(
    (c) => {
      const ids = new Set<string>();
      for (const task of c.tasks) {
        if (typeof task === "string") continue;
        if (ids.has(task.id)) return false;
        ids.add(task.id);
      }
      return true;
    },
    { message: "task ids must be unique", path: ["tasks"] },
  );

export const assignmentConfigSchema = assignmentConfigBaseSchema
  .extend({
    tasks: z.array(taskDefSchema).max(100).default([]),
  })
  .refine(
    (c) => {
      const ids = new Set<string>();
      for (const t of c.tasks) {
        if (ids.has(t.id)) return false;
        ids.add(t.id);
      }
      return true;
    },
    { message: "task ids must be unique", path: ["tasks"] },
  );

export type AssignmentConfig = z.infer<typeof assignmentConfigSchema>;
export type AuthoredAssignmentConfig = z.infer<typeof authoredAssignmentConfigSchema>;
export type AssignmentHookEntry = z.infer<typeof hookEntrySelectorSchema> & {
  when?: unknown | null;
};
export type AssignmentHooks = z.infer<typeof assignmentHooksSchema>;
export type AuthoredAssignmentTaskEntry = z.infer<typeof authoredAssignmentTaskEntrySchema>;
export type TaskDef = z.infer<typeof taskDefSchema>;
export type TaskDefinitionConfig = z.infer<typeof taskDefinitionConfigSchema>;
export type TaskTransitionHookEntry = z.infer<typeof taskTransitionHookEntrySchema>;
export type VarDef = z.infer<typeof varDefSchema>;
