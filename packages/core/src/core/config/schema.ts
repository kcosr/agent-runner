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
});

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
    source: z.enum(["cli", "env", "either"]).default("cli"),
    envName: z.string().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
    values: z.array(z.string()).optional(),
  })
  .superRefine((v, ctx) => {
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

export const assignmentHookEntrySchema = z
  .object({
    builtin: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    when: z.record(z.string(), z.unknown()).nullable().optional(),
    with: z.unknown().optional(),
  })
  .superRefine((entry, ctx) => {
    const defined = [entry.builtin, entry.name, entry.path].filter((value) => value !== undefined);
    if (defined.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hook entry must define exactly one of `builtin`, `name`, or `path`",
      });
    }
  });

export const assignmentHooksSchema = z
  .object({
    prepare: z.array(assignmentHookEntrySchema).default([]),
    beforeAttempt: z.array(assignmentHookEntrySchema).default([]),
    afterAttempt: z.array(assignmentHookEntrySchema).default([]),
    afterExit: z.array(assignmentHookEntrySchema).default([]),
    taskTransition: z.array(assignmentHookEntrySchema).default([]),
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

export const agentLauncherSchema = z.union([z.string(), launcherInlineConfigSchema]);

// ─────────────────────────────────────────────────────────────────────────────
// Agent schema — identity, backend config, role instructions, locks.
// No vars, no tasks, no message. Those live on assignments.
// ─────────────────────────────────────────────────────────────────────────────

export const agentConfigSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  backend: z.enum(BACKEND_IDS),
  model: z.string().optional(),
  effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  launcher: agentLauncherSchema.optional(),
  backendSpecific: backendSpecificConfigSchema.optional(),
  timeoutSec: z.number().int().positive().default(3600),
  unrestricted: z.boolean().default(false),
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
    maxRetries: z.number().int().min(0).max(20).default(3),
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
export type AssignmentHookEntry = z.infer<typeof assignmentHookEntrySchema>;
export type AssignmentHooks = z.infer<typeof assignmentHooksSchema>;
export type TaskDef = z.infer<typeof taskDefSchema>;
export type VarDef = z.infer<typeof varDefSchema>;
