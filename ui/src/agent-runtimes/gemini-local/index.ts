import type { UIAgentRuntimeModule } from "../types";
import { parseGeminiStdoutLine } from "@rudderhq/agent-runtime-gemini-local/ui";
import { GeminiLocalConfigFields } from "./config-fields";
import { buildGeminiLocalConfig } from "@rudderhq/agent-runtime-gemini-local/ui";

export const geminiLocalUIAdapter: UIAgentRuntimeModule = {
  type: "gemini_local",
  label: "Gemini CLI (local)",
  parseStdoutLine: parseGeminiStdoutLine,
  ConfigFields: GeminiLocalConfigFields,
  buildAdapterConfig: buildGeminiLocalConfig,
};
