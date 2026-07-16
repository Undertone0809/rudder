import { describe, expect, it } from "vitest";
import {
  buildIssueTitlePrompt,
  ISSUE_TITLE_REGENERATION_COMMENT_LIMIT,
} from "../services/issue-title-generation.js";

describe("issue title generation", () => {
  it("builds a bounded prompt from the issue and prioritizes newest comments", () => {
    const comments = Array.from(
      { length: ISSUE_TITLE_REGENERATION_COMMENT_LIMIT + 2 },
      (_, index) => ({ body: `newest-comment-${index}` }),
    );

    const prompt = buildIssueTitlePrompt(
      {
        title: "Old release title",
        description: "Coordinate the release proof and rollback plan.",
      },
      comments,
    );

    expect(prompt).toContain("Generate a concise title for this issue");
    expect(prompt).toContain("Current title: Old release title");
    expect(prompt).toContain("Description: Coordinate the release proof and rollback plan");
    expect(prompt).toContain("newest-comment-0");
    expect(prompt).toContain("newest-comment-11");
    expect(prompt).not.toContain("newest-comment-12");
    expect(prompt.indexOf("newest-comment-0")).toBeLessThan(prompt.indexOf("newest-comment-11"));
  });

  it("preserves the newest comment when a long description is truncated", () => {
    const prompt = buildIssueTitlePrompt(
      { title: "Old title", description: "x".repeat(3_000) },
      [{ body: "newest-comment-sentinel" }],
    );

    expect(prompt).toContain("[Input truncated for title generation.]");
    expect(prompt).toContain("newest-comment-sentinel");
    expect(prompt).not.toContain("x".repeat(2_000));
  });
});
