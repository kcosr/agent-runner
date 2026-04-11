import { z } from "zod";

export const taskDefSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9._:-]+$/, "task id must match [A-Za-z0-9._:-]+")
    .max(128),
  title: z.string().min(1).max(200),
  body: z.string().optional().default(""),
});

export const varDefSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "enum"]).default("string"),
    required: z.boolean().default(false),
    source: z.enum(["cli", "env", "either"]).default("cli"),
    envName: z.string().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
    sensitive: z.boolean().default(false),
    values: z.array(z.string()).optional(),
  })
  .refine((v) => v.type !== "enum" || (v.values !== undefined && v.values.length > 0), {
    message: "enum vars must declare a non-empty `values` array",
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

// ─────────────────────────────────────────────────────────────────────────────
// Agent schema — identity, backend config, role instructions, locks.
// No vars, no tasks, no message. Those live on assignments.
// ─────────────────────────────────────────────────────────────────────────────

export const agentConfigSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  backend: z.enum(["claude", "codex"]),
  model: z.string().optional(),
  effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  timeoutSec: z.number().int().positive().default(3600),
  unrestricted: z.boolean().default(false),
  cwd: z.string().default("."),
  maxRetries: z.number().int().min(0).max(20).default(3),
  lockedFields: z.array(z.enum(LOCKABLE_FIELDS)).default([]),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Assignment schema — the work. Vars, tasks, optional message default,
// optional work-instructions body, optional locks.
// No backend/model/effort/etc. Those live on agents.
// ─────────────────────────────────────────────────────────────────────────────

export const assignmentConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    message: z.string().optional(),
    vars: z.record(z.string(), varDefSchema).default({}),
    tasks: z.array(taskDefSchema).max(100).default([]),
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
export type TaskDef = z.infer<typeof taskDefSchema>;
export type VarDef = z.infer<typeof varDefSchema>;
