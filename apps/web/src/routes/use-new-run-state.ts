import type {
  RunInputField,
  RunInputSurface,
} from "@kcosr/agent-runner-core/contracts/run-input-surface.js";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "../lib/api-client.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { useDaemonAuthToken } from "../lib/settings.js";

type FieldDraftValue = string;
type FieldDrafts = Record<string, FieldDraftValue>;
type SubmitMode = "init" | "start";

function isEmptyValue(value: string): boolean {
  return value.trim().length === 0;
}

function inputValueFromField(field: RunInputField): FieldDraftValue {
  if (field.value === null) {
    return "";
  }
  if (typeof field.value === "boolean") {
    return field.value ? "true" : "false";
  }
  return String(field.value);
}

function inputValueFromOptionalField(field: RunInputField | undefined): FieldDraftValue {
  return field ? inputValueFromField(field) : "";
}

function fieldValue(field: RunInputField, drafts: FieldDrafts): FieldDraftValue {
  if (!field.editable) {
    return inputValueFromField(field);
  }
  return drafts[field.key] ?? inputValueFromField(field);
}

function fieldIsVisible(field: RunInputField, drafts: FieldDrafts): boolean {
  if (!(field.hiddenWhenUnset && field.valueStatus !== "concrete")) {
    return true;
  }
  return field.editable && !isEmptyValue(fieldValue(field, drafts));
}

function fieldIsMeaningfulContextField(field: RunInputField, drafts: FieldDrafts): boolean {
  if (field.key === "name") {
    return true;
  }
  if (field.key !== "cwd") {
    return false;
  }
  return field.editable || !isEmptyValue(fieldValue(field, drafts));
}

function fieldIsMissing(field: RunInputField, drafts: FieldDrafts): boolean {
  if (!field.editable || !field.required) {
    return false;
  }
  return isEmptyValue(fieldValue(field, drafts));
}

function fieldHasInvalidFormat(field: RunInputField, drafts: FieldDrafts): boolean {
  if (!field.editable || field.inputKind !== "number") {
    return false;
  }
  const rawValue = fieldValue(field, drafts);
  return !isEmptyValue(rawValue) && Number.isNaN(Number(rawValue));
}

function parseFieldSubmissionValue(field: RunInputField, drafts: FieldDrafts): unknown {
  const rawValue = fieldValue(field, drafts);
  if (isEmptyValue(rawValue)) {
    return undefined;
  }
  switch (field.inputKind) {
    case "number":
      return Number(rawValue);
    case "boolean":
      return rawValue === "true";
    default:
      return rawValue;
  }
}

function readOnlyFieldValue(field: RunInputField): string {
  if (field.value === null) {
    return field.valueStatus === "delegated" ? "Resolved at run creation" : "Unset";
  }
  if (typeof field.value === "boolean") {
    return field.value ? "Yes" : "No";
  }
  if (typeof field.value === "object") {
    return JSON.stringify(field.value);
  }
  return String(field.value);
}

function editableFields(surface: RunInputSurface | undefined): RunInputField[] {
  if (!surface) {
    return [];
  }
  return [...surface.runSettings, ...surface.assignmentInputs].filter((field) => field.editable);
}

function buildStartPayload(
  selectedAgent: string,
  selectedAssignment: string,
  surface: RunInputSurface,
  drafts: FieldDrafts,
) {
  const overrides: Record<string, unknown> = {};
  const webVars: Record<string, string> = {};

  for (const field of surface.runSettings) {
    if (!field.editable) {
      continue;
    }
    const submitted = parseFieldSubmissionValue(field, drafts);
    const authored = field.value === null ? undefined : field.value;
    if (submitted === undefined || submitted === authored) {
      continue;
    }
    overrides[field.key] = submitted;
  }

  for (const field of surface.assignmentInputs) {
    const submitted = parseFieldSubmissionValue(field, drafts);
    const authored = field.value === null ? undefined : field.value;
    if (submitted === undefined || submitted === authored) {
      continue;
    }
    webVars[field.key] = String(submitted);
  }

  return {
    agent: selectedAgent,
    assignment: selectedAssignment,
    webVars,
    overrides,
  };
}

export function useNewRunState() {
  const config = useRuntimeConfig();
  const { daemonToken } = useDaemonAuthToken();
  const api = useMemo(() => createApiClient(config, { daemonToken }), [config, daemonToken]);
  const navigate = useNavigate();
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedAssignment, setSelectedAssignment] = useState("");
  const [drafts, setDrafts] = useState<FieldDrafts>({});
  const [submitError, setSubmitError] = useState<string>();
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const submitErrorRef = useRef<HTMLDivElement | null>(null);

  const agentsQuery = useQuery({
    queryKey: runQueryKeys.agents(),
    queryFn: () => api.listAgents(),
  });
  const assignmentsQuery = useQuery({
    queryKey: runQueryKeys.assignments(),
    queryFn: () => api.listAssignments(),
  });

  const surfaceQuery = useQuery({
    enabled: selectedAgent.length > 0 && selectedAssignment.length > 0,
    queryKey: runQueryKeys.inputSurface(selectedAgent, selectedAssignment),
    queryFn: ({ signal }) =>
      api.getRunInputSurface(
        {
          agent: selectedAgent,
          assignment: selectedAssignment,
        },
        { signal },
      ),
    retry: false,
  });

  useEffect(() => {
    if (!surfaceQuery.data) {
      return;
    }
    setDrafts((current) => {
      const next = { ...current };
      for (const field of editableFields(surfaceQuery.data)) {
        if (next[field.key] === undefined) {
          next[field.key] = inputValueFromField(field);
        }
      }
      return next;
    });
  }, [surfaceQuery.data]);

  const surface = surfaceQuery.data;
  const nameField = useMemo(
    () => (surface?.runSettings ?? []).find((field) => field.key === "name"),
    [surface],
  );
  const contextFields = useMemo(() => {
    return (surface?.runSettings ?? []).filter(
      (field) => field.key === "cwd" && fieldIsMeaningfulContextField(field, drafts),
    );
  }, [drafts, surface]);
  const taskFields = useMemo(
    () =>
      [
        ...(surface?.assignmentInputs ?? []),
        ...((surface?.runSettings ?? []).filter((field) => field.key === "message") ?? []),
      ].filter((field) => fieldIsVisible(field, drafts)),
    [drafts, surface],
  );
  const executionFields = useMemo(
    () =>
      (surface?.runSettings ?? []).filter(
        (field) =>
          field.key !== "name" &&
          field.key !== "cwd" &&
          field.key !== "message" &&
          fieldIsVisible(field, drafts),
      ),
    [drafts, surface],
  );
  const missingFieldKeys = useMemo(
    () =>
      editableFields(surface)
        .filter((field) => fieldIsMissing(field, drafts))
        .map((field) => field.key),
    [drafts, surface],
  );
  const invalidFormatFieldKeys = useMemo(
    () =>
      editableFields(surface)
        .filter((field) => fieldHasInvalidFormat(field, drafts))
        .map((field) => field.key),
    [drafts, surface],
  );
  const formReady =
    selectedAgent.length > 0 &&
    selectedAssignment.length > 0 &&
    surface !== undefined &&
    !surfaceQuery.isFetching &&
    !surfaceQuery.isError &&
    missingFieldKeys.length === 0 &&
    invalidFormatFieldKeys.length === 0;

  function registerFieldRef(key: string, element: HTMLElement | null) {
    if (!element) {
      fieldRefs.current.delete(key);
      return;
    }
    fieldRefs.current.set(key, element);
  }

  function focusFirstInvalidField() {
    const key = missingFieldKeys[0] ?? invalidFormatFieldKeys[0];
    if (!key) {
      return false;
    }
    const element = fieldRefs.current.get(key);
    if (!element) {
      return false;
    }
    element.focus();
    return true;
  }

  const initMutation = useMutation({
    mutationFn: async () => {
      if (!surface) {
        throw new Error("Run input surface is not loaded");
      }
      return await api.initRun(
        buildStartPayload(selectedAgent, selectedAssignment, surface, drafts),
      );
    },
    onError: (error: Error) => {
      setSubmitError(error.message);
      submitErrorRef.current?.focus();
    },
    onSuccess: async (run) => {
      setSubmitError(undefined);
      await queryClient.invalidateQueries({ queryKey: runQueryKeys.lists() });
      void navigate({ to: "/runs/$runId", params: { runId: run.runId } });
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!surface) {
        throw new Error("Run input surface is not loaded");
      }
      return await api.startRun(
        buildStartPayload(selectedAgent, selectedAssignment, surface, drafts),
      );
    },
    onError: (error: Error) => {
      setSubmitError(error.message);
      submitErrorRef.current?.focus();
    },
    onSuccess: async (runId) => {
      setSubmitError(undefined);
      await queryClient.invalidateQueries({ queryKey: runQueryKeys.lists() });
      void navigate({ to: "/runs/$runId", params: { runId } });
    },
  });

  function updateDraft(key: string, value: string) {
    setDrafts((current) => ({
      ...current,
      [key]: value,
    }));
    setSubmitError(undefined);
  }

  async function submit(mode: SubmitMode) {
    setAttemptedSubmit(true);
    if (!formReady) {
      focusFirstInvalidField();
      return;
    }
    if (mode === "init") {
      await initMutation.mutateAsync();
      return;
    }
    await startMutation.mutateAsync();
  }

  async function retrySurface() {
    await surfaceQuery.refetch();
  }

  function cancel() {
    void navigate({ to: "/" });
  }

  const loadingSurface =
    selectedAgent.length > 0 &&
    selectedAssignment.length > 0 &&
    surfaceQuery.isFetching &&
    !surface;

  return {
    agentOptions: agentsQuery.data?.entries ?? [],
    assignmentOptions: assignmentsQuery.data?.entries ?? [],
    selectedAgent,
    selectedAssignment,
    setSelectedAgent,
    setSelectedAssignment,
    nameDescription: nameField?.description ?? "Optional run name.",
    nameValue: drafts.name ?? inputValueFromOptionalField(nameField),
    contextFields,
    taskFields,
    executionFields,
    drafts,
    fieldValue: (field: RunInputField) => fieldValue(field, drafts),
    readOnlyFieldValue,
    updateDraft,
    registerFieldRef,
    isFieldInvalid: (field: RunInputField) =>
      attemptedSubmit &&
      (missingFieldKeys.includes(field.key) || invalidFormatFieldKeys.includes(field.key)),
    isLoadingSurface: loadingSurface,
    isIdle: selectedAgent.length === 0 || selectedAssignment.length === 0,
    isSurfaceError: surfaceQuery.isError,
    surfaceErrorMessage:
      surfaceQuery.error instanceof Error ? surfaceQuery.error.message : undefined,
    retrySurface,
    submitError,
    submitErrorRef,
    cancel,
    submit,
    initPending: initMutation.isPending,
    startPending: startMutation.isPending,
    formReady,
  };
}
