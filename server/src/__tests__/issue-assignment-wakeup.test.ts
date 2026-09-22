import { describe, expect, it } from "vitest";
import { isIssueAssignmentWakeupStatus } from "../services/issue-assignment-wakeup.js";

describe("isIssueAssignmentWakeupStatus", () => {
  it.each(["todo", "in_progress", "blocked"])(
    "preserves assignment wakeups for %s issues",
    (status) => {
      expect(isIssueAssignmentWakeupStatus(status)).toBe(true);
    },
  );

  it.each(["backlog", "in_review", "done", "cancelled"])("suppresses assignment wakeups for %s issues", (status) => {
    expect(isIssueAssignmentWakeupStatus(status)).toBe(false);
  });
});
