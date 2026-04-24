import { z } from "zod";

export const runInputFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  section: z.enum(["context", "task", "execution"]),
  inputKind: z.enum([
    "string",
    "number",
    "boolean",
    "enum",
    "textarea",
    "launcher",
    "model",
    "effort",
  ]),
  valueStatus: z.enum(["concrete", "unset", "delegated"]),
  value: z.any(),
  editable: z.boolean(),
  locked: z.boolean(),
  hiddenWhenUnset: z.boolean(),
  source: z.enum([
    "agent",
    "assignment",
    "schema_default",
    "run_loop_default",
    "available_override",
    "var_default",
  ]),
  required: z.boolean().optional(),
  enumValues: z.array(z.string()).optional(),
});

export const runInputSurfaceSchema = z.object({
  runSettings: z.array(runInputFieldSchema),
  assignmentInputs: z.array(runInputFieldSchema),
});

export const runInputSurfaceResultSchema = z.object({
  inputSurface: runInputSurfaceSchema,
});
