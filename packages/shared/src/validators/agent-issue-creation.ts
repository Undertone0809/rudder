import { z } from "zod";
import { AGENT_ISSUE_CREATION_REQUEST_STATUSES } from "../constants.js";
import { organizationEntityReferenceSchema } from "./reference.js";

export const agentIssueCreationRequestStatusSchema = z.enum(AGENT_ISSUE_CREATION_REQUEST_STATUSES);

export const createAgentIssueCreationRequestSchema = z.object({
  agentId: organizationEntityReferenceSchema("agent", "Agent ID"),
  instruction: z.string().trim().min(1).max(20_000),
  projectId: organizationEntityReferenceSchema("project", "Project ID").optional().nullable(),
  goalId: organizationEntityReferenceSchema("goal", "Goal ID").optional().nullable(),
  parentId: organizationEntityReferenceSchema("issue", "Parent issue ID").optional().nullable(),
  contextSnapshot: z.record(z.unknown()).optional().nullable(),
  idempotencyKey: z.string().trim().min(1).max(255),
});

export type CreateAgentIssueCreationRequest = z.infer<typeof createAgentIssueCreationRequestSchema>;
