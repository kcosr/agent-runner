import type { RunInputField } from "@agent-runner/core/contracts/run-input-surface.js";
import { useEffect, useRef } from "react";
import { AppShell, TopbarPrimaryNav } from "../components/app-shell.js";
import { useNewRunState } from "./use-new-run-state.js";

function SurfaceField({
  field,
  invalid,
  onChange,
  registerRef,
  value,
}: {
  field: RunInputField;
  invalid: boolean;
  onChange: (value: string) => void;
  registerRef: (key: string, element: HTMLElement | null) => void;
  value: string;
}) {
  const controlId = `new-run-${field.key}`;
  const describedById = `${field.key}-description`;
  const isReadOnlyLauncher = field.inputKind === "launcher";

  return (
    <div className="new-run-field" data-invalid={invalid ? "true" : undefined}>
      <div className="new-run-field__header">
        <label className="new-run-field__label" htmlFor={controlId}>
          {field.label}
        </label>
        {field.required ? <span className="new-run-field__required">Required</span> : null}
      </div>
      {field.description.length > 0 ? (
        <span className="new-run-field__description" id={describedById}>
          {field.description}
        </span>
      ) : null}
      {field.editable && !isReadOnlyLauncher ? (
        field.inputKind === "textarea" ? (
          <textarea
            aria-label={field.label}
            aria-describedby={field.description.length > 0 ? describedById : undefined}
            className="new-run-textarea"
            id={controlId}
            onChange={(event) => onChange(event.target.value)}
            ref={(element) => registerRef(field.key, element)}
            rows={5}
            value={value}
          />
        ) : field.inputKind === "enum" ||
          field.inputKind === "effort" ||
          field.inputKind === "launcher" ||
          field.inputKind === "boolean" ? (
          <select
            aria-label={field.label}
            aria-describedby={field.description.length > 0 ? describedById : undefined}
            className="new-run-input"
            id={controlId}
            onChange={(event) => onChange(event.target.value)}
            ref={(element) => registerRef(field.key, element)}
            value={value}
          >
            <option value="">Select…</option>
            {field.inputKind === "boolean" ? (
              <>
                <option value="true">True</option>
                <option value="false">False</option>
              </>
            ) : (
              (field.inputKind === "launcher"
                ? ["direct", ...(field.enumValues ?? [])]
                : (field.enumValues ?? [])
              ).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))
            )}
          </select>
        ) : (
          <input
            aria-label={field.label}
            aria-describedby={field.description.length > 0 ? describedById : undefined}
            className="new-run-input"
            id={controlId}
            onChange={(event) => onChange(event.target.value)}
            ref={(element) => registerRef(field.key, element)}
            type={field.inputKind === "number" ? "number" : "text"}
            value={value}
          />
        )
      ) : (
        <div className="new-run-readonly">
          {typeof field.value === "object" ? JSON.stringify(field.value) : value || "Unset"}
        </div>
      )}
    </div>
  );
}

function SurfaceSection({
  title,
  fields,
  state,
}: {
  title: string;
  fields: RunInputField[];
  state: ReturnType<typeof useNewRunState>;
}) {
  if (fields.length === 0) {
    return null;
  }

  function fieldValue(field: RunInputField) {
    return !field.editable || field.inputKind === "launcher"
      ? state.readOnlyFieldValue(field)
      : state.fieldValue(field);
  }

  return (
    <section className="new-run-section">
      <div className="new-run-section__heading">
        <h2>{title}</h2>
      </div>
      <div className="new-run-grid">
        {fields.map((field) => (
          <SurfaceField
            field={field}
            invalid={state.isFieldInvalid(field)}
            key={field.key}
            onChange={(value) => state.updateDraft(field.key, value)}
            registerRef={state.registerFieldRef}
            value={fieldValue(field)}
          />
        ))}
      </div>
    </section>
  );
}

function LoadingSurface() {
  return (
    <div className="new-run-loading" aria-live="polite">
      <div className="new-run-loading__card">
        <div className="skeleton-line skeleton-line--short" />
        <div className="skeleton-line skeleton-line--medium" />
        <div className="skeleton-line" />
      </div>
      <div className="new-run-loading__card">
        <div className="skeleton-line skeleton-line--short" />
        <div className="skeleton-line skeleton-line--medium" />
        <div className="skeleton-line" />
      </div>
    </div>
  );
}

export function NewRunRoute() {
  const state = useNewRunState();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const surfaceErrorRef = useRef<HTMLDivElement | null>(null);

  function fieldValue(field: RunInputField) {
    return !field.editable || field.inputKind === "launcher"
      ? state.readOnlyFieldValue(field)
      : state.fieldValue(field);
  }

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (state.isSurfaceError) {
      surfaceErrorRef.current?.focus();
    }
  }, [state.isSurfaceError]);

  return (
    <AppShell
      primary={
        <div className="new-run-page">
          <div className="new-run-header">
            <p className="boot-eyebrow">agent-runner</p>
            <h1 ref={headingRef} tabIndex={-1}>
              New Run
            </h1>
            <p className="new-run-header__copy">
              Choose an agent and assignment, review the static run inputs, then initialize or start
              the run.
            </p>
          </div>

          <section className="new-run-section">
            <div className="new-run-section__heading">
              <h2>Context</h2>
            </div>
            <div className="new-run-grid">
              <label className="new-run-field">
                <div className="new-run-field__header">
                  <span className="new-run-field__label">Agent</span>
                  <span className="new-run-field__required">Required</span>
                </div>
                <select
                  aria-label="Agent"
                  className="new-run-input"
                  onChange={(event) => state.setSelectedAgent(event.target.value)}
                  value={state.selectedAgent}
                >
                  <option value="">Select an agent…</option>
                  {state.agentOptions.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="new-run-field">
                <div className="new-run-field__header">
                  <span className="new-run-field__label">Assignment</span>
                  <span className="new-run-field__required">Required</span>
                </div>
                <select
                  aria-label="Assignment"
                  className="new-run-input"
                  onChange={(event) => state.setSelectedAssignment(event.target.value)}
                  value={state.selectedAssignment}
                >
                  <option value="">Select an assignment…</option>
                  {state.assignmentOptions.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="new-run-field">
                <div className="new-run-field__header">
                  <label className="new-run-field__label" htmlFor="new-run-name">
                    Name
                  </label>
                </div>
                <span className="new-run-field__description" id="new-run-name-description">
                  {state.nameDescription}
                </span>
                <input
                  aria-describedby="new-run-name-description"
                  aria-label="Name"
                  className="new-run-input"
                  id="new-run-name"
                  onChange={(event) => state.updateDraft("name", event.target.value)}
                  ref={(element) => state.registerFieldRef("name", element)}
                  type="text"
                  value={state.nameValue}
                />
              </div>

              {state.contextFields.map((field) => (
                <SurfaceField
                  field={field}
                  invalid={state.isFieldInvalid(field)}
                  key={field.key}
                  onChange={(value) => state.updateDraft(field.key, value)}
                  registerRef={state.registerFieldRef}
                  value={fieldValue(field)}
                />
              ))}
            </div>
          </section>

          {state.isIdle ? (
            <div className="new-run-empty">
              <h2>Choose an agent and assignment</h2>
              <p>
                The task and execution sections appear after the daemon resolves the static input
                surface.
              </p>
            </div>
          ) : state.isLoadingSurface ? (
            <LoadingSurface />
          ) : state.isSurfaceError ? (
            <div className="new-run-inline-error" ref={surfaceErrorRef} role="alert" tabIndex={-1}>
              <h2>Run input surface failed to load</h2>
              <p>
                {state.surfaceErrorMessage ?? "The daemon could not resolve the selected inputs."}
              </p>
              <button className="btn" onClick={() => void state.retrySurface()} type="button">
                Retry
              </button>
            </div>
          ) : (
            <>
              <SurfaceSection fields={state.taskFields} state={state} title="Task" />
              <SurfaceSection fields={state.executionFields} state={state} title="Execution" />
            </>
          )}

          {state.submitError ? (
            <div
              className="new-run-submit-error"
              ref={state.submitErrorRef}
              role="alert"
              tabIndex={-1}
            >
              {state.submitError}
            </div>
          ) : null}

          <footer className="new-run-footer">
            <button className="btn btn--quiet" onClick={state.cancel} type="button">
              Cancel
            </button>
            <div className="new-run-footer__actions">
              <button
                className="btn"
                disabled={!state.formReady || state.initPending || state.startPending}
                onClick={() => void state.submit("init")}
                type="button"
              >
                {state.initPending ? "Initializing…" : "Initialize"}
              </button>
              <button
                className="btn btn--primary"
                disabled={!state.formReady || state.initPending || state.startPending}
                onClick={() => void state.submit("start")}
                type="button"
              >
                {state.startPending ? "Starting…" : "Start now"}
              </button>
            </div>
          </footer>
        </div>
      }
      toolbar={
        <header className="topbar">
          <TopbarPrimaryNav />
          <span className="page-title">New Run</span>
          <span className="topbar-spacer" />
        </header>
      }
    />
  );
}
