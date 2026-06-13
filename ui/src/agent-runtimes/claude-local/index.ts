import { buildClaudeLocalConfig, parseClaudeStdoutLine } from "@rudderhq/agent-runtime-claude-local/ui";
import type { UIAgentRuntimeModule } from "../types";
import { ClaudeLocalConfigFields } from "./config-fields";

export const claudeLocalUIAdapter: UIAgentRuntimeModule = {
  type: "claude_local",
  label: "Claude Code (local)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeLocalConfigFields,
  buildAdapterConfig: buildClaudeLocalConfig,
};
