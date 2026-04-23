import type { CLIAgentRuntimeModule } from "@rudder/agent-runtime-utils";
import { printClaudeStreamEvent } from "@rudder/agent-runtime-claude-local/cli";
import { printCodexStreamEvent } from "@rudder/agent-runtime-codex-local/cli";
import { printCursorStreamEvent } from "@rudder/agent-runtime-cursor-local/cli";
import { printGeminiStreamEvent } from "@rudder/agent-runtime-gemini-local/cli";
import { printOpenCodeStreamEvent } from "@rudder/agent-runtime-opencode-local/cli";
import { printPiStreamEvent } from "@rudder/agent-runtime-pi-local/cli";
import { printOpenClawGatewayStreamEvent } from "@rudder/agent-runtime-openclaw-gateway/cli";
import { processCLIAdapter } from "./process/index.js";
import { httpCLIAdapter } from "./http/index.js";

const claudeLocalCLIAdapter: CLIAgentRuntimeModule = {
  type: "claude_local",
  formatStdoutEvent: printClaudeStreamEvent,
};

const codexLocalCLIAdapter: CLIAgentRuntimeModule = {
  type: "codex_local",
  formatStdoutEvent: printCodexStreamEvent,
};

const openCodeLocalCLIAdapter: CLIAgentRuntimeModule = {
  type: "opencode_local",
  formatStdoutEvent: printOpenCodeStreamEvent,
};

const piLocalCLIAdapter: CLIAgentRuntimeModule = {
  type: "pi_local",
  formatStdoutEvent: printPiStreamEvent,
};

const cursorLocalCLIAdapter: CLIAgentRuntimeModule = {
  type: "cursor",
  formatStdoutEvent: printCursorStreamEvent,
};

const geminiLocalCLIAdapter: CLIAgentRuntimeModule = {
  type: "gemini_local",
  formatStdoutEvent: printGeminiStreamEvent,
};

const openclawGatewayCLIAdapter: CLIAgentRuntimeModule = {
  type: "openclaw_gateway",
  formatStdoutEvent: printOpenClawGatewayStreamEvent,
};

const adaptersByType = new Map<string, CLIAgentRuntimeModule>(
  [
    claudeLocalCLIAdapter,
    codexLocalCLIAdapter,
    openCodeLocalCLIAdapter,
    piLocalCLIAdapter,
    cursorLocalCLIAdapter,
    geminiLocalCLIAdapter,
    openclawGatewayCLIAdapter,
    processCLIAdapter,
    httpCLIAdapter,
  ].map((a) => [a.type, a]),
);

export function getCLIAdapter(type: string): CLIAgentRuntimeModule {
  return adaptersByType.get(type) ?? processCLIAdapter;
}
