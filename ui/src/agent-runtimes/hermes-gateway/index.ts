import type { UIAgentRuntimeModule } from "../types";
import { buildHermesGatewayConfig } from "./build-config";
import { HermesGatewayConfigFields } from "./config-fields";
import { parseHermesGatewayStdoutLine } from "./parse-stdout";

export const hermesGatewayUIAdapter: UIAgentRuntimeModule = {
  type: "hermes_gateway",
  label: "Hermes",
  parseStdoutLine: parseHermesGatewayStdoutLine,
  ConfigFields: HermesGatewayConfigFields,
  buildAdapterConfig: buildHermesGatewayConfig,
};
