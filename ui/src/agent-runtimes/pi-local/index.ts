import type { UIAgentRuntimeModule } from "../types";
import { parsePiStdoutLine } from "@rudder/agent-runtime-pi-local/ui";
import { PiLocalConfigFields } from "./config-fields";
import { buildPiLocalConfig } from "@rudder/agent-runtime-pi-local/ui";

export const piLocalUIAdapter: UIAgentRuntimeModule = {
  type: "pi_local",
  label: "Pi (local)",
  parseStdoutLine: parsePiStdoutLine,
  ConfigFields: PiLocalConfigFields,
  buildAdapterConfig: buildPiLocalConfig,
};
