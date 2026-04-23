import type { CLIAgentRuntimeModule } from "@rudder/agent-runtime-utils";
import { printProcessStdoutEvent } from "./format-event.js";

export const processCLIAdapter: CLIAgentRuntimeModule = {
  type: "process",
  formatStdoutEvent: printProcessStdoutEvent,
};
