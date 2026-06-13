import type { UIAgentRuntimeModule } from "../types";
import { buildProcessConfig } from "./build-config";
import { ProcessConfigFields } from "./config-fields";
import { parseProcessStdoutLine } from "./parse-stdout";

export const processUIAdapter: UIAgentRuntimeModule = {
  type: "process",
  label: "Shell Process",
  parseStdoutLine: parseProcessStdoutLine,
  ConfigFields: ProcessConfigFields,
  buildAdapterConfig: buildProcessConfig,
};
