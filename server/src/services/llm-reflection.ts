import type { Db } from "@rudderhq/db";
import { AGENT_ICON_NAMES } from "@rudderhq/shared";
import type { Request } from "express";
import { listServerAdapters } from "../agent-runtimes/index.js";
import { forbidden } from "../errors.js";
import { agentService } from "./agents.js";

export const LLM_REFLECTION_ACTION = "llm.reflection.read";
export const LLM_REFLECTION_INSTANCE_SCOPE = "instance";

export type LlmReflectionAdapter = {
  type: string;
  agentConfigurationDoc: string | null;
};

export type LlmReflectionSnapshot = {
  adapters: LlmReflectionAdapter[];
  iconNames: string[];
};

export type LlmReflectionDocument =
  | { kind: "index" }
  | { kind: "icons" }
  | { kind: "adapter"; adapterType: string };

export function llmReflectionSnapshot(document: LlmReflectionDocument): LlmReflectionSnapshot {
  if (document.kind === "icons") return { adapters: [], iconNames: [...AGENT_ICON_NAMES] };
  const adapters = listServerAdapters()
    .filter((adapter) => document.kind === "index" || adapter.type === document.adapterType)
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((adapter) => ({
      type: adapter.type,
      // Index rendering needs only the name; private transport stays small.
      agentConfigurationDoc: document.kind === "index" ? null : adapter.agentConfigurationDoc ?? null,
    }));
  return { adapters, iconNames: [] };
}

export function renderLlmReflectionDocument(
  document: LlmReflectionDocument,
  snapshot = llmReflectionSnapshot(document),
) {
  if (document.kind === "index") {
    const lines = [
      "# Rudder Agent Configuration Index",
      "",
      "Installed adapters:",
      ...snapshot.adapters.map((adapter) => `- ${adapter.type}: /llms/agent-configuration/${adapter.type}.txt`),
      "",
      "Related API endpoints:",
      "- GET /api/orgs/:orgId/agent-configurations",
      "- GET /api/agents/:id/configuration",
      "- POST /api/orgs/:orgId/agent-hires",
      "",
      "Agent identity references:",
      "- GET /llms/agent-icons.txt (legacy named icons for compatibility/debugging)",
      "",
      "Notes:",
      "- Sensitive values are redacted in configuration read APIs.",
      "- New hires may be created in pending_approval state depending on organization settings.",
      "- Omit `icon` for normal hires and creates; Rudder generates an Oreo avatar.",
      "",
    ];
    return { status: 200, body: lines.join("\n") };
  }

  if (document.kind === "icons") {
    const lines = [
      "# Rudder Legacy Agent Icon Names",
      "",
      "Do not set `icon` on normal hire/create payloads. Rudder generates an Oreo avatar automatically.",
      "",
      "Only set `icon` when preserving an explicit `oreo:<shape>:<palette>:<uuid>`, DiceBear Notionists, or uploaded `asset:<uuid>` avatar reference supplied by the board/UI.",
      "",
      "The following named icons remain accepted only for legacy compatibility and debugging:",
      ...snapshot.iconNames.map((name) => `- ${name}`),
      "",
      "Normal hire example:",
      '{ "name": "SearchOps", "role": "researcher" }',
      "",
    ];
    return { status: 200, body: lines.join("\n") };
  }

  const adapter = snapshot.adapters.find((entry) => entry.type === document.adapterType);
  if (!adapter) {
    return { status: 404, body: `Unknown adapter type: ${document.adapterType}` };
  }
  return {
    status: 200,
    body: adapter.agentConfigurationDoc
      ?? `# ${document.adapterType} agent configuration\n\nNo adapter-specific documentation registered.`,
  };
}

export function createLlmReflectionAuthorizer(db: Db) {
  const agentsSvc = agentService(db);

  return async function assertCanReadLlmReflection(req: Request) {
    if (req.actor.type === "board") return;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Board or permitted agent authentication required");
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || !actorAgent.permissions || typeof actorAgent.permissions !== "object") {
      throw forbidden("Missing permission to read agent configuration reflection");
    }
    if (!Boolean((actorAgent.permissions as Record<string, unknown>).canCreateAgents)) {
      throw forbidden("Missing permission to read agent configuration reflection");
    }
  };
}
