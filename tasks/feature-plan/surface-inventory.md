---
schemaVersion: 1
id: feature-plan/surface-inventory
title: Produce the surface inventory
---
Some bug classes don't fall cleanly into any
review dimension. The most common: a feature is
"implemented" at one layer but never connected at
another — a CLI flag is parsed but never read, an
HTTP route is documented but has no handler, a UI
form field is collected but never POSTed, a config
key is loaded but never consulted. The surface is
*named* in user-visible text, but the data flow
stops short of completing the round trip. Unit
tests, lint, and docs checks all pass; the user
hits a silent dead end.

The defense is an explicit Surface Inventory: for
every named user-facing entity this feature
introduces, modifies, or removes, list the layers
it must travel and the symmetric peers it must
stay aligned with. The inventory becomes a
checklist the implementer must satisfy and the
reviewer can re-derive from the diff.

## What counts as a surface element

A surface element is any named entity a user
types, clicks, or configures:
  - CLI flag, positional, or subcommand name
  - HTTP route or query/body parameter
  - RPC method or RPC parameter key
  - Environment variable
  - Config-file key
  - UI form field, button label, or preference key
  - Public function / exported symbol whose name
    appears in user-facing docs
  - Persisted-data field that appears in
    user-facing output

Surface elements are *names* the user encounters.
Internal helpers, private types, and unexported
implementation details are out of scope.

## What the inventory looks like

For every surface element introduced, modified, or
removed by this feature, record:

  - **Name** — the literal token the user sees
    (`--foo`, `POST /bar`, `BAZ_ENV`, `pref.qux`).
  - **Disposition** — `added`, `changed`, or
    `removed`.
  - **Layers it must traverse** — the sequence of
    code locations where the value must be *read*,
    not just declared. For a CLI flag this is
    typically `parser → command handler → service
    → projection → renderer`. List every layer the
    value must be consumed at, including the test
    layer. The implementer must land all of them;
    the reviewer will trace each. Use file paths
    relative to the target repo's root when you
    can already name them; otherwise describe the
    layer abstractly (e.g. "request handler",
    "persistence layer") and the implementer will
    fill in the specific path.
  - **Symmetric peers** — if the same surface is
    mirrored on another transport (CLI ↔ HTTP ↔
    RPC ↔ UI), name each peer. Asymmetric peers
    (one transport accepts the surface, another
    rejects it) are almost always bugs unless the
    contract explicitly says otherwise.
  - **Removal twin** — for `removed` entries, the
    old name being retired. The implementer must
    ensure the old name appears nowhere in the
    live runtime path after the change. (Tests
    for older migration paths, changelog history,
    and migration scripts can still reference it,
    and the reviewer will not flag those.)

Render the inventory as a structured markdown list,
one block per surface element. An illustrative
shape (substitute the real layers for the target
project's structure):

    - **Name**: `--example-flag`
      **Disposition**: added
      **Layers**:
        - parser — produces a parsed flag value
        - command handler — reads the parsed value
          and passes it to the service
        - service — accepts the filter and applies it
        - integration test — exercises the flag
          end-to-end from the CLI entry point
      **Symmetric peers**: `GET /api/...?exampleFlag=...` (HTTP), `service.list { exampleFlag }` (RPC)
      **Removal twin**: none

## When the inventory is empty

For pure refactors with no user-visible surface
change, the correct answer is an explicitly empty
inventory. State in Notes:

    No user-visible surfaces are introduced,
    changed, or removed by this feature.

Do not produce a placeholder inventory just to
fill the section — the reviewer's
surface-completeness pass treats an explicit
"no surfaces" statement the same as zero entries.
Empty when truly empty, complete when not.

## What goes into Notes

Paste the full inventory (or the explicit "no
surfaces" statement) into this task's Notes. It
will be copied verbatim into downstream plan
artifacts or consumed directly by the implementation
task contract. The implementer reads it before
shipping; the reviewer cross-checks the diff against
it in plan-coverage and surface-completeness.

If you discover mid-task that a surface element is
ambiguous (does this flag appear on the CLI only,
or also on the HTTP API? Is this preference per-user
or global?), mark **this** task `blocked` with the
missing dimension and a targeted question — same
gate as `feature-plan/capture-feature`. The caller should answer
"where does this surface live?" before the
inventory is finalized; an under-decomposed
inventory produces under-implemented features.
