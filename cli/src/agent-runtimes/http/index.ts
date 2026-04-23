import type { CLIAgentRuntimeModule } from "@rudder/agent-runtime-utils";
import { printHttpStdoutEvent } from "./format-event.js";

export const httpCLIAdapter: CLIAgentRuntimeModule = {
  type: "http",
  formatStdoutEvent: printHttpStdoutEvent,
};
