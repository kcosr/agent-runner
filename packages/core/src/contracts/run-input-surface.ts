export type RunInputFieldSection = "context" | "task" | "execution";

export type RunInputFieldKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "textarea"
  | "launcher"
  | "model"
  | "effort";

export type RunInputFieldValueStatus = "concrete" | "unset" | "delegated";

export type RunInputFieldSource =
  | "agent"
  | "assignment"
  | "schema_default"
  | "run_loop_default"
  | "available_override"
  | "var_default";

export interface RunInputField {
  key: string;
  label: string;
  description: string;
  section: RunInputFieldSection;
  inputKind: RunInputFieldKind;
  valueStatus: RunInputFieldValueStatus;
  value: unknown;
  editable: boolean;
  locked: boolean;
  hiddenWhenUnset: boolean;
  source: RunInputFieldSource;
  required?: boolean;
  enumValues?: string[];
}

export interface RunInputSurface {
  runSettings: RunInputField[];
  assignmentInputs: RunInputField[];
}

export interface RunInputSurfaceParams {
  agent: string;
  assignment: string;
  cwd?: string;
}

export interface RunInputSurfaceResult {
  inputSurface: RunInputSurface;
}
