---
schemaVersion: 1
id: feature-plan/capture-feature
title: Capture the feature and implementation brief
---
The feature you are planning for was handed to you as
the user message that started this run. Read it in
full, then restate it in your own words in Notes:
  - What is the feature? (one paragraph, concrete)
  - What problem does it solve? What's the motivation?
  - What is explicitly in scope?
  - What is explicitly out of scope?

If the brief included a rough implementation plan,
capture every concrete step mentioned, even the ones
you don't yet fully understand. Your job as planner is
to refine those steps into an executable task list,
not to discard them.

## Contract dimensions (ambiguity gate)

Before you move on, walk the list of **contract
dimensions** relevant to the type of feature you are
planning and check whether the brief actually pins
each one down. Do not guess; do not fill gaps with
assumptions. An unanswered contract question at this
stage becomes silently-wrong code later.

When the feature changes a config/schema/API contract,
plan for the end-state shape directly unless the caller
explicitly asks for compatibility or migration support.
Do not quietly introduce fallback parsing, heuristics,
alias fields, bridge routes, or dual-shape readers just
to smooth over a redesign.

Identify the feature type first:
  - **CLI feature** — adds or changes a command,
    subcommand, flag, or argument.
  - **API / library feature** — adds or changes an
    exported function, HTTP endpoint, RPC method,
    or public type.
  - **Data / schema feature** — adds or changes a
    persisted shape, config file, database schema,
    or migration.
  - **UI feature** — adds or changes a screen, flow,
    component, or interaction model.
  - **Refactor** — restructures existing code
    without an intended external behavior change.
  - **Other** — infrastructure, tooling, build, etc.

Then apply the dimension checklist for that type:

**CLI**: exact command/subcommand name, exact flag
names and short/long forms, required vs optional
args, default values, text output format, JSON
output format if any, exit codes per failure mode,
behavior on malformed input, behavior on duplicate
or missing resources.

**API / library**: function/endpoint name, argument
types and names, return type, error types and when
each is raised, auth/permission model, request
schema, response schema, backwards compatibility
requirements.

**Data / schema**: exact field names and types,
nullability, defaults, indexes, migration direction
(additive only vs destructive), rollback plan,
behavior on pre-existing data.

**UI**: entry point, state transitions, loading
and error states, empty states, keyboard /
accessibility requirements, responsive behavior.

**Refactor**: scope boundaries (what files are in
and out), behavior-preservation criteria (what
existing tests must still pass), rollback plan.

For **every** dimension above that is relevant to
the feature type, ask: does the brief give me the
answer, or am I about to make it up? Write each
dimension and its status into Notes as:

    - <dimension>: <answer from brief> — OR —
    - <dimension>: **ambiguous**

## If anything is ambiguous, block

If any relevant dimension is `ambiguous`, **mark this
task `blocked`** with the following in Notes:

  1. The list of ambiguous dimensions.
  2. Up to three **targeted, concrete** questions
     you need the caller to answer before you can
     plan. "What should this do?" is not targeted;
     "Should `task list agents` print JSON by
     default, or only with `--output-format json`
     like the other commands?" is.
  3. A one-sentence summary of what you have
     understood so far, so the caller can confirm
     your framing.

Task-runner will halt the run cleanly (exit 2). The
caller resumes with a follow-up message answering
your questions:

    {{agent_runner_cmd}} run --resume-run {{run_id}} \
      "answers: <your answers here>"

On resume, the runner normalizes `blocked` back to
`pending` and you re-enter this task with the
caller's answers in the new turn. Update the Notes
block with the resolved dimensions and mark the
task `completed`.

**Do not assume**. Do not proceed to `feature-plan/survey-impact` with
unresolved ambiguity — your whole plan will be
built on a guess, and the ambiguity compounds
through impact survey, implementation tasks, and
review. A blocked run with three targeted
questions is faster than a bad plan you have to
throw away.

## After the gate

Once every contract dimension is resolved (either
from the brief or from a caller follow-up), also
list in Notes any **remaining** assumptions you are
making on non-contract details (naming, directory
placement, test file naming, etc.). These become
validation points the reviewer will check in its
plan-coverage pass later, but they do not block —
the contract gate only fires on the enumerated
dimensions above.
