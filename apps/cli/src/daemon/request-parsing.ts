import type { RunCommandOverrides } from "@agent-runner/core/app/service.js";
import type { AttachmentScope } from "@agent-runner/core/contracts/attachments.js";
import type { RunDependencyRef } from "@agent-runner/core/contracts/runs.js";
import { isJsonishPersistable } from "@agent-runner/core/core/backends/types.js";
import type { RunListScopeFilter } from "@agent-runner/core/core/commands/service.js";
import { isNamedLauncherOverride } from "@agent-runner/core/core/config/launchers.js";
import { RunGroupValidationError, validateRunGroupId } from "@agent-runner/core/core/run/groups.js";
import type { ScheduleInput } from "@agent-runner/core/core/run/schedule.js";
import { trimRunName } from "@agent-runner/core/util/run-name.js";
import type {
  AttachmentsDownloadParams,
  AttachmentsListParams,
  AttachmentsRemoveParams,
  AttachmentsUploadFinishParams,
  AttachmentsUploadOpenParams,
  CliRunsStartParams,
  RunInputSurfaceParams,
  RunQueueResumeMessageParams,
  RunReadyParams,
  RunRemoveQueuedResumeMessageParams,
  RunScheduleParams,
  RunSetBackendSessionParams,
  RunSetGroupParams,
  RunSetNameParams,
  RunSetNoteParams,
  RunSetPinnedParams,
  RunsListParams,
  RunsReconfigureParams,
  RunsResumeParams,
  StreamNotification,
  WebRunsStartParams,
} from "./protocol.js";
import { STREAM_MAX_BUFFERED_BYTES_PER_STREAM, STREAM_MAX_CHUNK_BYTES } from "./stream.js";

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RequestValidationError(`${label} must be a string`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  const stringValue = optionalString(value, label);
  if (stringValue === undefined) {
    return undefined;
  }
  if (stringValue.trim().length === 0) {
    throw new RequestValidationError(`${label} cannot be empty`);
  }
  return stringValue;
}

export function requiredString(value: unknown, label: string): string {
  const stringValue = optionalString(value, label);
  if (stringValue === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  return stringValue;
}

function requiredNonEmptyString(value: unknown, label: string): string {
  const stringValue = requiredString(value, label);
  if (stringValue.trim().length === 0) {
    throw new RequestValidationError(`${label} cannot be empty`);
  }
  return stringValue;
}

function requiredBackendSessionId(value: unknown, label: string): string {
  const stringValue = requiredNonEmptyString(value, label);
  if (stringValue.includes("/") || stringValue.includes("\\") || stringValue.includes("..")) {
    throw new RequestValidationError(`${label} must be a session id, not a path`);
  }
  return stringValue;
}

function optionalBackendSessionId(value: unknown, label: string): string | undefined {
  const stringValue = optionalNonEmptyString(value, label);
  if (stringValue === undefined) {
    return undefined;
  }
  if (stringValue.includes("/") || stringValue.includes("\\") || stringValue.includes("..")) {
    throw new RequestValidationError(`${label} must be a session id, not a path`);
  }
  return stringValue;
}

export function requiredRunIdString(value: unknown, label: string): string {
  const stringValue = requiredNonEmptyString(value, label);
  if (stringValue.includes("/") || stringValue.includes("\\") || stringValue.includes("..")) {
    throw new RequestValidationError(`${label} must be a run id, not a path`);
  }
  return stringValue;
}

function optionalRunIdString(value: unknown, label: string): string | undefined {
  const stringValue = optionalNonEmptyString(value, label);
  if (stringValue === undefined) {
    return undefined;
  }
  if (stringValue.includes("/") || stringValue.includes("\\") || stringValue.includes("..")) {
    throw new RequestValidationError(`${label} must be a run id, not a path`);
  }
  return stringValue;
}

export function optionalHeaderString(
  value: string | string[] | undefined,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new RequestValidationError(`${label} must be a single header value`);
  }
  return value;
}

export function requiredHeaderString(value: string | string[] | undefined, label: string): string {
  const stringValue = optionalHeaderString(value, label);
  if (stringValue === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  if (stringValue.trim().length === 0) {
    throw new RequestValidationError(`${label} cannot be empty`);
  }
  return stringValue;
}

function requiredNullableRunName(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  const stringValue = optionalString(value, label);
  if (stringValue === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  try {
    return trimRunName(stringValue);
  } catch {
    throw new RequestValidationError(`${label} cannot be empty`);
  }
}

function requiredNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(value, label);
}

function requiredBoolean(value: unknown, label: string): boolean {
  const bool = optionalBoolean(value, label);
  if (bool === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  return bool;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = asRecord(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new RequestValidationError(`${label}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new RequestValidationError(`${label} must be a boolean`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RequestValidationError(`${label} must be a positive integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RequestValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  const integer = optionalNonNegativeInteger(value, label);
  if (integer === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  return integer;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RequestValidationError(`${label} must be an array of strings`);
  }
  return [...value];
}

export function optionalEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new RequestValidationError(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseBooleanQueryValue(value: string | null, label: string): boolean | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new RequestValidationError(`${label} must be "true" or "false"`);
}

export function parseAttachmentScopeQueryValue(
  value: string | null,
  label: string,
): AttachmentScope | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "run" || value === "group") {
    return value;
  }
  throw new RequestValidationError(`${label} must be "run" or "group"`);
}

export function requiredRunGroupId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new RequestValidationError(`${label} must be a string`);
  }
  try {
    return validateRunGroupId(value, label);
  } catch (error) {
    if (error instanceof RunGroupValidationError) {
      throw new RequestValidationError(error.message);
    }
    throw error;
  }
}

function optionalRunGroupId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredRunGroupId(value, label);
}

export function parseDependencyRef(value: unknown, label: string): RunDependencyRef {
  const record = asRecord(value, label);
  const type = requiredString(record.type, `${label}.type`);
  if (type === "run") {
    return { type, runId: requiredRunIdString(record.runId, `${label}.runId`) };
  }
  if (type === "group") {
    return { type, groupId: requiredRunGroupId(record.groupId, `${label}.groupId`) };
  }
  throw new RequestValidationError(`${label}.type must be "run" or "group"`);
}

function optionalBackendConfig(
  value: unknown,
  label: string,
): Partial<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, label);
  for (const [backendName, backendConfig] of Object.entries(record)) {
    if (backendName.trim().length === 0) {
      throw new RequestValidationError(`${label} backend names must be non-empty strings`);
    }
    if (!isJsonishPersistable(backendConfig)) {
      throw new RequestValidationError(`${label}.${backendName} must be JSON-persistable data`);
    }
  }
  return record;
}

function optionalScheduleInput(value: unknown, label: string): ScheduleInput | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, label);
  const allowedKeys = new Set(["at", "delay", "cron", "timezone", "mode", "continueOnFailure"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    at: optionalString(record.at, `${label}.at`),
    delay: optionalString(record.delay, `${label}.delay`),
    cron: optionalString(record.cron, `${label}.cron`),
    timezone: optionalString(record.timezone, `${label}.timezone`),
    mode: optionalEnum(record.mode, `${label}.mode`, ["reuse", "reset", "clone"]),
    continueOnFailure: optionalBoolean(record.continueOnFailure, `${label}.continueOnFailure`),
  };
}

function requiredScheduleInput(value: unknown, label: string): ScheduleInput {
  const schedule = optionalScheduleInput(value, label);
  if (schedule === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  return schedule;
}

export function optionalOverrides(value: unknown): RunCommandOverrides {
  if (value === undefined) {
    return {};
  }
  const record = asRecord(value, "overrides");
  const allowedKeys = new Set([
    "cwd",
    "backend",
    "launcher",
    "executionEnvironment",
    "model",
    "effort",
    "message",
    "name",
    "timeoutSec",
    "unrestricted",
    "maxRetries",
    "addedTasks",
    "backendConfig",
    "schedule",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`overrides.${key} is not supported`);
    }
  }
  const launcher = optionalNonEmptyString(record.launcher, "overrides.launcher");
  if (launcher !== undefined && !isNamedLauncherOverride(launcher)) {
    throw new RequestValidationError(
      "overrides.launcher must be a named launcher id, not a path reference",
    );
  }
  return {
    cwd: optionalString(record.cwd, "overrides.cwd"),
    backend: optionalNonEmptyString(record.backend, "overrides.backend"),
    launcher,
    executionEnvironment: optionalNonEmptyString(
      record.executionEnvironment,
      "overrides.executionEnvironment",
    ),
    model: optionalString(record.model, "overrides.model"),
    effort: optionalEnum(record.effort, "overrides.effort", [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    message: optionalString(record.message, "overrides.message"),
    name: optionalNonEmptyString(record.name, "overrides.name"),
    timeoutSec: optionalPositiveInteger(record.timeoutSec, "overrides.timeoutSec"),
    unrestricted: optionalBoolean(record.unrestricted, "overrides.unrestricted"),
    maxRetries: optionalNonNegativeInteger(record.maxRetries, "overrides.maxRetries"),
    addedTasks: optionalStringArray(record.addedTasks, "overrides.addedTasks"),
    backendConfig: optionalBackendConfig(record.backendConfig, "overrides.backendConfig"),
    schedule: optionalScheduleInput(record.schedule, "overrides.schedule"),
  };
}

function parseStartRunBaseParams(value: unknown, label: string) {
  const record = asRecord(value, label);
  return {
    runId: optionalString(record.runId, "runId"),
    agent: optionalString(record.agent, "agent"),
    assignment: optionalString(record.assignment, "assignment"),
    definitionCwd: optionalString(record.definitionCwd, "definitionCwd"),
    callerCwd: optionalString(record.callerCwd, "callerCwd"),
    parentRunId: optionalRunIdString(record.parentRunId, "parentRunId"),
    runGroupId: optionalRunGroupId(record.runGroupId, "runGroupId"),
    backendSessionId: optionalBackendSessionId(record.backendSessionId, "backendSessionId"),
    overrides: optionalOverrides(record.overrides),
  };
}

export function parseCliStartRunParams(value: unknown, label: string): CliRunsStartParams {
  const record = asRecord(value, label);
  return {
    ...parseStartRunBaseParams(record, label),
    cliVars: stringRecord(record.cliVars, "cliVars"),
  };
}

export function parseWebStartRunParams(value: unknown, label: string): WebRunsStartParams {
  const record = asRecord(value, label);
  return {
    ...parseStartRunBaseParams(record, label),
    webVars: stringRecord(record.webVars, "webVars"),
  };
}

export function parseResumeRunParams(value: unknown, label: string): RunsResumeParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["target", "parentRunId", "overrides"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    target: requiredString(record.target, `${label}.target`),
    parentRunId: optionalRunIdString(record.parentRunId, `${label}.parentRunId`),
    overrides: optionalOverrides(record.overrides),
  };
}

export function parseRunQueueResumeMessageParams(
  value: unknown,
  label: string,
): RunQueueResumeMessageParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["target", "message"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    target: requiredNonEmptyString(record.target, `${label}.target`),
    message: requiredNonEmptyString(record.message, `${label}.message`),
  };
}

export function parseRunRemoveQueuedResumeMessageParams(
  value: unknown,
  label: string,
): RunRemoveQueuedResumeMessageParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["target", "messageId"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    target: requiredNonEmptyString(record.target, `${label}.target`),
    messageId: requiredNonEmptyString(record.messageId, `${label}.messageId`),
  };
}

export function parseRunReadyParams(value: unknown, label: string): RunReadyParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["target", "schedule"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    target: requiredString(record.target, `${label}.target`),
    schedule: optionalScheduleInput(record.schedule, `${label}.schedule`),
  };
}

export function parseRunsReconfigureParams(value: unknown, label: string): RunsReconfigureParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["target", "vars", "message"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    target: requiredRunIdString(record.target, `${label}.target`),
    vars: record.vars === undefined ? undefined : stringRecord(record.vars, `${label}.vars`),
    message: optionalString(record.message, `${label}.message`),
  };
}

export function parseRunScheduleParams(value: unknown, label: string): RunScheduleParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["target", "schedule"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    target: requiredString(record.target, `${label}.target`),
    schedule: requiredScheduleInput(record.schedule, `${label}.schedule`),
  };
}

export function parseRunSetNameParams(value: unknown, label: string): RunSetNameParams {
  const record = asRecord(value, label);
  return {
    target: requiredString(record.target, `${label}.target`),
    name: requiredNullableRunName(record.name, `${label}.name`),
  };
}

export function parseRunSetNoteParams(value: unknown, label: string): RunSetNoteParams {
  const record = asRecord(value, label);
  return {
    target: requiredString(record.target, `${label}.target`),
    note: requiredNullableString(record.note, `${label}.note`),
  };
}

export function parseRunSetPinnedParams(value: unknown, label: string): RunSetPinnedParams {
  const record = asRecord(value, label);
  return {
    target: requiredString(record.target, `${label}.target`),
    pinned: requiredBoolean(record.pinned, `${label}.pinned`),
  };
}

export function parseRunSetBackendSessionParams(
  value: unknown,
  label: string,
): RunSetBackendSessionParams {
  const record = asRecord(value, label);
  return {
    target: requiredString(record.target, `${label}.target`),
    backendSessionId: requiredBackendSessionId(
      record.backendSessionId,
      `${label}.backendSessionId`,
    ),
  };
}

export function parseRunSetGroupParams(value: unknown, label: string): RunSetGroupParams {
  const record = asRecord(value, label);
  return {
    target: requiredString(record.target, `${label}.target`),
    runGroupId: requiredRunGroupId(record.runGroupId, `${label}.runGroupId`),
  };
}

function parseRunListScope(value: unknown, label: string): RunListScopeFilter | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, label);
  const kind = optionalEnum(record.kind, `${label}.kind`, ["cwd", "repo", "global", "group"]);
  if (kind === undefined) {
    throw new RequestValidationError(`${label}.kind is required`);
  }
  if (kind === "cwd") {
    return {
      kind,
      cwd: requiredString(record.cwd, `${label}.cwd`),
    };
  }
  if (kind === "repo") {
    return {
      kind,
      repo: requiredString(record.repo, `${label}.repo`),
    };
  }
  if (kind === "group") {
    return {
      kind,
      runGroupId: requiredRunGroupId(record.runGroupId, `${label}.runGroupId`),
    };
  }
  return { kind };
}

export function parseRunsListParams(value: unknown, label: string): RunsListParams {
  const record = asRecord(value, label);
  return {
    includeArchived: optionalBoolean(record.includeArchived, `${label}.includeArchived`),
    scope: parseRunListScope(record.scope, `${label}.scope`),
  };
}

export function parseAttachmentsListParams(value: unknown, label: string): AttachmentsListParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["runId", "scope"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    runId: requiredRunIdString(record.runId, `${label}.runId`),
    scope: optionalEnum(record.scope, `${label}.scope`, ["run", "group"]),
  };
}

export function parseAttachmentsRemoveParams(
  value: unknown,
  label: string,
): AttachmentsRemoveParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["runId", "attachmentId"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    runId: requiredRunIdString(record.runId, `${label}.runId`),
    attachmentId: requiredNonEmptyString(record.attachmentId, `${label}.attachmentId`),
  };
}

export function parseAttachmentsUploadOpenParams(
  value: unknown,
  label: string,
): AttachmentsUploadOpenParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["runId", "name", "mimeType", "size"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    runId: requiredRunIdString(record.runId, `${label}.runId`),
    name: requiredNonEmptyString(record.name, `${label}.name`),
    mimeType: optionalString(record.mimeType, `${label}.mimeType`),
    size: optionalNonNegativeInteger(record.size, `${label}.size`),
  };
}

export function parseAttachmentsUploadFinishParams(
  value: unknown,
  label: string,
): AttachmentsUploadFinishParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["streamId"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    streamId: requiredNonEmptyString(record.streamId, `${label}.streamId`),
  };
}

export function parseAttachmentsDownloadParams(
  value: unknown,
  label: string,
): AttachmentsDownloadParams {
  const record = asRecord(value, label);
  const allowedKeys = new Set(["runId", "attachmentId"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }
  return {
    runId: requiredRunIdString(record.runId, `${label}.runId`),
    attachmentId: requiredNonEmptyString(record.attachmentId, `${label}.attachmentId`),
  };
}

function requiredBase64Data(value: unknown, label: string): string {
  const data = requiredString(value, label);
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new RequestValidationError(`${label} must be base64-encoded bytes`);
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.byteLength < 1 || decoded.byteLength > STREAM_MAX_CHUNK_BYTES) {
    throw new RequestValidationError(`${label} must decode to 1..${STREAM_MAX_CHUNK_BYTES} bytes`);
  }
  return data;
}

function requiredStreamWindowBytes(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RequestValidationError(`${label} must be a positive safe integer`);
  }
  if (value > STREAM_MAX_BUFFERED_BYTES_PER_STREAM) {
    throw new RequestValidationError(
      `${label} must be less than or equal to ${STREAM_MAX_BUFFERED_BYTES_PER_STREAM}`,
    );
  }
  return value;
}

export function parseStreamNotification(value: unknown): StreamNotification {
  const record = asRecord(value, "stream notification");
  if (record.jsonrpc !== "2.0") {
    throw new RequestValidationError("stream notification jsonrpc must be 2.0");
  }
  const method = requiredString(record.method, "stream notification method");
  const params = asRecord(record.params, `${method} params`);
  switch (method) {
    case "stream.data":
      return {
        jsonrpc: "2.0",
        method,
        params: {
          streamId: requiredNonEmptyString(params.streamId, "stream.data streamId"),
          seq: requiredNonNegativeInteger(params.seq, "stream.data seq"),
          data: requiredBase64Data(params.data, "stream.data data"),
        },
      };
    case "stream.end":
      return {
        jsonrpc: "2.0",
        method,
        params: {
          streamId: requiredNonEmptyString(params.streamId, "stream.end streamId"),
          seq: requiredNonNegativeInteger(params.seq, "stream.end seq"),
        },
      };
    case "stream.error":
      return {
        jsonrpc: "2.0",
        method,
        params: {
          streamId: requiredNonEmptyString(params.streamId, "stream.error streamId"),
          message: requiredNonEmptyString(params.message, "stream.error message"),
          code: optionalNonEmptyString(params.code, "stream.error code"),
        },
      };
    case "stream.cancel":
      return {
        jsonrpc: "2.0",
        method,
        params: {
          streamId: requiredNonEmptyString(params.streamId, "stream.cancel streamId"),
          reason: optionalString(params.reason, "stream.cancel reason"),
        },
      };
    case "stream.window":
      return {
        jsonrpc: "2.0",
        method,
        params: {
          streamId: requiredNonEmptyString(params.streamId, "stream.window streamId"),
          bytes: requiredStreamWindowBytes(params.bytes, "stream.window bytes"),
        },
      };
    default:
      throw new RequestValidationError(`unknown stream method: ${method}`);
  }
}

function decodeQueryComponent(value: string, label: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    throw new RequestValidationError(`${label} must be valid percent-encoded text`);
  }
}

function queryEntries(search: string): Map<string, string> {
  const entries = new Map<string, string>();
  const trimmed = search.startsWith("?") ? search.slice(1) : search;
  if (trimmed.length === 0) {
    return entries;
  }
  for (const pair of trimmed.split("&")) {
    if (pair.length === 0) {
      continue;
    }
    const separatorIndex = pair.indexOf("=");
    const rawKey = separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : pair.slice(separatorIndex + 1);
    const decodedKey = decodeQueryComponent(rawKey, "query parameter name");
    entries.set(
      decodedKey,
      decodeQueryComponent(rawValue, `value for query parameter '${decodedKey}'`),
    );
  }
  return entries;
}

export function parseRunInputSurfaceQuery(search: string): RunInputSurfaceParams {
  const entries = queryEntries(search);
  return {
    agent: requiredNonEmptyString(entries.get("agent"), "agent"),
    assignment: requiredNonEmptyString(entries.get("assignment"), "assignment"),
    cwd: optionalNonEmptyString(entries.get("cwd"), "cwd"),
  };
}
