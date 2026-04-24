import type { ServerAgentRuntimeModule } from "./types.js";
import { getAgentRuntimeSessionManagement } from "@rudderhq/agent-runtime-utils";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@rudderhq/agent-runtime-claude-local/server";
import { agentConfigurationDoc as claudeAgentConfigurationDoc, models as claudeModels } from "@rudderhq/agent-runtime-claude-local";
import { parseClaudeStdoutLine } from "@rudderhq/agent-runtime-claude-local/ui";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@rudderhq/agent-runtime-codex-local/server";
import { agentConfigurationDoc as codexAgentConfigurationDoc, models as codexModels } from "@rudderhq/agent-runtime-codex-local";
import { parseCodexStdoutLine } from "@rudderhq/agent-runtime-codex-local/ui";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@rudderhq/agent-runtime-cursor-local/server";
import { agentConfigurationDoc as cursorAgentConfigurationDoc, models as cursorModels } from "@rudderhq/agent-runtime-cursor-local";
import { parseCursorStdoutLine } from "@rudderhq/agent-runtime-cursor-local/ui";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@rudderhq/agent-runtime-gemini-local/server";
import { agentConfigurationDoc as geminiAgentConfigurationDoc, models as geminiModels } from "@rudderhq/agent-runtime-gemini-local";
import { parseGeminiStdoutLine } from "@rudderhq/agent-runtime-gemini-local/ui";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@rudderhq/agent-runtime-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
} from "@rudderhq/agent-runtime-opencode-local";
import { parseOpenCodeStdoutLine } from "@rudderhq/agent-runtime-opencode-local/ui";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@rudderhq/agent-runtime-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@rudderhq/agent-runtime-openclaw-gateway";
import { parseOpenClawGatewayStdoutLine } from "@rudderhq/agent-runtime-openclaw-gateway/ui";
import { listCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@rudderhq/agent-runtime-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
} from "@rudderhq/agent-runtime-pi-local";
import { parsePiStdoutLine } from "@rudderhq/agent-runtime-pi-local/ui";
import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

const hermesExecuteCompat: ServerAgentRuntimeModule["execute"] = async (ctx) => {
  return hermesExecute({
    ...ctx,
    agent: {
      ...ctx.agent,
      companyId: ctx.agent.orgId,
    },
  } as any);
};

const hermesTestEnvironmentCompat: ServerAgentRuntimeModule["testEnvironment"] = async (ctx) => {
  const result = await hermesTestEnvironment({
    ...ctx,
    companyId: ctx.orgId,
  } as any);
  return {
    ...result,
    agentRuntimeType:
      typeof (result as { adapterType?: unknown }).adapterType === "string"
        ? (result as { adapterType: string }).adapterType
        : ctx.agentRuntimeType,
  };
};

const claudeLocalAdapter: ServerAgentRuntimeModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  parseStdoutLine: parseClaudeStdoutLine,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAgentRuntimeSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const codexLocalAdapter: ServerAgentRuntimeModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  parseStdoutLine: parseCodexStdoutLine,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAgentRuntimeSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  listModels: listCodexModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const cursorLocalAdapter: ServerAgentRuntimeModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  parseStdoutLine: parseCursorStdoutLine,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAgentRuntimeSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const geminiLocalAdapter: ServerAgentRuntimeModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  parseStdoutLine: parseGeminiStdoutLine,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAgentRuntimeSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAgentRuntimeModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  parseStdoutLine: parseOpenClawGatewayStdoutLine,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAgentRuntimeModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  parseStdoutLine: parseOpenCodeStdoutLine,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  sessionManagement: getAgentRuntimeSessionManagement("opencode_local") ?? undefined,
  models: [],
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAgentRuntimeModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  parseStdoutLine: parsePiStdoutLine,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAgentRuntimeSessionManagement("pi_local") ?? undefined,
  models: [],
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
};

const hermesLocalAdapter: ServerAgentRuntimeModule = {
  type: "hermes_local",
  execute: hermesExecuteCompat,
  testEnvironment: hermesTestEnvironmentCompat,
  sessionCodec: hermesSessionCodec,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
};

const adaptersByType = new Map<string, ServerAgentRuntimeModule>(
  [
    claudeLocalAdapter,
    codexLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    openclawGatewayAdapter,
    hermesLocalAdapter,
    processAdapter,
    httpAdapter,
  ].map((a) => [a.type, a]),
);

export function getServerAdapter(type: string): ServerAgentRuntimeModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    // Fall back to process adapter for unknown types
    return processAdapter;
  }
  return adapter;
}

export async function listAgentRuntimeModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = adaptersByType.get(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export function listServerAdapters(): ServerAgentRuntimeModule[] {
  return Array.from(adaptersByType.values());
}

export function findServerAdapter(type: string): ServerAgentRuntimeModule | null {
  return adaptersByType.get(type) ?? null;
}
