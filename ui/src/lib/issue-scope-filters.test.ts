import { describe, expect, it } from "vitest";
import { getIssueScopeFilters, isFollowingIssue } from "./issue-scope-filters";

describe("getIssueScopeFilters", () => {
  it("maps assigned scope to the current user's assignee filter", () => {
    expect(getIssueScopeFilters("assigned", "user-123")).toEqual({
      assigneeUserId: "me",
    });
  });

  it("does not apply assigned filtering without a current user", () => {
    expect(getIssueScopeFilters("assigned", null)).toEqual({});
  });

  it("leaves other scopes unchanged", () => {
    expect(getIssueScopeFilters("recent", "user-123")).toEqual({});
    expect(getIssueScopeFilters("", "user-123")).toEqual({});
  });
});


describe("isFollowingIssue", () => {
  it("returns true when the current user created the issue", () => {
    expect(isFollowingIssue({ createdByUserId: "user-123", assigneeUserId: null }, "user-123")).toBe(true);
  });

  it("returns true when the current user is assigned the issue", () => {
    expect(isFollowingIssue({ createdByUserId: null, assigneeUserId: "user-123" }, "user-123")).toBe(true);
  });

  it("returns false for unrelated issues or missing user context", () => {
    expect(isFollowingIssue({ createdByUserId: "user-456", assigneeUserId: "user-789" }, "user-123")).toBe(false);
    expect(isFollowingIssue({ createdByUserId: "user-123", assigneeUserId: null }, null)).toBe(false);
  });
});
