import { describe, expect, it } from "vitest";
import { extractDocumentOutline } from "./document-outline";

describe("extractDocumentOutline", () => {
  it("extracts markdown headings with hierarchy and stable duplicate ids", () => {
    expect(extractDocumentOutline([
      "# Proposal",
      "",
      "## 1. 摘要",
      "Body",
      "### Next `step`",
      "## 1. 摘要",
    ].join("\n"))).toEqual([
      { id: "proposal", level: 1, title: "Proposal", line: 1, headingIndex: 0, hidden: false },
      { id: "1-摘要", level: 2, title: "1. 摘要", line: 3, headingIndex: 1, hidden: false },
      { id: "next-step", level: 3, title: "Next step", line: 5, headingIndex: 2, hidden: false },
      { id: "1-摘要-2", level: 2, title: "1. 摘要", line: 6, headingIndex: 3, hidden: false },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    expect(extractDocumentOutline([
      "```md",
      "# Not a section",
      "```",
      "## Real section",
    ].join("\n"))).toEqual([
      { id: "real-section", level: 2, title: "Real section", line: 4, headingIndex: 0, hidden: false },
    ]);
  });

  it("can include headings marked as hidden outline sections without losing rendered heading indexes", () => {
    const markdown = [
      "# Visible",
      "<!-- rudder-outline-hidden -->",
      "## Hidden details",
      "## Next visible",
    ].join("\n");

    expect(extractDocumentOutline(markdown)).toEqual([
      { id: "visible", level: 1, title: "Visible", line: 1, headingIndex: 0, hidden: false },
      { id: "next-visible", level: 2, title: "Next visible", line: 4, headingIndex: 2, hidden: false },
    ]);
    expect(extractDocumentOutline(markdown, { includeHidden: true })).toEqual([
      { id: "visible", level: 1, title: "Visible", line: 1, headingIndex: 0, hidden: false },
      { id: "hidden-details", level: 2, title: "Hidden details", line: 3, headingIndex: 1, hidden: true },
      { id: "next-visible", level: 2, title: "Next visible", line: 4, headingIndex: 2, hidden: false },
    ]);
  });
});
