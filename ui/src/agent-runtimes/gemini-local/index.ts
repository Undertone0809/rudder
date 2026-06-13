import { buildGeminiLocalConfig, parseGeminiStdoutLine } from "@rudderhq/agent-runtime-gemini-local/ui";
import type { UIAgentRuntimeModule } from "../types";
import { GeminiLocalConfigFields } from "./config-fields";

export const geminiLocalUIAdapter: UIAgentRuntimeModule = {
  type: "gemini_local",
  label: "Gemini CLI (local)",
  parseStdoutLine: parseGeminiStdoutLine,
  ConfigFields: GeminiLocalConfigFields,
  buildAdapterConfig: buildGeminiLocalConfig,
};
