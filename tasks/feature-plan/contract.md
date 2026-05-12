---
schemaVersion: 1
id: feature-plan/contract
title: Produce the feature contract artifact
---
Before you draft the plan, pin down the exact shape
of what the implementer is going to build. The
contract dimensions you walked in `feature-plan/capture-feature` were the
*requirements check*; this task is the *deliverable*
— a concrete, greppable artifact the implementer and
reviewer both work from.

Write the contract into this task's Notes using the
format appropriate for the feature type. The contract
must be specific enough that two people reading it
would produce identical implementations on the
observable surface. Vague contracts produce drifting
implementations and weak reviews.

**CLI features** — a command reference table:

    ## `<command-name>`

    **Synopsis**: `<binary> <command> [flags] <args>`

    **Description**: one sentence on what it does.

    **Args**:
      - `<arg1>` — type, required/optional, default.

    **Flags**:
      - `--flag-name` — type, required/optional,
        default, one-sentence description.

    **Output (text)**:
        <paste a sample block showing exactly what
        the text output looks like for the happy
        path>

    **Output (json)**:
        ```json
        { "example": "exact shape" }
        ```

    **Exit codes**:
      - 0 — success case
      - 1 — specific failure case
      - ... etc.

    **Error behaviors**:
      - malformed input → exit code, stderr message
      - missing resource → exit code, stderr message
      - duplicate / ambiguous match → exit code,
        stderr message

    **Examples**:
        <2-3 real invocations with their output>

**API / library features** — a signature block plus
error matrix:

    ## `<function-or-endpoint>`

    **Signature**: exact type signature (TS, Go,
    Python, etc.) or HTTP method/path + request
    body schema.

    **Returns**: exact return type / response shape.

    **Errors**: table of `Error type → When raised
    → Caller remediation`.

    **Auth**: required permissions / tokens, if any.

    **Migration / compatibility**: hot cut unless the
    brief explicitly requires compatibility or an
    additive/deprecation path.

**Data / schema features** — a schema diff plus
migration:

    ## Schema change

    **Before**: existing shape.
    **After**: new shape.
    **Migration**: hot cut / additive / rollback plan,
    whichever the brief explicitly requires.
    **Pre-existing data**: how it is handled.

**UI features** — a state-transition sketch:

    ## Interaction model

    **Entry points**: where the user enters.
    **States**: list of states and transitions.
    **Loading / empty / error states**: each with
    a one-line description of what the user sees.
    **Accessibility**: keyboard, screen-reader,
    responsive requirements.

**Refactor** — a scope and behavior-preservation
statement:

    ## Scope
    **Files in scope**: list.
    **Files out of scope**: list.
    **Behavior preserved**: list of existing tests
    that must still pass verbatim.
    **Rollback**: one-line plan.

**Other** — adapt the nearest format above, or
produce a short "what success looks like" bullet
list if none of the above fit.

Once the contract artifact is written, paste the
entire block into this task's Notes. It will be
copied verbatim into downstream plan artifacts or
consumed directly by the implementation task
contract, so the implementer and reviewer both work
from the same observable surface.

If you are mid-task and realize the contract is
still ambiguous on a dimension you missed in `feature-plan/capture-feature`,
mark **this** task `blocked` with the missing
dimension and targeted questions — same gate as
`feature-plan/capture-feature`. It is better to catch a contract gap here
than to let the implementer discover it.
