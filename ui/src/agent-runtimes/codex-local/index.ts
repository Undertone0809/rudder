import type { UIAgentRuntimeModule } from "../types";
import { parseCodexStdoutLine } from "@rudderhq/agent-runtime-codex-local/ui";
import { CodexLocalConfigFields } from "./config-fields";
import { buildCodexLocalConfig } from "@rudderhq/agent-runtime-codex-local/ui";

export const codexLocalUIAdapter: UIAgentRuntimeModule = {
  type: "codex_local",
  label: "Codex (local)",
  parseStdoutLine: parseCodexStdoutLine,
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: buildCodexLocalConfig,
};
