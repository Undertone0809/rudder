import { buildPiLocalConfig, parsePiStdoutLine } from "@rudderhq/agent-runtime-pi-local/ui";
import type { UIAgentRuntimeModule } from "../types";
import { PiLocalConfigFields } from "./config-fields";

export const piLocalUIAdapter: UIAgentRuntimeModule = {
  type: "pi_local",
  label: "Pi (local)",
  parseStdoutLine: parsePiStdoutLine,
  ConfigFields: PiLocalConfigFields,
  buildAdapterConfig: buildPiLocalConfig,
};
