import type { UIAgentRuntimeModule } from "../types";
import { parseClaudeStdoutLine } from "@rudderhq/agent-runtime-claude-local/ui";
import { ClaudeLocalConfigFields } from "./config-fields";
import { buildClaudeLocalConfig } from "@rudderhq/agent-runtime-claude-local/ui";

export const claudeLocalUIAdapter: UIAgentRuntimeModule = {
  type: "claude_local",
  label: "Claude Code (local)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeLocalConfigFields,
  buildAdapterConfig: buildClaudeLocalConfig,
};
