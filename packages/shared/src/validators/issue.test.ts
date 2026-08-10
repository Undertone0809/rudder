import { describe, expect, it } from "vitest";
import { addIssueCommentSchema } from "./issue.js";

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
});
