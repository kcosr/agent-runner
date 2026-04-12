import { renderRunEvent } from "../../dist/cli/render-run.js";

export function createRunEventCapture() {
  const stdoutChunks = [];
  const stderrChunks = [];

  return {
    emitEvent(event) {
      for (const chunk of renderRunEvent(event)) {
        if (chunk.stream === "stdout") {
          stdoutChunks.push(chunk.text);
        } else {
          stderrChunks.push(chunk.text);
        }
      }
    },
    stdout() {
      return stdoutChunks.join("");
    },
    stderr() {
      return stderrChunks.join("");
    },
  };
}
