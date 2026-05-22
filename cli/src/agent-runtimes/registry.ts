import type { CLIAgentRuntimeModule } from "@rudderhq/agent-runtime-utils";
import { processCLIAdapter } from "./process/index.js";
import { httpCLIAdapter } from "./http/index.js";

const localRuntimeTypes = [
  "claude_local",
  "codex_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "gemini_local",
  "openclaw_gateway",
];

const adaptersByType = new Map<string, CLIAgentRuntimeModule>([
  [processCLIAdapter.type, processCLIAdapter],
  [httpCLIAdapter.type, httpCLIAdapter],
  ...localRuntimeTypes.map((type): [string, CLIAgentRuntimeModule] => [
    type,
    { ...processCLIAdapter, type },
  ]),
]);

export function getCLIAdapter(type: string): CLIAgentRuntimeModule {
  return adaptersByType.get(type) ?? processCLIAdapter;
}
