import type { UIAgentRuntimeModule } from "../types";
import { parseHttpStdoutLine } from "./parse-stdout";
import { HttpConfigFields } from "./config-fields";
import { buildHttpConfig } from "./build-config";

export const httpUIAdapter: UIAgentRuntimeModule = {
  type: "http",
  label: "HTTP Webhook",
  parseStdoutLine: parseHttpStdoutLine,
  ConfigFields: HttpConfigFields,
  buildAdapterConfig: buildHttpConfig,
};
