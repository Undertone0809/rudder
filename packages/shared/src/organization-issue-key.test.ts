import { describe, expect, it } from "vitest";
import {
  deriveOrganizationIssueKey,
  normalizeOrganizationIssueKey,
} from "./organization-issue-key.js";

describe("organization issue keys", () => {
  it("preserves digits in short organization names", () => {
    expect(deriveOrganizationIssueKey("R6")).toBe("R6");
    expect(deriveOrganizationIssueKey("GPT-4 Team")).toBe("GPT");
  });

  it("normalizes valid explicit keys and rejects invalid ones", () => {
    expect(normalizeOrganizationIssueKey(" r6 ")).toBe("R6");
    expect(normalizeOrganizationIssueKey("6R")).toBeNull();
    expect(normalizeOrganizationIssueKey("R-6")).toBeNull();
  });
});
