import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  LauncherConfigError,
  LauncherNotFoundError,
} from "@task-runner/core/config/loader.js";
import {
  CommandError,
  ConflictError,
  TaskNotFoundError,
} from "@task-runner/core/core/commands/service.js";
import {
  AttachmentError,
  AttachmentNotFoundError,
} from "@task-runner/core/core/run/attachments.js";
import { RunLineageError } from "@task-runner/core/core/run/lineage.js";
import { ResumeError, RunNotFoundError } from "@task-runner/core/core/run/manifest.js";
import {
  EmptyPromptError,
  InvalidAddedTaskError,
  InvalidBackendSessionError,
  LockedFieldError,
  RecursionDepthError,
  VarResolutionError,
} from "@task-runner/core/core/run/run-loop.js";
import { RunCommandError, UnknownBackendError } from "@task-runner/core/run-command.js";
import { RequestValidationError } from "./request-parsing.js";

export interface HttpErrorEnvelope {
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
    err instanceof RunLineageError ||
    err instanceof ConflictError ||
    err instanceof TaskNotFoundError ||
    err instanceof RunNotFoundError ||
    err instanceof ResumeError ||
    err instanceof UnknownBackendError ||
    err instanceof AgentNotFoundError ||
    err instanceof AgentConfigError ||
    err instanceof AssignmentNotFoundError ||
    err instanceof AssignmentConfigError ||
    err instanceof LauncherNotFoundError ||
    err instanceof LauncherConfigError ||
    err instanceof RunCommandError ||
    err instanceof VarResolutionError ||
    err instanceof LockedFieldError ||
    err instanceof InvalidAddedTaskError ||
    err instanceof EmptyPromptError ||
    err instanceof RecursionDepthError ||
    err instanceof InvalidBackendSessionError
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
    err instanceof RunNotFoundError ||
    err instanceof TaskNotFoundError ||
    err instanceof AttachmentNotFoundError
  ) {
    return new HttpError(404, "NOT_FOUND", "resource not found", err);
  }
  if (err instanceof ConflictError) {
    return new HttpError(409, "CONFLICT", err.message, err);
  }
  if (isKnownControlPlaneError(err)) {
    return new HttpError(
      422,
      err instanceof CommandError || err instanceof RunLineageError
        ? "COMMAND_ERROR"
        : "INVALID_COMMAND",
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
