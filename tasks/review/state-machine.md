---
schemaVersion: 1
id: review/state-machine
title: State machine & lifecycle correctness
---
Identify the explicit and implicit state machines in the
code. Examples: persisted status enums, session lifecycles,
build-phase transitions, resource acquire/release cycles.

For each, ask:
  - Are all states reachable? Are any unreachable?
  - Are illegal transitions guarded against, or just
    unreachable by accident? (Defense in depth: can a
    corrupted input trigger an illegal start state?)
  - On failure mid-transition, does the persisted state
    make sense, or is it stuck between two consistent
    states?
  - Are status fields ever stale relative to the truth
    (e.g. `running` after the process died)?
