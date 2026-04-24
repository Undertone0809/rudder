import type { UIAgentRuntimeModule } from "../types";
import { parseOpenClawGatewayStdoutLine } from "@rudderhq/agent-runtime-openclaw-gateway/ui";
import { buildOpenClawGatewayConfig } from "@rudderhq/agent-runtime-openclaw-gateway/ui";
import { OpenClawGatewayConfigFields } from "./config-fields";

export const openClawGatewayUIAdapter: UIAgentRuntimeModule = {
  type: "openclaw_gateway",
  label: "OpenClaw Gateway",
  parseStdoutLine: parseOpenClawGatewayStdoutLine,
  ConfigFields: OpenClawGatewayConfigFields,
  buildAdapterConfig: buildOpenClawGatewayConfig,
};
