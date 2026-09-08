import { describe, expect, it } from "vitest";
import {
  addIssueCommentSchema,
  checkoutIssueSchema,
  createIssueSchema,
  reorderIssueSchema,
} from "./issue.js";

describe("addIssueCommentSchema", () => {
  it("accepts fenced Issue Steer and rejects an invalid run identity", () => {
    expect(addIssueCommentSchema.safeParse({
      body: "Continue with this correction.",
      steer: { expectedRunId: "55555555-5555-4555-8555-555555555555" },
    }).success).toBe(true);

    expect(addIssueCommentSchema.safeParse({
      body: "Do not target an ambiguous run.",
      steer: { expectedRunId: "latest" },
    }).success).toBe(false);
  });

  it("accepts typed short references across Issue creation, reorder, and checkout", () => {
    expect(createIssueSchema.safeParse({
      title: "Short reference issue",
      projectId: "prj_11111111",
      goalId: "gol_22222222",
      parentId: "iss_33333333",
      assigneeAgentId: "agt_44444444",
      reviewerAgentId: "agt_55555555",
    }).success).toBe(true);

    expect(reorderIssueSchema.safeParse({
      issueId: "iss_33333333",
      targetStatus: "todo",
      previousIssueId: "iss_44444444",
      nextIssueId: null,
    }).success).toBe(true);

    expect(checkoutIssueSchema.safeParse({
      agentId: "agt_44444444",
      expectedStatuses: ["backlog", "todo"],
    }).success).toBe(true);
  });
});
