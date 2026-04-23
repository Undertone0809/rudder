import type { UIAgentRuntimeModule } from "../types";
import { parseGeminiStdoutLine } from "@rudder/agent-runtime-gemini-local/ui";
import { GeminiLocalConfigFields } from "./config-fields";
import { buildGeminiLocalConfig } from "@rudder/agent-runtime-gemini-local/ui";

export const geminiLocalUIAdapter: UIAgentRuntimeModule = {
  type: "gemini_local",
  label: "Gemini CLI (local)",
  parseStdoutLine: parseGeminiStdoutLine,
  ConfigFields: GeminiLocalConfigFields,
  buildAdapterConfig: buildGeminiLocalConfig,
};
