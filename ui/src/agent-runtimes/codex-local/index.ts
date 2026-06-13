import { buildCodexLocalConfig, parseCodexStdoutLine } from "@rudderhq/agent-runtime-codex-local/ui";
import type { UIAgentRuntimeModule } from "../types";
import { CodexLocalConfigFields } from "./config-fields";

export const codexLocalUIAdapter: UIAgentRuntimeModule = {
  type: "codex_local",
  label: "Codex (local)",
  parseStdoutLine: parseCodexStdoutLine,
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: buildCodexLocalConfig,
};
