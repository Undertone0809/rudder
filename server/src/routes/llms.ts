import type { Db } from "@rudderhq/db";
import { AGENT_ICON_NAMES } from "@rudderhq/shared";
import { Router, type Request } from "express";
import { listServerAdapters } from "../agent-runtimes/index.js";
import { forbidden } from "../errors.js";
import { agentService } from "../services/agents.js";

function hasCreatePermission(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
}

export function llmRoutes(db: Db) {
  const router = Router();
  const agentsSvc = agentService(db);

  async function assertCanRead(req: Request) {
    if (req.actor.type === "board") return;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Board or permitted agent authentication required");
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || !hasCreatePermission(actorAgent)) {
      throw forbidden("Missing permission to read agent configuration reflection");
    }
  }

  router.get("/llms/agent-configuration.txt", async (req, res) => {
    await assertCanRead(req);
    const adapters = listServerAdapters().sort((a, b) => a.type.localeCompare(b.type));
    const lines = [
      "# Rudder Agent Configuration Index",
      "",
      "Installed adapters:",
      ...adapters.map((adapter) => `- ${adapter.type}: /llms/agent-configuration/${adapter.type}.txt`),
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
      "- Omit `icon` for normal hires and creates; Rudder generates a DiceBear Notionists avatar.",
      "",
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

  router.get("/llms/agent-icons.txt", async (req, res) => {
    await assertCanRead(req);
    const lines = [
      "# Rudder Legacy Agent Icon Names",
      "",
      "Do not set `icon` on normal hire/create payloads. Rudder generates a DiceBear Notionists avatar automatically.",
      "",
      "Only set `icon` when preserving an explicit DiceBear Notionists reference or an uploaded `asset:<uuid>` avatar reference supplied by the board/UI.",
      "",
      "The following named icons remain accepted only for legacy compatibility and debugging:",
      ...AGENT_ICON_NAMES.map((name) => `- ${name}`),
      "",
      "Normal hire example:",
      '{ "name": "SearchOps", "role": "researcher" }',
      "",
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

  router.get("/llms/agent-configuration/:agentRuntimeType.txt", async (req, res) => {
    await assertCanRead(req);
    const agentRuntimeType = req.params.agentRuntimeType as string;
    const adapter = listServerAdapters().find((entry) => entry.type === agentRuntimeType);
    if (!adapter) {
      res.status(404).type("text/plain").send(`Unknown adapter type: ${agentRuntimeType}`);
      return;
    }
    res
      .type("text/plain")
      .send(
        adapter.agentConfigurationDoc ??
          `# ${agentRuntimeType} agent configuration\n\nNo adapter-specific documentation registered.`,
      );
  });

  return router;
}
