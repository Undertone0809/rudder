import { agentConfigurationDoc as claudeAgentConfigurationDoc, models as claudeModels } from "@rudderhq/agent-runtime-claude-local";
import {
  execute as claudeExecute,
  getQuotaWindows as claudeGetQuotaWindows,
  sessionCodec as claudeSessionCodec,
  testEnvironment as claudeTestEnvironment,
  listClaudeSkills,
  syncClaudeSkills,
} from "@rudderhq/agent-runtime-claude-local/server";
import { parseClaudeStdoutLine } from "@rudderhq/agent-runtime-claude-local/ui";
import { agentConfigurationDoc as codexAgentConfigurationDoc, models as codexModels } from "@rudderhq/agent-runtime-codex-local";
import {
  execute as codexExecute,
  getQuotaWindows as codexGetQuotaWindows,
  sessionCodec as codexSessionCodec,
  testEnvironment as codexTestEnvironment,
  listCodexSkills,
  syncCodexSkills,
} from "@rudderhq/agent-runtime-codex-local/server";
import { parseCodexStdoutLine } from "@rudderhq/agent-runtime-codex-local/ui";
import { agentConfigurationDoc as cursorAgentConfigurationDoc, models as cursorModels } from "@rudderhq/agent-runtime-cursor-local";
import {
  execute as cursorExecute,
  sessionCodec as cursorSessionCodec,
  testEnvironment as cursorTestEnvironment,
  listCursorSkills,
  syncCursorSkills,
} from "@rudderhq/agent-runtime-cursor-local/server";
import { parseCursorStdoutLine } from "@rudderhq/agent-runtime-cursor-local/ui";
import { agentConfigurationDoc as geminiAgentConfigurationDoc, models as geminiModels } from "@rudderhq/agent-runtime-gemini-local";
import {
  execute as geminiExecute,
  sessionCodec as geminiSessionCodec,
  testEnvironment as geminiTestEnvironment,
  listGeminiSkills,
  syncGeminiSkills,
} from "@rudderhq/agent-runtime-gemini-local/server";
import { parseGeminiStdoutLine } from "@rudderhq/agent-runtime-gemini-local/ui";
import {
  agentConfigurationDoc as hermesGatewayAgentConfigurationDoc,
  models as hermesGatewayModels,
} from "@rudderhq/agent-runtime-hermes-gateway";
import {
  execute as hermesGatewayExecute,
  testEnvironment as hermesGatewayTestEnvironment,
} from "@rudderhq/agent-runtime-hermes-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@rudderhq/agent-runtime-openclaw-gateway";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@rudderhq/agent-runtime-openclaw-gateway/server";
import { parseOpenClawGatewayStdoutLine } from "@rudderhq/agent-runtime-openclaw-gateway/ui";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
} from "@rudderhq/agent-runtime-opencode-local";
import {
  discoverOpenCodeModelsCached,
  listOpenCodeModels,
  listOpenCodeSkills,
  execute as openCodeExecute,
  sessionCodec as openCodeSessionCodec,
  testEnvironment as openCodeTestEnvironment,
  syncOpenCodeSkills,
} from "@rudderhq/agent-runtime-opencode-local/server";
import { parseOpenCodeStdoutLine } from "@rudderhq/agent-runtime-opencode-local/ui";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
  models as piModels,
} from "@rudderhq/agent-runtime-pi-local";
import {
  discoverPiModelsCached,
  listPiModels,
  listPiSkills,
  execute as piExecute,
  sessionCodec as piSessionCodec,
  testEnvironment as piTestEnvironment,
  syncPiSkills,
} from "@rudderhq/agent-runtime-pi-local/server";
import { parsePiStdoutLine } from "@rudderhq/agent-runtime-pi-local/ui";
import { getAgentRuntimeSessionManagement, type AgentRuntimeModel } from "@rudderhq/agent-runtime-utils";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import {
  execute as hermesExecute,
  sessionCodec as hermesSessionCodec,
  testEnvironment as hermesTestEnvironment,
} from "hermes-paperclip-adapter/server";
import { listCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import { httpAdapter } from "./http/index.js";
import { processAdapter } from "./process/index.js";
import type { ServerAgentRuntimeModule } from "./types.js";

const hermesExecuteCompat: ServerAgentRuntimeModule["execute"] = async (ctx) => {
  const chatPrompt = ctx.context.chatMode === true && typeof ctx.context.chatPrompt === "string"
    ? ctx.context.chatPrompt
    : null;
  const compatConfig = chatPrompt === null
    ? ctx.config
    : { ...ctx.config, promptTemplate: chatPrompt };
  const result = await hermesExecute({
    ...ctx,
    config: compatConfig,
    agent: {
      ...ctx.agent,
      companyId: ctx.agent.orgId,
      adapterConfig: compatConfig,
    },
  } as any);
  if (chatPrompt === null) return result as Awaited<ReturnType<ServerAgentRuntimeModule["execute"]>>;
  const resultJson = result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
    ? result.resultJson as Record<string, unknown>
    : null;
  const fullResult = typeof resultJson?.result === "string" && resultJson.result.trim().length > 0
    ? resultJson.result.trim()
    : null;
  return {
    ...result,
    ...(fullResult ? { summary: fullResult } : {}),
  } as Awaited<ReturnType<ServerAgentRuntimeModule["execute"]>>;
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

const hermesGatewayAdapter: ServerAgentRuntimeModule = {
  type: "hermes_gateway",
  execute: hermesGatewayExecute,
  testEnvironment: hermesGatewayTestEnvironment,
  models: hermesGatewayModels,
  supportsLocalAgentJwt: false,
  agentConfigurationDoc: hermesGatewayAgentConfigurationDoc,
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
  models: piModels,
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
    hermesGatewayAdapter,
    hermesLocalAdapter,
    processAdapter,
    httpAdapter,
  ].map((a) => [a.type, a]),
);

function mergeRuntimeModels(
  ...modelLists: Array<readonly AgentRuntimeModel[] | null | undefined>
): AgentRuntimeModel[] {
  const seen = new Set<string>();
  const merged: AgentRuntimeModel[] = [];
  for (const model of modelLists.flatMap((models) => models ?? [])) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const variants = Array.isArray(model.variants)
      ? [...new Set(model.variants.filter((variant): variant is string => typeof variant === "string" && variant.trim().length > 0))]
      : undefined;
    const reasoning = model.capabilities?.reasoning;
    merged.push({
      id,
      label: model.label.trim() || id,
      ...(variants ? { variants } : {}),
      ...(typeof reasoning === "boolean" ? { capabilities: { reasoning } } : {}),
    });
  }
  return merged;
}

export function getServerAdapter(type: string): ServerAgentRuntimeModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    // Fall back to process adapter for unknown types
    return processAdapter;
  }
  return adapter;
}

export async function listAgentRuntimeModels(type: string): Promise<AgentRuntimeModel[]> {
  const adapter = adaptersByType.get(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (type === "pi_local") {
      return mergeRuntimeModels(discovered, adapter.models);
    }
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

/**
 * Return only runtime discovery evidence for chat effort validation.
 *
 * UI model lists may use bundled fallback models when a local CLI is missing,
 * but those fallbacks are not authoritative per-model capability evidence.
 * Treat an unavailable or empty discovery as unknown so chat hydration keeps a
 * saved effort instead of silently rewriting it away.
 */
export async function discoverAgentRuntimeModels(type: string): Promise<AgentRuntimeModel[] | undefined> {
  if (type === "opencode_local") {
    try {
      const models = await discoverOpenCodeModelsCached();
      return models.length > 0 ? models : undefined;
    } catch {
      return undefined;
    }
  }
  if (type === "pi_local") {
    try {
      const models = await discoverPiModelsCached();
      return models.length > 0 ? models : undefined;
    } catch {
      return undefined;
    }
  }
  return listAgentRuntimeModels(type);
}

export function listServerAdapters(): ServerAgentRuntimeModule[] {
  return Array.from(adaptersByType.values());
}

export function findServerAdapter(type: string): ServerAgentRuntimeModule | null {
  return adaptersByType.get(type) ?? null;
}
