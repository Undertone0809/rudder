import type {
  ChatContextLink,
  ChatRuntimeDescriptor,
} from "@rudderhq/shared";
import type { Request, Response } from "express";
import { HttpError } from "../errors.js";
import type { chatAssistantService } from "../services/chat-assistant.js";
import type {
  agentService,
  goalService,
  issueService,
  organizationService,
  projectService,
} from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

type DraftPreflightInput = {
  preferredAgentId?: string | null;
  modelOverride?: string | null;
  effortOverride?: string | null;
  planMode?: boolean;
  contextLinks?: ChatContextLink[];
};

type DraftPreflightServices = {
  organizations: ReturnType<typeof organizationService>;
  issues: ReturnType<typeof issueService>;
  projects: ReturnType<typeof projectService>;
  agents: ReturnType<typeof agentService>;
  goals: ReturnType<typeof goalService>;
  assistant: ReturnType<typeof chatAssistantService>;
};

export function createChatDraftPreflight(services: DraftPreflightServices) {
  const assertContextLinksBelongToCompany = async (
    orgId: string,
    contextLinks: Array<Pick<ChatContextLink, "entityType" | "entityId">>,
  ) => {
    for (const link of contextLinks) {
      if (link.entityType === "issue") {
        const issue = await services.issues.getById(link.entityId);
        if (!issue || issue.orgId !== orgId) {
          throw new HttpError(422, "Issue context must belong to the same organization");
        }
        continue;
      }
      if (link.entityType === "project") {
        const project = await services.projects.getById(link.entityId);
        if (!project || project.orgId !== orgId) {
          throw new HttpError(422, "Project context must belong to the same organization");
        }
        continue;
      }
      if (link.entityType === "goal") {
        const goal = await services.goals.getById(link.entityId);
        if (!goal || goal.orgId !== orgId) {
          throw new HttpError(422, "Goal context must belong to the same organization");
        }
        continue;
      }
      const agent = await services.agents.getById(link.entityId);
      if (!agent || agent.orgId !== orgId) {
        throw new HttpError(422, "Agent context must belong to the same organization");
      }
    }
  };

  const preflightChatDraft = async (
    req: Request,
    res: Response,
    input: DraftPreflightInput,
  ) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const organization = await services.organizations.getById(orgId);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return null;
    }
    const contextLinks = input.contextLinks ?? [];
    await assertContextLinksBelongToCompany(orgId, contextLinks);
    let preferredAgentId = input.preferredAgentId ?? null;
    if (preferredAgentId) {
      const agent = await services.agents.getById(preferredAgentId);
      if (!agent || agent.orgId !== orgId || agent.status === "terminated") {
        res.status(422).json({ error: "Preferred agent must be available in the same organization" });
        return null;
      }
    } else {
      const [defaultAgent] = await services.agents.list(orgId);
      if (!defaultAgent) {
        res.status(422).json({ error: "Chat requires an available agent" });
        return null;
      }
      preferredAgentId = defaultAgent.id;
    }
    const availability: ChatRuntimeDescriptor =
      await services.assistant.getDraftChatAssistantAvailability({
        orgId,
        preferredAgentId,
        modelOverride: input.modelOverride ?? null,
        effortOverride: input.effortOverride ?? null,
        contextLinks,
        planMode: input.planMode ?? false,
      });
    return {
      orgId,
      organization,
      contextLinks,
      preferredAgentId,
      modelOverride: input.modelOverride ?? null,
      effortOverride: input.effortOverride ?? null,
      availability,
    };
  };

  return { assertContextLinksBelongToCompany, preflightChatDraft };
}
