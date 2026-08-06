import { z } from "zod";
import { AGENT_ISSUE_CREATION_REQUEST_STATUSES } from "../constants.js";

export const agentIssueCreationRequestStatusSchema = z.enum(AGENT_ISSUE_CREATION_REQUEST_STATUSES);

export const createAgentIssueCreationRequestSchema = z.object({
  agentId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(20_000),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  contextSnapshot: z.record(z.unknown()).optional().nullable(),
  idempotencyKey: z.string().trim().min(1).max(255),
});

export type CreateAgentIssueCreationRequest = z.infer<typeof createAgentIssueCreationRequestSchema>;
