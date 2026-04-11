import type { Backend, BackendInvokeResult } from "./types.js";

export class PassiveBackendNotInvokableError extends Error {
  constructor() {
    super(
      "the passive backend cannot be invoked. Passive agents are driven " +
        "externally via `task-runner task set` / `task add`. Use those commands " +
        "to work the task list and `task-runner status` to read progress.",
    );
    this.name = "PassiveBackendNotInvokableError";
  }
}

// Null-object backend for sidecar flows. A run with backend=passive is
// never executed by task-runner — callers `init` it, drive the task
// list through `task set` / `task add`, and check progress with
// `status`. The CLI rejects `task-runner run` on a passive agent
// before we ever get here, so `invoke` throwing is defense in depth.
export const passiveBackend: Backend = {
  id: "passive",
  async invoke(): Promise<BackendInvokeResult> {
    throw new PassiveBackendNotInvokableError();
  },
};
