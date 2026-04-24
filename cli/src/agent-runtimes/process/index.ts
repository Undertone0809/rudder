import type { CLIAgentRuntimeModule } from "@rudderhq/agent-runtime-utils";
import { printProcessStdoutEvent } from "./format-event.js";

export const processCLIAdapter: CLIAgentRuntimeModule = {
  type: "process",
  formatStdoutEvent: printProcessStdoutEvent,
};
