import type { CLIAgentRuntimeModule } from "@rudderhq/agent-runtime-utils";
import { printHttpStdoutEvent } from "./format-event.js";

export const httpCLIAdapter: CLIAgentRuntimeModule = {
  type: "http",
  formatStdoutEvent: printHttpStdoutEvent,
};
