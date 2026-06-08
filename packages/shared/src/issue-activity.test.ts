import { describe, expect, it } from "vitest";
import {
  hasMaterialIssueUpdateFields,
  isLowSignalIssueContentOnlyUpdate,
  issueUpdatedChangedKeys,
} from "./issue-activity.js";

describe("issue activity helpers", () => {
  it("treats title and description-only issue updates as low signal", () => {
    const details = {
      title: "Renamed",
      description: "Edited",
      identifier: "RUD-1",
      _previous: { title: "Old", description: "Original" },
    };

    expect(issueUpdatedChangedKeys(details)).toEqual(["title", "description"]);
    expect(hasMaterialIssueUpdateFields(details)).toBe(false);
    expect(isLowSignalIssueContentOnlyUpdate("issue.updated", details)).toBe(true);
  });

  it("keeps mixed content and workflow updates material", () => {
    const details = {
      title: "Renamed",
      status: "in_progress",
      _previous: { title: "Old", status: "todo" },
    };

    expect(hasMaterialIssueUpdateFields(details)).toBe(true);
    expect(isLowSignalIssueContentOnlyUpdate("issue.updated", details)).toBe(false);
  });
});
