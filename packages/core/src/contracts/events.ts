import type { RunEvent } from "../core/run/run-loop.js";

export interface RunEventEnvelope {
  runId: string;
  event: RunEvent;
}
