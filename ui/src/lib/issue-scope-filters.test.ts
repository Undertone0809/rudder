import { describe, expect, it } from "vitest";
import { getIssueScopeFilters } from "./issue-scope-filters";

describe("getIssueScopeFilters", () => {
  it("maps assigned scope to the current user's assignee filter", () => {
    expect(getIssueScopeFilters("assigned", "user-123")).toEqual({
      assigneeUserId: "me",
      includeAutomationExecutions: true,
    });
  });

  it("does not apply assigned filtering without a current user", () => {
    expect(getIssueScopeFilters("assigned", null)).toEqual({
      includeAutomationExecutions: true,
    });
  });

  it("maps reviewing scope to the current user's reviewer filter", () => {
    expect(getIssueScopeFilters("reviewing", "user-123")).toEqual({
      includeAutomationExecutions: true,
      reviewerUserId: "me",
    });
  });

  it("maps pinned scope to the server-side follow filter", () => {
    expect(getIssueScopeFilters("pinned", "user-123")).toEqual({
      followedByUserId: "me",
      includeAutomationExecutions: true,
    });
  });

  it("maps following scope to the server-side involvement filter", () => {
    expect(getIssueScopeFilters("following", "user-123")).toEqual({
      includeAutomationExecutions: true,
      involvedUserId: "me",
    });
  });

  it("includes automation execution issues for ordinary board scopes", () => {
    expect(getIssueScopeFilters("recent", "user-123")).toEqual({
      includeAutomationExecutions: true,
    });
    expect(getIssueScopeFilters("", "user-123")).toEqual({
      includeAutomationExecutions: true,
    });
  });
});
