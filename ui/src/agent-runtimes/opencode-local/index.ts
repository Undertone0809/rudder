import { buildOpenCodeLocalConfig, parseOpenCodeStdoutLine } from "@rudderhq/agent-runtime-opencode-local/ui";
import type { UIAgentRuntimeModule } from "../types";
import { OpenCodeLocalConfigFields } from "./config-fields";

export const openCodeLocalUIAdapter: UIAgentRuntimeModule = {
  type: "opencode_local",
  label: "OpenCode (local)",
  parseStdoutLine: parseOpenCodeStdoutLine,
  ConfigFields: OpenCodeLocalConfigFields,
  buildAdapterConfig: buildOpenCodeLocalConfig,
};
