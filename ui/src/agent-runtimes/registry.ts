import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { cursorLocalUIAdapter } from "./cursor";
import { hermesGatewayUIAdapter } from "./hermes-gateway";
import { httpUIAdapter } from "./http";
import { openClawGatewayUIAdapter } from "./openclaw-gateway";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { piLocalUIAdapter } from "./pi-local";
import { processUIAdapter } from "./process";
import { parseRemovedGeminiLocalHistoryLine } from "@rudderhq/agent-runtime-utils/gemini-cli-history";
import type { UIAgentRuntimeModule } from "./types";

const uiAdapters: UIAgentRuntimeModule[] = [
  claudeLocalUIAdapter,
  codexLocalUIAdapter,
  openCodeLocalUIAdapter,
  piLocalUIAdapter,
  cursorLocalUIAdapter,
  openClawGatewayUIAdapter,
  hermesGatewayUIAdapter,
  processUIAdapter,
  httpUIAdapter,
];

const adaptersByType = new Map<string, UIAgentRuntimeModule>(
  uiAdapters.map((a) => [a.type, a]),
);

const removedGeminiLocalUIAdapter: UIAgentRuntimeModule = {
  type: "gemini_local",
  label: "Gemini CLI (removed)",
  parseStdoutLine: parseRemovedGeminiLocalHistoryLine,
  ConfigFields: () => null,
  buildAdapterConfig: () => ({}),
};

export function getUIAdapter(type: string): UIAgentRuntimeModule {
  if (type === removedGeminiLocalUIAdapter.type) return removedGeminiLocalUIAdapter;
  return adaptersByType.get(type) ?? processUIAdapter;
}

export function listUIAdapters(): UIAgentRuntimeModule[] {
  return [...uiAdapters];
}
