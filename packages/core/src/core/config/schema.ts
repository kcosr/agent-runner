import { z } from "zod";
import {
  BACKEND_IDS,
  type BackendSpecificConfig,
  type CodexTransportConfig,
  isWsOrWssUrl,
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
export const DEFAULT_AGENT_UNRESTRICTED = false;
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
    attemptInSession: attemptWhenValueSchema.optional(),
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

export const taskDefSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9._:-]+$/, "task id must match [A-Za-z0-9._:-]+")
    .max(128),
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n]/.test(value), "task title must be a single line"),
  body: z.string().optional().default(""),
  hooks: z.array(taskTransitionHookEntrySchema).default([]),
});

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
] as const;

export type LockableField = (typeof LOCKABLE_FIELDS)[number];

export const codexTransportConfigSchema: z.ZodType<CodexTransportConfig> = z.union([
  z
    .object({
      type: z.literal("stdio"),
    })
    .strict(),
  z
    .object({
      type: z.literal("ws"),
      url: z
        .string()
        .trim()
        .min(1)
        .refine(isWsOrWssUrl, "url must be an absolute ws:// or wss:// URL"),
    })
    .strict(),
]);

export const backendSpecificConfigSchema: z.ZodType<BackendSpecificConfig> = z
  .object({
    codex: z
      .object({
        transport: codexTransportConfigSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

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

// ─────────────────────────────────────────────────────────────────────────────
// Agent schema — identity, backend config, role instructions, locks.
// No vars, no tasks, no message. Those live on assignments.
// ─────────────────────────────────────────────────────────────────────────────

export const agentConfigSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  backend: z.enum(BACKEND_IDS),
  model: z.string().optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  launcher: agentLauncherSchema.optional(),
  backendSpecific: backendSpecificConfigSchema.optional(),
  timeoutSec: z.number().int().positive().default(DEFAULT_AGENT_TIMEOUT_SEC),
  unrestricted: z.boolean().default(DEFAULT_AGENT_UNRESTRICTED),
  lockedFields: z.array(z.enum(LOCKABLE_FIELDS)).default([]),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentLauncherConfig = z.infer<typeof agentLauncherSchema>;
export type LauncherDefinitionConfig = z.infer<typeof launcherDefinitionSchema>;
export type LauncherInlineConfig = z.infer<typeof launcherInlineConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Assignment schema — the work. Vars, tasks, optional message default,
// optional work-instructions body, optional locks.
// No backend/model/effort/etc. Those live on agents.
// ─────────────────────────────────────────────────────────────────────────────

export const assignmentConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    cwd: z.string().trim().min(1).optional(),
    message: z.string().optional(),
    maxRetries: z.number().int().min(0).max(20).default(DEFAULT_MAX_RETRIES),
    // Documentation surface for the human / script invoking
    // task-runner, NOT part of the prompt sent to the backend.
    // Printed to stderr on fresh `run` and `init` (never on
    // --resume-run). Interpolated against runtime vars and the
    // runner-injected vars ({{run_id}}, {{assignment_path}},
    // {{assignment_name}}, {{config_dir}}, {{state_dir}},
    // {{task_runner_cmd}}, etc.).
    // Frozen into `manifest.callerInstructions` at first write so
    // `status --output-format json --field callerInstructions` can
    // always re-fetch it.
    callerInstructions: z.string().optional(),
    vars: z.record(z.string(), varDefSchema).default({}),
    tasks: z.array(taskDefSchema).max(100).default([]),
    hooks: assignmentHooksSchema,
    lockedFields: z.array(z.enum(LOCKABLE_FIELDS)).default([]),
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
export type AssignmentHookEntry = z.infer<typeof hookEntrySelectorSchema> & {
  when?: unknown | null;
};
export type AssignmentHooks = z.infer<typeof assignmentHooksSchema>;
export type TaskDef = z.infer<typeof taskDefSchema>;
export type TaskTransitionHookEntry = z.infer<typeof taskTransitionHookEntrySchema>;
export type VarDef = z.infer<typeof varDefSchema>;
