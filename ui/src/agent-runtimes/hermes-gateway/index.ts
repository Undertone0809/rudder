import type { UIAgentRuntimeModule } from "../types";
import { HermesGatewayConfigFields } from "./config-fields";
import { buildHermesGatewayConfig } from "./build-config";
import { parseHermesGatewayStdoutLine } from "./parse-stdout";

export const hermesGatewayUIAdapter: UIAgentRuntimeModule = {
  type: "hermes_gateway",
  label: "Hermes API Server",
  parseStdoutLine: parseHermesGatewayStdoutLine,
  ConfigFields: HermesGatewayConfigFields,
  buildAdapterConfig: buildHermesGatewayConfig,
};
