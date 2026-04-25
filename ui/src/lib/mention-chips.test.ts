// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { applyMentionChipDecoration, stripMentionChipLabelPrefix } from "./mention-chips";

describe("mention chips", () => {
  it("strips the legacy visible at-prefix from mention labels", () => {
    expect(stripMentionChipLabelPrefix("@rudder dev")).toBe("rudder dev");
    expect(stripMentionChipLabelPrefix("rudder dev")).toBe("rudder dev");
  });

  it("normalizes decorated legacy mention link text", () => {
    const element = document.createElement("a");
    element.textContent = "@rudder dev";

    applyMentionChipDecoration(element, {
      kind: "project",
      projectId: "project-123",
      color: "#336699",
    });

    expect(element.textContent).toBe("rudder dev");
    expect(element.dataset.mentionKind).toBe("project");
  });
});
