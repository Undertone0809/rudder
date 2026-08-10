import { describe, expect, it } from "vitest";
import {
  AGENT_ISSUE_CREATION_REQUEST_STATUSES,
} from "../constants.js";
import {
  agentIssueCreationRequestStatusSchema,
  createAgentIssueCreationRequestSchema,
} from "./agent-issue-creation.js";

const baseRequest = {
  agentId: "11111111-1111-4111-8111-111111111111",
  instruction: " Create an issue describing the onboarding regression. ",
  projectId: "22222222-2222-4222-8222-222222222222",
  goalId: null,
  parentId: "33333333-3333-4333-8333-333333333333",
  contextSnapshot: { source: "new-issue-dialog", readOnly: true },
  idempotencyKey: " new-issue-request-1 ",
};

describe("Agent Issue Creation validators", () => {
  it("accepts a valid request and normalizes user-entered text", () => {
    const parsed = createAgentIssueCreationRequestSchema.safeParse(baseRequest);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.instruction).toBe("Create an issue describing the onboarding regression.");
      expect(parsed.data.idempotencyKey).toBe("new-issue-request-1");
      expect(parsed.data.contextSnapshot).toEqual({ source: "new-issue-dialog", readOnly: true });
    }
  });

  it("allows absent or null optional context references", () => {
    const parsed = createAgentIssueCreationRequestSchema.safeParse({
      agentId: baseRequest.agentId,
      instruction: "Create the issue.",
      idempotencyKey: "request-2",
      projectId: null,
      goalId: null,
      parentId: undefined,
      contextSnapshot: null,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects blank text, invalid UUIDs, and oversized instructions", () => {
    expect(createAgentIssueCreationRequestSchema.safeParse({
      ...baseRequest,
      instruction: "   ",
    }).success).toBe(false);
    expect(createAgentIssueCreationRequestSchema.safeParse({
      ...baseRequest,
      agentId: "not-a-uuid",
    }).success).toBe(false);
    expect(createAgentIssueCreationRequestSchema.safeParse({
      ...baseRequest,
      projectId: "not-a-uuid",
    }).success).toBe(false);
    expect(createAgentIssueCreationRequestSchema.safeParse({
      ...baseRequest,
      instruction: "x".repeat(20_001),
    }).success).toBe(false);
    expect(createAgentIssueCreationRequestSchema.safeParse({
      ...baseRequest,
      idempotencyKey: "   ",
    }).success).toBe(false);
  });

  it("accepts every persisted lifecycle status and rejects unknown values", () => {
    for (const status of AGENT_ISSUE_CREATION_REQUEST_STATUSES) {
      expect(agentIssueCreationRequestStatusSchema.safeParse(status).success).toBe(true);
    }

    expect(agentIssueCreationRequestStatusSchema.safeParse("pending").success).toBe(false);
  });
});
