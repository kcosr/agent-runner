import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  LauncherConfigError,
  LauncherNotFoundError,
  TaskConfigError,
  TaskNotFoundError as TaskDefinitionNotFoundError,
} from "@task-runner/core/config/loader.js";
import {
  CommandError,
  ConflictError,
  TaskNotFoundError,
} from "@task-runner/core/core/commands/service.js";
import { HookRuntimeError } from "@task-runner/core/core/hooks/runtime.js";
import {
  AttachmentError,
  AttachmentNotFoundError,
} from "@task-runner/core/core/run/attachments.js";
import { ResumeError, RunNotFoundError } from "@task-runner/core/core/run/manifest.js";
import { ReconfigureLockedFieldError } from "@task-runner/core/core/run/reconfigure.js";
import {
  EmptyPromptError,
  InvalidAddedTaskError,
  InvalidBackendSessionError,
  LockedFieldError,
  RecursionDepthError,
  VarResolutionError,
} from "@task-runner/core/core/run/run-loop.js";
import { ScheduleValidationError } from "@task-runner/core/core/run/schedule.js";
import { RunCommandError, UnknownBackendError } from "@task-runner/core/run-command.js";
import { RequestValidationError } from "./request-parsing.js";

interface HttpErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isKnownControlPlaneError(err: unknown): boolean {
  return (
    err instanceof RequestValidationError ||
    err instanceof AttachmentError ||
    err instanceof CommandError ||
    err instanceof ConflictError ||
    err instanceof TaskNotFoundError ||
    err instanceof RunNotFoundError ||
    err instanceof ResumeError ||
    err instanceof ReconfigureLockedFieldError ||
    err instanceof UnknownBackendError ||
    err instanceof AgentNotFoundError ||
    err instanceof AgentConfigError ||
    err instanceof AssignmentNotFoundError ||
    err instanceof AssignmentConfigError ||
    err instanceof LauncherNotFoundError ||
    err instanceof LauncherConfigError ||
    err instanceof TaskDefinitionNotFoundError ||
    err instanceof TaskConfigError ||
    err instanceof RunCommandError ||
    err instanceof VarResolutionError ||
    err instanceof LockedFieldError ||
    err instanceof InvalidAddedTaskError ||
    err instanceof EmptyPromptError ||
    err instanceof HookRuntimeError ||
    err instanceof RecursionDepthError ||
    err instanceof InvalidBackendSessionError ||
    err instanceof ScheduleValidationError
  );
}

export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) {
    return err;
  }
  if (err instanceof RequestValidationError) {
    return new HttpError(400, "INVALID_REQUEST", err.message, err);
  }
  if (
    err instanceof AgentNotFoundError ||
    err instanceof AssignmentNotFoundError ||
    err instanceof LauncherNotFoundError ||
    err instanceof TaskDefinitionNotFoundError ||
    err instanceof RunNotFoundError ||
    err instanceof TaskNotFoundError ||
    err instanceof AttachmentNotFoundError
  ) {
    return new HttpError(404, "NOT_FOUND", "resource not found", err);
  }
  if (err instanceof ConflictError) {
    return new HttpError(409, "CONFLICT", err.message, err);
  }
  if (
    err instanceof ReconfigureLockedFieldError ||
    err instanceof LockedFieldError ||
    err instanceof ResumeError ||
    err instanceof HookRuntimeError
  ) {
    return new HttpError(409, "CONFLICT", err.message, err);
  }
  if (err instanceof VarResolutionError) {
    return new HttpError(400, "INVALID_REQUEST", err.message, err);
  }
  if (isKnownControlPlaneError(err)) {
    return new HttpError(
      422,
      err instanceof CommandError ? "COMMAND_ERROR" : "INVALID_COMMAND",
      err instanceof Error ? err.message : String(err),
      err,
    );
  }
  return new HttpError(500, "INTERNAL_ERROR", "internal server error", err);
}

export function errorBody(err: unknown): HttpErrorEnvelope {
  const httpError = toHttpError(err);
  return {
    error: {
      code: httpError.code,
      message: httpError.message,
    },
  };
}
