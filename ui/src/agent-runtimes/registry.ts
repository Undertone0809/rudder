import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { cursorLocalUIAdapter } from "./cursor";
import { geminiLocalUIAdapter } from "./gemini-local";
import { httpUIAdapter } from "./http";
import { openClawGatewayUIAdapter } from "./openclaw-gateway";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { piLocalUIAdapter } from "./pi-local";
import { processUIAdapter } from "./process";
import type { UIAgentRuntimeModule } from "./types";

const uiAdapters: UIAgentRuntimeModule[] = [
  claudeLocalUIAdapter,
  codexLocalUIAdapter,
  geminiLocalUIAdapter,
  openCodeLocalUIAdapter,
  piLocalUIAdapter,
  cursorLocalUIAdapter,
  openClawGatewayUIAdapter,
  processUIAdapter,
  httpUIAdapter,
];

const adaptersByType = new Map<string, UIAgentRuntimeModule>(
  uiAdapters.map((a) => [a.type, a]),
);

export function getUIAdapter(type: string): UIAgentRuntimeModule {
  return adaptersByType.get(type) ?? processUIAdapter;
}

export function listUIAdapters(): UIAgentRuntimeModule[] {
  return [...uiAdapters];
}
