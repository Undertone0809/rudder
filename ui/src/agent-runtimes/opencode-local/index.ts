import type { UIAgentRuntimeModule } from "../types";
import { parseOpenCodeStdoutLine } from "@rudder/agent-runtime-opencode-local/ui";
import { OpenCodeLocalConfigFields } from "./config-fields";
import { buildOpenCodeLocalConfig } from "@rudder/agent-runtime-opencode-local/ui";

export const openCodeLocalUIAdapter: UIAgentRuntimeModule = {
  type: "opencode_local",
  label: "OpenCode (local)",
  parseStdoutLine: parseOpenCodeStdoutLine,
  ConfigFields: OpenCodeLocalConfigFields,
  buildAdapterConfig: buildOpenCodeLocalConfig,
};
