import { describe, expect, it } from "vitest";
import { getIssueScopeFilters } from "./issue-scope-filters";

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
