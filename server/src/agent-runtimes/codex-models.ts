import { models as codexFallbackModels } from "@rudderhq/agent-runtime-codex-local";
import type { AgentRuntimeModel } from "./types.js";

export async function listCodexModels(): Promise<AgentRuntimeModel[]> {
  return codexFallbackModels;
}

export function resetCodexModelsCacheForTests() {
  // Kept for tests that reset all dynamic adapter discovery caches.
}
